# E2EE Chat Space (端到端加密即时通讯系统)

本项目是一个基于 Go 和 React 19 构建的高安全性即时通讯实验系统。核心设计目标是实现端到端加密 (E2EE)，确保消息在客户端层进行加解密，服务器仅作为中继节点，不涉及明文数据的处理与存储。

This project is a high-security instant messaging experimental system built with Go and React 19. The core design goal is to implement End-to-End Encryption (E2EE), ensuring that messages are encrypted and decrypted at the client layer, with the server acting solely as a relay node without processing or storing plaintext data.

## 核心特性 / Core Features

- 端到端加密 (E2EE / End-to-End Encryption):
    - 采用浏览器原生 Web Crypto API 实现。 / Implemented using browser-native Web Crypto API.
    - 消息在发出前利用接收方的公钥加密，仅接收方私钥可解密。 / Messages encrypted with recipient's public key before sending.

- 设备指纹与管理 (Device Fingerprinting & Management):
    - 支持多设备登录，每个设备拥有独立的加密上下文。 / Supports multi-device login with independent encryption contexts.
    - 提供精细化的设备列表管理与身份验证机制。 / Granular device list management and authentication mechanisms.

- 消息完整性校验 (Message Integrity & Non-repudiation):
    - 所有消息传输均附带数字签名，防止中间人篡改。 / All message transmissions include digital signatures to prevent MITM tampering.
    - 结合时间戳与随机盐值防止重放攻击。 / Replay attack prevention using timestamps and salts.

- 实时双全工通信 (Full-duplex Real-time Communication):
    - 基于 WebSocket 协议实现低延迟消息投递。 / Low-latency message delivery based on the WebSocket protocol.
    - 集成心跳包检测与自动重连算法。 / Integrated heartbeat detection and auto-reconnect algorithms.

## 技术栈 / Technical Stack

### 后端层 / Backend Layer
- Go 1.23: 核心并发模型与高性能逻辑处理。 / Core concurrency model and high-performance processing.
- Gorilla WebSocket: 标准化的 WebSocket 服务端实现。 / Standardized WebSocket server implementation.
- PostgreSQL: 存储设备信息、用户信息与加密后的消息载荷。 / Stores device, user info, and encrypted payloads.
- golang-jwt: 实现基础的基于 Token 的身份验证。 / Base token-based authentication.

### 前端层 / Frontend Layer
- React 19: 采用现代组件化架构与 Hook 治理。 / Modern component-based architecture and hooks.
- Web Crypto API: 提供底层 RSA/AES 算法支持。 / Low-level RSA/AES algorithm support.
- Framer Motion: 提供流畅的界面转场与交互动效。 / Fluid interface transitions and interactive animations.
- Tailwind CSS: 响应式 UI 布局构建。 / Responsive UI layout construction.

## 项目结构 / Project Structure

```text
message/
├── backend/                # Go 后端工程实现 / Go backend implementation
│   ├── cmd/                # 程序入口目录 / Application entry points
│   │   └── server/         # 主服务入口 / Main server entry
│   ├── internal/           # 内部业务逻辑封装 / Internal business logic
│   │   ├── server/         # HTTP & WebSocket 服务治理 / HTTP & WS service management
│   │   ├── auth/           # 认证与设备管理逻辑 / Auth and device management
│   │   └── storage/        # 数据库持久层接口 / DB persistence interfaces
│   ├── migrations/         # SQL 模式迁移脚本 / SQL schema migration scripts
│   └── go.mod              # Go 依赖清单 / Go dependency manifest
├── frontend/               # React 前端工程实现 / React frontend implementation
│   ├── src/
│   │   ├── crypto/         # E2EE 核心加解密库封装 / E2EE core crypto wrappers
│   │   ├── context/        # 状态总线与加密上下文管理 / State bus and crypto context
│   │   ├── hooks/          # 通讯钩子 (WS 连接、消息收发) / Communication hooks (WS, messaging)
│   │   └── components/     # UI 组件库 / UI component library
│   ├── package.json        # 前端依赖清单 / Frontend dependencies
│   └── vite.config.ts      # Vite 编译配置 / Vite build configuration
├── docker-compose.yml      # 全栈部署编排配置 / Full-stack deployment orchestration
└── deploy-restart.sh       # 自动化重部署脚本 / Automated redeployment script
```

## 快速启动 / Quick Start

### 1. 容器化一键部署 / One-click Deployment via Docker
```bash
cp .env.example .env
docker-compose up -d --build
```

### 2. 开发者模式 / Developer Mode
后端 / Backend:
```bash
cd backend && go run cmd/server/main.go
```
前端 / Frontend:
```bash
cd frontend && npm install && npm run dev
```

## 未来计划 / Roadmap

- [ ] 实现群聊多方密钥协商 (MPK - Multi-party Key Agreement)
- [ ] 增加消息阅后即焚功能 (Self-destructing Messages)
- [ ] 接入 WebRTC 实现端到端加密的音视频通话 (E2EE Voice/Video Calls)

## 许可证 / License
本项目采用 [MIT License](LICENSE) 协议。 / This project is licensed under the MIT License.
