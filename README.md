<div align="center">
  <a href="./README.md">简体中文</a> | <a href="./README_en.md">English</a>
</div>

# E2EE Chat Space (端到端加密即时通讯系统)

![Go](https://img.shields.io/badge/Go-1.23-00ADD8?style=flat-square&logo=go)
![React](https://img.shields.io/badge/React-19.0-61DAFB?style=flat-square&logo=react)
![WebSocket](https://img.shields.io/badge/WebSocket-Enabled-blue?style=flat-square)
![Cryptography](https://img.shields.io/badge/Security-E2EE-blueviolet?style=flat-square)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql)
![Docker](https://img.shields.io/badge/Docker-Enabled-2496ED?style=flat-square&logo=docker)

E2EE Chat Space 是一个基于 Go 语言和 React 19 开发的安全即时通讯实验系统。项目的核心工程目标是实现**端到端加密 (End-to-End Encryption)**，即通过非对称加密算法确保消息在发出前已在客户端完成加密，且私钥始终由客户端持有。服务器在此过程中仅承担消息中转（Relay）职能，无法感知消息的具体内容。

E2EE Chat Space is a secure instant messaging experimental system developed with Go and React 19. The core engineering goal is to implement End-to-End Encryption (E2EE), ensuring that messages are encrypted at the client-side using asymmetric algorithms before transmission, with private keys always staying on the client. The server acts solely as a relay node, possessing no knowledge of the message content.

## 安全工程实践 / Security Engineering Practices

### 1. 客户端加解密逻辑 (Client-side Cryptography)
- **Web Crypto API**: 利用浏览器原生的 Web Crypto API 驱动 RSA 与 AES 算法，避免第三方 JS 库带来的侧信约风险。 / Native browser crypto for RSA/AES to minimize side-channel risks.
- **非对称与对称结合**: 采用 RSA 进行身份识别与初始密钥协商，通过 AES-GCM 进行大批量消息的流式加解密。 / RSA for identity and key agreement; AES-GCM for bulk message streaming.

### 2. 零信任服务器架构 (Zero-trust Server Architecture)
- **中继模式**: Go 后端仅负责维护 WebSocket 的长连接状态与加密报文的转发。 / Go backend solely maintains WS connections and forwards encrypted payloads.
- **签名校验**: 所有上行报文均包含设备级的数字签名，服务器通过存储的公钥进行完整性校验，确保报文未经篡改。 / Device-level digital signatures for message integrity verification.

### 3. 设备与身份生命周期 (Device & Identity Lifecycle)
- **多设备支持**: 每个账户支持挂载多个物理设备，系统为每个设备维护独立的加密上下文。 / Independent encryption contexts per physical device.
- **密钥旋转**: 逻辑设计预留了密钥旋转接口，以应对长周期的安全需求。 / Architectural provision for long-term key rotation.

## 技术架构 / Technical Stack Analysis

### 后端 / Backend (Golang)
- **高并发实时层**: 利用 Goroutines 处理数千个 WebSocket 节点的并发连接。 / High-concurrency WS handling via Goroutines.
- **存储与持久化**: 使用 pgx 驱动连接 PostgreSQL，存储设备公钥元数据、群组关系及离线加密消息。 / PostgreSQL for metadata and offline encrypted payloads.
- **鉴权**: JWT 集成数字签名双重验证。 / JWT with additional digital signature validation.

### 前端 / Frontend (React 19)
- **响应式状态管理**: React Context 结合自定义 Hook 维护加密状态。 / React Context & hooks for crypto state management.
- **UI 框架**: Tailwind CSS 配合 Framer Motion 提供具备安全感且交互流畅的视觉体验。 / Tailwind CSS & Framer Motion for secure and fluid UI.

## 项目结构解析 / Project Structure

```text
.
├── backend/                # Go 后端工程 / Go Backend
│   ├── cmd/                # 入口函数，包含配置加载逻辑 / Entry points and config loading
│   ├── internal/           # 核心业务逻辑实现 / Core business logic
│   │   ├── auth/           # 认证中间件与签名校验逻辑 / Auth & Sig-verification
│   │   ├── server/         # WebSocket Hub 与 HTTP 路由治理 / WS Hub & Routing
│   │   └── storage/        # 持久化存储接口封装 / Persistence interfaces
│   ├── migrations/         # 结构化 SQL 迁移脚本 / SQL schema migrations
│   └── go.mod              # 模块依赖清单 / Dependency manifest
├── frontend/               # React 前端工程 / React Frontend
│   ├── src/
│   │   ├── crypto/         # 加密逻辑的核心抽象与封装 / Core crypto abstractions
│   │   ├── context/        # 全局加密上下文与 WS 连接管理 / Crypto context & WS management
│   │   ├── hooks/          # 通讯生命周期钩子 / Communication life-cycle hooks
│   │   └── pages/          # 视图层容器 / View containers
│   └── package.json        # 依赖清单 / Dependency list
└── docker-compose.yml      # 全栈容器化编排 / Full-stack orchestration
```

## 快速启动 / Quick Start

### 1. 基础环境 / Environment
- Go 1.23+
- Node.js 20+
- PostgreSQL 16

### 2. 一键构建 / Build & Run
```bash
# 复制并配置环境变量 / Config environment
cp .env.example .env

# 使用 Docker Compose 启动全量服务 / Launch via Docker
docker-compose up -d --build
```

## 未来路线图 / Roadmap
- [ ] 完善 Forward Secrecy (前向保密) 机制。
- [ ] 增加基于群组密钥协商的加密群聊功能。
- [ ] 实现加密附件的分布式存储与分发。

## 许可证 / License
本项目采用 MIT License 协议。 / Licensed under the MIT License.
