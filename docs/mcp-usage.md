# MockForge MCP 使用指南

> 本文档面向：希望在 IDE（Cursor / Claude Code / Zed 等）里让 AI 直接访问 MockForge Mock 模块的开发者。
>
> 对应实现：Step-MCP-1（只读工具）。写能力（create/update 模块、run_test 等）在后续 Step 交付。

---

## 1. 背景

MockForge 通过 Model Context Protocol（MCP）对外暴露一组工具，让 IDE 里的 AI 助手能够：

- 列出你在 MockForge 里已经生成的全部 Mock 模块
- 读取某个模块的接口文档（api-doc.md）
- 拿到某个模块的 OpenAPI 3.0.3 规范

MCP 服务与 Web UI **跑在同一个进程**，共享同一份 SQLite 数据库。你在 IDE 通过 MCP 能看到的数据，就是你在 Web UI 能看到的数据。

---

## 2. 准备

### 2.1 启动 MockForge

任选一种：

- **本地开发**：`pnpm dev`
- **Docker 部署**：`docker compose up -d`

启动后服务监听 `http://localhost:3000`（或你部署时指定的地址）。MCP 端点 `/mcp` 自动挂在同一个端口。

### 2.2 生成 API Key

1. 浏览器打开 MockForge Web UI，登录
2. 进入 **Settings → API Keys**
3. 点 **生成 API Key**
4. 弹窗里**立即复制**显示的 key（形如 `mf_xxxxx`）—— 离开弹窗后无法再次查看

> ⚠ API Key 等同账户密码。若泄漏，立即在同一页面点「重新生成」吊销旧 key。

---

## 3. IDE 配置

### 3.1 Cursor

打开 `~/.cursor/mcp.json`（不存在就新建），加入：

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

重启 Cursor。在 AI 对话窗口里问 "列一下我在 MockForge 里有哪些模块"，AI 会自动调用 `list_modules` 工具。

### 3.2 Claude Code

打开项目根目录的 `.mcp.json`（或全局 `~/.claude/settings.json`）：

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

### 3.3 远程部署场景

如果 MockForge 部署在公司服务器：

```json
{
  "mcpServers": {
    "mockforge": {
      "url": "http://mockforge.internal:3000/mcp",
      "headers": { "X-API-Key": "mf_your_api_key_here" }
    }
  }
}
```

团队每个人生成自己的 key，互不影响。

---

## 4. 可用工具（v1）

| 工具 | 参数 | 返回 | 何时用 |
|------|------|------|--------|
| `list_modules` | 无 | 每个模块的 name / status / health / endpoints / mockBaseUrl | 对话开始时先调一次，让 AI 知道有哪些 Mock 可用 |
| `get_api_doc` | `{moduleName}` | 该模块的 api-doc.md | 需要人类可读契约时 |
| `get_openapi` | `{moduleName}` | 该模块的 OpenAPI 3.0.3 JSON | 需要机器可读契约，生成请求类型、做字段 diff |

还有一个 MCP Resource：

| URI | 作用 |
|-----|------|
| `mockforge://guide` | 给 AI 读的使用指南（推荐工作流、工具决策树、边界条件） |

### 4.1 典型对话示例

```
你: 帮我把 order 模块的 OpenAPI 接到当前前端项目

AI: [调 list_modules] → 确认 order 模块健康
    [调 get_openapi] → 拿到规范
    [生成请求类型 + fetch 客户端代码]
    [告诉你代理到 http://localhost:3000/mock/order]
```

---

## 5. 常见问题

### 401 Unauthorized

- 检查 `X-API-Key` 是否正确复制（注意前后空白）
- 检查账户的 API Key 是否已吊销 / 重新生成（旧 key 立即失效）
- 打开 Settings → API Keys 看"上次使用"是否有更新

### 连不上 / ECONNREFUSED

- 确认 MockForge 在跑（`curl http://localhost:3000/api/health` 应返回 `{"success":true,"data":"ok"}`）
- Docker 场景：确认容器端口映射（`docker ps`）

### AI 不用 MCP 工具

- 检查 IDE 的 MCP 状态面板，看 mockforge 是否显示"connected"且列出了工具
- 在第一轮对话里明确引导："请使用 MockForge 的 list_modules 工具"。大部分 MCP 客户端会自动发现 `mockforge://guide` 资源

### 端口冲突

MockForge 的 MCP 和 Web UI 共用一个端口（默认 3000）。想改端口设置环境变量 `PORT=3001`。

---

## 6. 安全考虑

- **API Key = 账户全权限**。v1 不支持只读 key，后续版本会加
- Key 以 HMAC-SHA256 hash 存储，明文只在生成时返回一次
- 服务端 `MCP_API_KEY_SECRET` 丢失后所有 key 都会失效（等同强制吊销）
- 生产部署建议加反向代理 + HTTPS，不要把 `/mcp` 公网裸露

---

## 7. 路线图

| 版本 | 能力 |
|------|------|
| **v1（本 Step）** | 只读：list_modules / get_api_doc / get_openapi + guide Resource |
| v2 | 写工具：create_module_from_spec / update_module / run_test / manage_data；业务侧感知：get_mock_access_log / diff_with_openapi |
| v3 | 交接报告工具 + 可选 stdio transport |

详见 [`ANALYSIS-AI-DEV-WORKFLOW.md`](../ANALYSIS-AI-DEV-WORKFLOW.md)。
