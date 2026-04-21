# MockForge MCP 使用指南

> 面向开发者：想让 IDE（Cursor / Claude Code / Zed）里的 AI 助手通过 MCP 协议直接操作 MockForge，自动化从需求到 Mock 到测试到交接的整条流水线。

---

## 1. 背景

MockForge 通过 Model Context Protocol（MCP）对外暴露**12 个工具 + 1 个使用指南资源**，让 IDE 里的 AI 助手能够：

- **读**：列模块、拿 API 文档 / OpenAPI、查 Mock 访问日志、诊断模块健康度
- **写**：从规格生成模块、修改模块、跑测试、造数据、删模块
- **诊断**：把实际请求与 OpenAPI 对比（diff）
- **交接**：为后端团队生成 Markdown 交接报告

MCP 服务与 Web UI **跑在同一进程**，共享同一份 SQLite。IDE AI 开的会话 **Web UI 能看见并接管**。

---

## 2. 准备

### 2.1 启动 MockForge

- **本地开发**：`pnpm dev`
- **Docker 部署**：`docker compose up -d`

服务监听 `http://localhost:3000`，MCP 端点为 `POST /mcp`。

### 2.2 生成 API Key

1. 登录 Web UI → **Settings → API Keys**
2. 点 **生成 API Key**，在弹窗里立即复制（形如 `mf_xxxxx`）
3. 关闭弹窗后无法再次查看；丢失请重新生成（旧 Key 立即失效）

> ⚠ API Key 等同账户密码。生产部署建议加反向代理 + HTTPS。

---

## 3. IDE 配置

### Cursor / Claude Code

在 `~/.cursor/mcp.json` 或项目 `.mcp.json`：

```json
{
  "mcpServers": {
    "mockforge": {
      "url": "http://localhost:3000/mcp",
      "headers": {
        "X-API-Key": "mf_your_api_key_here"
      }
    }
  }
}
```

重启 IDE。AI 会自动读取 `mockforge://guide` 资源，知道怎么用这 12 个工具。

### 远程部署

把 URL 换成你的服务器地址。每个团队成员生成自己的 Key，互不影响。

---

## 4. 工具全集（v2）

### 读（6 个）

| 工具 | 用途 |
|------|------|
| `list_modules` | 列出当前用户的全部模块（name / status / health / endpoints / mockBaseUrl） |
| `get_api_doc` | 读 `api-doc.md`（人类可读） |
| `get_openapi` | 读 OpenAPI 3.0.3 JSON（机器可读） |
| `get_mock_access_log` | 查最近 N 次 `/mock/*` 的真实请求 + 响应 |
| `get_module_health` | 诊断模块健康（5 文件 + _meta + SQLite 表） |
| `diff_with_openapi` | 对比实际请求/响应 vs 契约，输出结构化 diff |

### 写（3 个轻量，即时生效）

| 工具 | 用途 |
|------|------|
| `manage_data` | insert / update / delete / batch_delete / clear / list / bulk_generate |
| `run_test` | 跑模块 `test.ts` 的全 CRUD 回归 |
| `delete_module` | **不可逆**删除模块 |

### 写（2 个重量，触发 AI 生成 ~30s-3min）

| 工具 | 用途 |
|------|------|
| `create_module_from_spec` | 从 OpenAPI / YAML / 自然语言创建模块。支持 `dry_run` 预览 |
| `update_module` | 用自然语言指令修改模块。支持 `dry_run` 预览 |

### 汇报（1 个）

| 工具 | 用途 |
|------|------|
| `generate_handoff_report` | 生成交接 Markdown（契约 + 健康 + 访问日志 + 后端建议） |

### Resource

| URI | 用途 |
|-----|------|
| `mockforge://guide` | 给 AI 读的详细使用指南 + 决策树 |

---

## 5. 典型完整工作流

这是你最初设想的那条闭环，现在通过 MCP 全自动：

```
① 收到 PRD / 接口文档

② AI 在 IDE 里：
   → mockforge.create_module_from_spec({ spec })
   ← 拿到 mockBaseUrl（如 http://localhost:3000/mock/order）

③ AI 在业务代码里配代理，把 /api/order 打到 mockBaseUrl

④ AI 写业务代码
   → mockforge.get_openapi({ moduleName: 'order' })
   ← 生成 TypeScript 类型 + 请求客户端

⑤ AI 写业务测试，跑测试

⑥ 测试失败？AI 自动诊断：
   → mockforge.get_mock_access_log({ moduleName })
   ← 看业务代码真的发了什么、Mock 真的返回了什么
   → mockforge.diff_with_openapi({ moduleName, actualRequest, actualResponse })
   ← 得到 diff 列表

⑦ 根据 diff 分类处理：
   - missing-in-actual → 业务字段没传 → 改业务代码
   - missing-in-spec → 契约漏字段 → mockforge.update_module({ instruction })
   - type-mismatch → 看谁对改谁
   - status-mismatch → 改 Mock 或业务

⑧ mockforge.run_test({ moduleName })  ← 验证改动

⑨ 回 ④ 直到全绿

⑩ mockforge.generate_handoff_report({ moduleName })
   ← 把 Markdown 给后端团队
```

---

## 6. 长任务的进度反馈

`create_module_from_spec` 和 `update_module` 背后要跑 LLM，可能要 30 秒到 3 分钟。MCP 协议的 `progress notifications` 在执行期间推送 4 种阶段摘要：

