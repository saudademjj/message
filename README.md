# E2EE Chat Space (端到端加密即时通讯系统)

[![Go](https://img.shields.io/badge/Go-1.23-00ADD8?logo=go)](https://go.dev/)
[![React](https://img.shields.io/badge/React-19.0-61DAFB?logo=react)](https://react.dev/)
[![WebSocket](https://img.shields.io/badge/WebSocket-Enabled-brightgreen)](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
[![Cryptography](https://img.shields.io/badge/Security-E2EE-blueviolet)](https://en.wikipedia.org/wiki/End-to-end_encryption)

E2EE Chat Space 是一个专注于隐私保护与实时通信的分布式即时通讯平台。系统采用端到端加密 (E2EE) 协议，确保消息在客户端层面进行加解密，服务器端仅作为消息中转节点，无法获取任何明文内容。本项目集成了高性能的 Go 后端与响应式前端，构建了一个安全、可信的实时对话空间。

## 安全架构

- 端到端加密 (E2EE): 系统核心基于浏览器原生 Web Crypto API 实现。所有消息在发出前利用非对称加密算法加密，仅在接收方的可信任设备上进行解密。
- 多设备管理与身份验证: 系统支持精细化的设备指纹识别与管理，每个独立设备拥有唯一的加密上下文，防止身份冒用。
- 数字签名校验: 每一条传输的消息均附带数字签名，通过摘要比对确保消息在公网传输过程中的完整性与不可抵赖性。
- 零信任服务器设计: 后端服务作为中继枢纽 (Relay)，在架构设计上排除了存储明文消息或解密私钥的任何可能性。

## 主要特性

- 实时通信引擎: 基于 WebSocket 实现双向全双工通信，集成心跳维持与网络波动下的断线重连逻辑。
- 跨端响应式设计: 针对移动端与桌面端进行差异化体验优化，提供流畅的类原生应用交互。
- 容器化部署: 支持 Docker Compose 一键构建，实现服务的一致性交付。

## 技术栈

### 后端架构 (Backend)
- 核心语言: Go 1.23+
- 实时层: Gorilla WebSocket
- 存储层: PostgreSQL (pgx/v5 驱动)
- 迁移层: golang-migrate
- 认证体系: JWT + 自定义数字签名算法

### 前端层 (Frontend)
- 框架: React 19 (Vite 构建)
- 动效: Framer Motion
- 加密库: Web Crypto API (Browser-native)
- UI 系统: Radix UI + Tailwind CSS

## 项目结构

```text
.
├── backend             # Go 后端工程
│   ├── cmd             # 入口函数
│   ├── internal        # 核心业务逻辑实现
│   └── migrations      # 数据库迁移脚本
├── frontend            # React 前端工程
│   ├── src/crypto      # E2EE 核心加解密模块
│   ├── src/context     # 状态治理中心
│   └── src/hooks       # 实时通讯 Hook 抽象
├── docker-compose.yml  # 编排配置
└── deploy-restart.sh   # 自动化部署脚本
```

## 快速启动

### 1. 容器化部署
```bash
cp .env.example .env
docker-compose up -d
```

### 2. 手动开发环境启动
后端:
```bash
cd backend && go run cmd/server/main.go
```
前端:
```bash
cd frontend && npm install && npm run dev
```

## 未来路线
- 引入群组密钥协商机制 (Group Key Agreement) 以支持安全的端到端加密群聊。
- 增加基于 WebRTC 的加密语音与视频通话功能。
- 实现 PWA 支持，提升离线访问能力与推送通知体验。

## 许可证
本项目采用 MIT License 协议。

---
Developed by [saudademjj](https://github.com/saudademjj)
