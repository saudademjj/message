# E2EE Chat (Go + React + PostgreSQL)

一个前后端分离的端到端加密聊天室：
- 后端: Go HTTP API + 原生 WebSocket（不解密消息）
- 前端: React + Web Crypto API（在浏览器端加解密）
- 数据库: PostgreSQL（仅保存密文 payload）

## 目录结构

- `backend/cmd/server/main.go`: Go 服务入口
- `backend/internal/server/*`: Go 服务内部实现（HTTP、WebSocket、鉴权、存储）
- `frontend/`: React 客户端
- `docker-compose.yml`: 一键启动

## 安全模型

- 已解密明文会在浏览器本地加密数据库（IndexedDB + AES-GCM）中持久化，避免双棘轮前向保密导致历史明文不可恢复。
- 服务端仅接收并存储密文数据结构（`ciphertext` + `wrappedKeys` 等）。
- 每个用户在浏览器本地生成 Signal 风格身份材料：`X25519` 身份密钥（IK）、`Ed25519` 签名密钥、Signed PreKey（SPK）与 One-Time PreKeys（OPK），私钥以不可导出的 `CryptoKey` 形式保存到 IndexedDB。
- 已移除旧版 `localStorage` 身份迁移兼容逻辑，防止读取历史明文私钥副本。
- 登录会话改为 `httpOnly + SameSite=Strict` Cookie，前端不再把鉴权会话写入 `localStorage`。
- 写操作接口启用 CSRF 校验（`X-CSRF-Token` 对应 Cookie 双提交）。
- 当前部署关闭公开注册：`/api/register` 被禁用。
- 管理员可通过 `POST /api/admin/users` 创建普通用户，普通用户可登录。
- 服务启动时会自动创建并加固初始管理员房间（默认 `admin-secure`），并强制只有管理员成员。
- 前端消息协议升级为 Signal 核心流程：`X3DH + Double Ratchet`（含 Signed PreKey 签名校验、OPK 离线握手、跳号消息密钥缓存）。
- 服务端提供 PreKey Bundle 交换与 Safety Number 快照接口，用于对端身份校验与密钥变更可视化。
- 发送消息时：
  - 浏览器随机生成 AES-GCM 消息密钥
  - 明文用 AES-GCM 加密
  - 首条消息使用 X3DH（IK/SPK/OPK）建立会话，后续用 Double Ratchet 封装消息密钥

## 快速启动

1. 复制环境变量

```bash
cp .env.example .env
```

请在 `.env` 中至少设置以下变量：
- `APP_ENV`：运行环境，`development` 或 `production`（建议生产环境显式设置为 `production` 以启用更严格安全校验）
- `DATABASE_URL`：PostgreSQL 连接串（生产环境必须使用 TLS，`sslmode=require|verify-ca|verify-full`）
- `JWT_SECRET`：JWT 密钥，至少 32 字符，禁止弱值
- `CORS_ORIGIN`：明确前端 Origin（生产环境禁止 `*`）
- `ADMIN_USERNAME`：管理员用户名（默认 `admin`）
- `ADMIN_PASSWORD_HASH`：管理员密码的 bcrypt 哈希（必填）
- `ADMIN_ROOM_NAME`：初始管理员房间名（默认 `admin-secure`）
- `TRUST_PROXY_HEADERS`：是否信任反向代理来源头（`true/false`，默认 `false`）
- `LOGIN_RATE_LIMIT_IP_PER_MINUTE`：登录接口每 IP 每分钟限流（默认 `30`）
- `LOGIN_RATE_LIMIT_IP_BURST`：登录接口每 IP 突发桶容量（默认 `10`）
- `LOGIN_RATE_LIMIT_USER_PER_MINUTE`：登录接口每用户名每分钟限流（默认 `12`）
- `LOGIN_RATE_LIMIT_USER_BURST`：登录接口每用户名突发桶容量（默认 `6`）
- `WS_RATE_LIMIT_IP_PER_MINUTE`：WebSocket 握手每 IP 每分钟限流（默认 `60`）
- `WS_RATE_LIMIT_IP_BURST`：WebSocket 握手每 IP 突发桶容量（默认 `20`）
- `GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS`：优雅停机超时秒数（默认 `20`）
- `VITE_IDENTITY_ROTATE_MINUTES`：端侧密钥轮换周期（分钟，默认 `240`）
- `VITE_IDENTITY_KEY_HISTORY`：本地保留的历史私钥数量（默认 `6`）
- `VITE_API_TIMEOUT_MS`：前端 API 请求超时时间（毫秒，默认 `12000`）

2. 启动

```bash
docker compose up -d --build
```

3. 访问