- `thinking: {chars: N}` — AI 在思考（不泄漏内容）
- `writing: {chars: N}` — AI 在写文本
- `tool: {tool: 'write_file' | ...}` — AI 在调内部工具
- `module_update: {moduleName, status}` — 模块状态变化

Cursor / Claude Code 会把这些显示成"进行中"提示，不阻塞你做别的事。

---

## 7. 成本控制（软 warnings）

短期（24h）内对同一模块调 `update_module` 超过 10 次，返回会带：

```json
{
  "structuredContent": { ... },
  "warnings": [
    {
      "code": "HIGH_RETRY_COUNT",
      "message": "This module has been modified N times in the last 24h..."
    }
  ]
}
```

**不阻断**，只提示 AI 可能陷入错误循环。计数器进程重启清零（可接受）。

---

## 8. dry_run 预览

`create_module_from_spec` 和 `update_module` 都支持 `dry_run: true`：

```json
// create dry_run
{
  "structuredContent": {
    "moduleName": "order",
    "status": "would-create",
    "plan": {
      "kind": "openapi-derived",
      "entities": [{ "name": "order", "fields": ["orderNo","amount"] }],
      "endpoints": ["GET /orders", "POST /orders"]
    }
  }
}

// update dry_run
{
  "structuredContent": {
    "moduleName": "order",
    "status": "would-update",
    "instruction": "加一个 createdBy 字段",
    "currentEndpoints": ["GET /orders", ...]
  }
}
```

AI 可先预览，和用户确认后再不带 `dry_run` 正式跑。

---

## 9. 交接报告示例

`generate_handoff_report({ moduleName: 'order' })` 返回的 Markdown 大致结构：

```markdown
# 订单管理 Mock 交接报告

> 用户: 1 · 模块: order · 生成时间: 2026-04-21T...

## 契约概要
- Base Path: /mock/order
- 状态: active
- 端点清单
  - GET /mock/order/
  - POST /mock/order/
  - ...

### 实体与字段
**order**:
| 字段 | 类型 | 必填 |
|------|------|------|
| order_no | string | 是 |
| amount | number | 是 |
| ...

## 模块健康状态
- health: healthy
- 表: mock__order — 存在

## 访问日志摘要（最近 50 次）
共 127 条请求，状态码分布：`200×121, 400×4, 500×2`

| 端点 | 次数 | 平均耗时 (ms) |
| GET /mock/order/ | 78 | 12.3 |
| ...

### 错误请求（4xx/5xx）
...

## 后端交接建议
- 实现上述端点，响应结构遵循 { success, message, data } 信封...
- 列表端点按 { list, total, page, pageSize } 结构返回...
- 所有实体默认带 id / created_at / updated_at 三个字段
- ⚠ 注意：业务代码在测试期间产生了 4xx/5xx 请求，请核对...
```

直接粘给后端，对方就知道要实现什么、哪里有坑。

---

## 10. 常见问题

### 401 Unauthorized
- API Key 有没有带前后空白
- Key 是否已被吊销 / 重新生成（旧 Key 立即失效）
- Settings 页"上次使用"字段应该有更新

### 连不上 / ECONNREFUSED
- `curl http://localhost:3000/api/health` 应返回 `{"success":true,"data":"ok"}`
- Docker：确认容器端口映射（`docker ps`）

### AI 没调工具
- IDE 的 MCP 状态面板确认 mockforge 是 connected
- 在第一轮对话里明确引导："请先调 mockforge.list_modules 看看我有哪些模块"
- AI 应该已经通过 `mockforge://guide` 资源知道怎么用了

### create/update 花了 5 分钟还没回
- 正常。gemma/claude 在复杂模块上 2-5 分钟是常态
- 在 Web UI 的 Sessions 页能看到这条 `[MCP] create xxx` 会话的实时进度
- 想中断？Web UI 里点"暂停"即可

### Mock 返回 404 但模块我明明建了
- 跑 `get_module_health`，可能模块是 degraded（文件不全 / 表丢）
- 或者 moduleName 大小写错了（是区分大小写的）
- 尝试 `run_test` 看错在哪

---

## 11. 安全考虑

- **API Key = 账户全权限**，泄漏后他人可以 create/update/delete 你的任意模块
- Key 以 HMAC-SHA256 hash 存储；若服务器端 `MCP_API_KEY_SECRET` 丢失，所有 Key 会失效（等同强制吊销）
- `generate_handoff_report` 包含访问日志的完整请求/响应（已截断 8KB），**若日志里可能有 PII 数据，交出报告前自行检查**
- 生产部署建议加反向代理 + HTTPS，不要把 `/mcp` 公网裸露

---

## 12. 路线图

| 版本 | 状态 | 能力 |
|------|------|------|
| Step-MCP-1 | ✅ | 只读工具 + API Key + guide |
| Step-MCP-2 | ✅（当前） | 写工具 + 业务侧感知 + 交接报告 + progress notifications + 软 warnings + dry_run |
| 未来 | — | 细粒度 Key 权限（read-only / write）、stdio transport（如有需求再做） |

更详细的设计和决策记录见 [`ANALYSIS-AI-DEV-WORKFLOW.md`](../ANALYSIS-AI-DEV-WORKFLOW.md) 和 `CURSOR.md` 的 Step-MCP-2 章节。
