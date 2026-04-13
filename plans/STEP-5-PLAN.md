# Step 5: 认证 + 数据库 Seed — 聚焦子计划

## 目标
实现 JWT 认证中间件、API Key 加密工具、注册/登录 API，启动时自动创建管理员和测试 Provider。

## Task 清单

### Task 1: encryption.ts — AES 加密
**文件**: src/server/core/encryption.ts
- `encrypt(text)` / `decrypt(ciphertext)` — AES-256-CBC
- 使用 .env ENCRYPTION_KEY（32 字符）

### Task 2: auth.ts — JWT 认证中间件
**文件**: src/server/core/auth.ts
- `signToken(payload)` — 使用 jose 签发 JWT，exp 从 .env JWT_EXPIRES_IN
- `verifyToken(token)` — 验证 JWT
- `authMiddleware` — Fastify preHandler：从 Authorization header 提取 Bearer token，验证，查 user.is_active，设置 request.user

### Task 3: api/auth.ts — 注册/登录 API
**文件**: src/server/api/auth.ts
- POST /api/auth/register — username(3-20字符), password(6+字符)，bcryptjs hash，返回 201
- POST /api/auth/login — 验证密码，返回 JWT + 用户信息
- 注册受 .env ALLOW_REGISTRATION 控制

### Task 4: 数据库 seed
**位置**: server.ts 启动流程
- 从 .env 读取 ADMIN_USERNAME/ADMIN_PASSWORD
- 如果 admin 不存在则创建
- 创建测试 Provider（id=1）

### Task 5: 验证
**验收**:
- 注册 → 201
- 登录 → 返回 JWT
- JWT 访问受保护端点 → 200
- 无 JWT → 401
- providers 表有测试记录