- 前端: `http://<服务器IP>:8088`
- 后端健康检查: `http://<服务器IP>:8081/healthz`

注意：Web Crypto 端到端加密需要 HTTPS 安全上下文。生产/实测请使用 HTTPS 入口（例如 `https://<服务器IP>:8443`），否则浏览器会拒绝生成密钥对。

## 宿主机部署（Docker Hub 受限时）

如果服务器无法拉取 Docker Hub 镜像，可走宿主机部署：

1. 安装依赖：Go、Node.js、PostgreSQL（本项目已在 Debian 12 + Go 1.23 + Node 22 验证）。
2. 后端：
   - 在 `backend/` 执行 `go mod tidy && go build ./cmd/server`
   - 启动时自动执行版本化 schema migration（`golang-migrate` + embedded SQL）
   - 使用 systemd 服务 `e2ee-chat-backend.service` 启动二进制
3. 前端：
   - 在 `frontend/` 执行 `npm install && npm run build`
   - 使用仓库内 `frontend/Caddyfile` 对外提供 HTTPS 入口（默认 `https://<服务器IP>:8443`），并反向代理 `/api/*`、`/ws` 到后端 `8081`
4. 可使用仓库根目录脚本一键重启：
   - `./deploy-restart.sh`（会同时重启后端与 Caddy 前端代理，并做健康检查）

## API 概览

- `POST /api/register` 固定返回 `403`（已禁用注册）
- `POST /api/login` 用户/管理员登录并设置会话 Cookie（内置 IP + 用户名限流）
- `GET /api/session` 读取当前会话用户
- `POST /api/logout` 清理会话 Cookie
- `GET /api/admin/users` 管理员查看用户列表
- `POST /api/admin/users` 管理员创建普通用户
- `GET /api/rooms` 获取已加入房间
- `POST /api/rooms` 创建/加入房间
- `POST /api/rooms/:id/join` 加入房间
- `GET /api/rooms/:id/messages` 拉取密文历史
- `GET /api/rooms/:id/members` 拉取房间成员（用于会话预建立）
- `PUT /api/signal/prekey-bundle` 上传本端 Signal PreKey Bundle
- `GET /api/signal/prekey-bundle/:userId` 拉取对端 Bundle（会消耗一个 OPK）
- `GET /api/signal/safety-number/:userId` 拉取双方 Safety Number 快照

## WebSocket 协议（简化）

连接：`/ws?room_id=<roomID>`（鉴权由 Cookie 会话完成，握手阶段内置 IP 限流）

上行：
- `{"type":"key_announce","publicKeyJwk":...}`
- `{"type":"ciphertext", ...cipherPayload }`

下行：
- `room_peers`: 当前房间已上报公钥的在线成员
- `peer_key`: 某成员公钥更新/上线
- `peer_left`: 某成员离线
- `ciphertext`: 密文消息广播

## 生产建议

- 把 `JWT_SECRET`、`POSTGRES_PASSWORD` 改为高强度随机值。
- 生产环境 `DATABASE_URL` 必须启用 TLS（`sslmode=require|verify-ca|verify-full`）。
- 生产环境 `CORS_ORIGIN` 必须为明确域名 Origin，不应使用 `*`。
- 若部署在反向代理后，请按实际拓扑配置 `TRUST_PROXY_HEADERS=true`，否则保持默认 `false`。
- 使用高强度管理员密码，并只在 `.env` 中放 bcrypt 哈希，避免保存明文密码。
- 将前后端挂到 HTTPS 域名下（WSS）。
- 若需要更强保护，可再叠加“本地口令派生密钥”对 IndexedDB 中数据做二次加密。
- 继续完善消息签名、设备管理、密钥轮换与审计。

## CI

仓库内置 GitHub Actions 工作流：`.github/workflows/ci.yml`，会在 `push/pull_request` 时自动执行：
- 后端 `go test ./...`
- 前端 `npm run lint && npm test && npm run build`

## License

本项目使用 MIT License，见 `LICENSE`。

## 如何添加用户

使用管理员账号登录后，在前端侧栏的“管理员：创建用户”面板创建用户；  
或直接调用后端：

```bash
# 1) 登录并保存 Cookie
curl -c cookies.txt -X POST https://<服务器IP>:8443/api/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"<your-password>"}'

# 2) 从 Cookie 读取 CSRF 并创建用户
CSRF_TOKEN=$(awk '$6=="e2ee-chat.csrf"{print $7}' cookies.txt)
curl -b cookies.txt -X POST https://<服务器IP>:8443/api/admin/users \
  -H "X-CSRF-Token: ${CSRF_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"username":"newuser","password":"StrongPassword123!"}'
```
