<div align="center">
  <p>End-to-End Encrypted Chat Application / 端到端加密聊天系统</p>
  <p>
    <a href="#english">English</a> •
    <a href="#简体中文">简体中文</a>
  </p>
</div>

---

<h2 id="english">🇬🇧 English</h2>

# E2EE Chat (Go + React + PostgreSQL)

A secure, decoupled End-to-End Encrypted (E2EE) chat room application ensuring absolute privacy:
- **Backend**: Go HTTP API + Native WebSocket (Zero-knowledge: does not decrypt messages).
- **Frontend**: React + Web Crypto API (Client-side encryption/decryption).
- **Database**: PostgreSQL (Only stores encrypted payload ciphertexts).

### 🚀 Quick Start (30 Seconds)

```bash
cp .env.example .env
docker compose up -d --build
```

Access the application at:
- **Frontend**: `http://localhost:8088`
- **Backend Health Check**: `http://localhost:8081/healthz`

> **Note**: E2E encryption using Web Crypto API requires a secure context (HTTPS) for production or testing on remote servers.

### 🛡 Security Model

- **Forward Secrecy**: Implements the core Signal protocol flow (`X3DH + Double Ratchet`), including Signed PreKey verification and offline OPK handshakes.
- **Client-Side Persistence**: Decrypted messages are securely stored in the browser's IndexedDB, encrypted with AES-GCM.
- **Zero-Knowledge Backend**: The server only routes and stores encrypted payloads (`ciphertext` + `wrappedKeys`).
- **Secure Identity**: Generates `X25519` and `Ed25519` keys locally. Private keys are marked as non-extractable `CryptoKey` objects in IndexedDB.
- **Session Security**: Utilizes `httpOnly + SameSite=Strict` cookies with CSRF double-submit token validation. No authentication tokens are stored in `localStorage`.
- **Closed Registration**: Public registration is disabled by default. Administrators must manually provision user accounts.

### ⚙️ Architecture & Deployment

#### Running Modes
- **Docker Compose**: The recommended default. Database and backend connection strings are automatically configured.
- **Host Deployment**: For environments restricted from Docker Hub, compile the Go binary directly and serve the frontend via Caddy or Nginx.

#### API Overview
- `POST /api/login` & `POST /api/logout`: Session management.
- `POST /api/admin/users`: Admin-only route to provision new users.
- `GET /api/rooms/:id/messages`: Fetch historical ciphertext payloads.
- Signal Key Exchange Endpoints: `/api/signal/prekey-bundle` & `/api/signal/safety-number/:userId`.

#### WebSocket Protocol
- Connect via `/ws?room_id=<roomID>` (Cookie authenticated).
- Emits and broadcasts `key_announce` and `ciphertext` payloads dynamically to online peers.

### 📄 License
MIT License.

---

<h2 id="简体中文">🇨🇳 简体中文</h2>

# E2EE Chat (Go + React + PostgreSQL)

一个高度安全的前后端分离端到端加密（E2EE）聊天室。系统采用零信任架构，确保服务器在任何情况下都无法读取用户的聊天明文：
- **后端**: Go HTTP API + 原生 WebSocket（仅负责密文路由，不解密消息）。
- **前端**: React + Web Crypto API（在浏览器客户端完成所有加解密运算）。
- **数据库**: PostgreSQL（仅持久化密文 payload）。

### 🚀 快速上手（30 秒）

```bash
cp .env.example .env
docker compose up -d --build
```

启动后默认访问：
- **前端界面**：`http://localhost:8088`
- **后端健康检查**：`http://localhost:8081/healthz`

> **注意**：由于浏览器安全策略，Web Crypto API 的端到端加密功能要求运行在安全上下文（HTTPS/localhost）下。如需在公网服务器测试，请务必配置 HTTPS 代理。

### 🛡 核心安全模型

- **前向保密与协议升级**：前端消息协议完整复刻了 Signal 的核心流程：`X3DH + Double Ratchet`（包含 Signed PreKey 签名校验、OPK 离线握手与跳号消息密钥缓存）。
- **零信任服务端**：服务端仅接收并存储数据结构上的密文（`ciphertext` + `wrappedKeys`），对明文内容一无所知。
- **本地密钥保险箱**：每个用户在浏览器本地生成 `X25519` 身份密钥与 `Ed25519` 签名密钥，私钥以不可导出的 `CryptoKey` 形式严密保存在 IndexedDB 中。
- **严格的会话管理**：废弃 `localStorage` 存储 Token 的做法，登录会话全面改用 `httpOnly + SameSite=Strict` Cookie，所有写操作接口均启用 CSRF 校验（双提交机制）。
- **封闭式注册**：为了确保内部群组的纯净与安全，`/api/register` 公开注册接口被硬性禁用，必须由系统管理员通过后台开通账号。

### ⚙️ 部署与架构

#### 运行模式
- **Docker Compose**：开箱即用的推荐方式。配置文件会自动组装数据库与后端的连接，无需手动干预。
- **宿主机直装**：若服务器无法拉取 Docker Hub 镜像，可直接编译 Go 服务（已内置 `golang-migrate` 自动建表），并通过 Caddy/Nginx 提供前端静态托管及反向代理。

#### 核心 API 概览
- `POST /api/login` & `POST /api/logout`：用户身份鉴权与会话销毁。
- `POST /api/admin/users`：管理员创建普通用户的专属接口。
- `GET /api/rooms/:id/messages`：拉取加密的聊天历史记录。
- Signal 密钥交换接口：`/api/signal/prekey-bundle` 与 `/api/signal/safety-number/:userId`。

#### WebSocket 通讯协议
- 通过 `/ws?room_id=<roomID>` 建立连接（由 Cookie 隐式鉴权，握手阶段内置 IP 限流）。
- 实时广播上下行的 `key_announce`（公钥宣发）与 `ciphertext`（密文消息）。

### 📄 许可证
本项目使用 MIT License 协议开源。