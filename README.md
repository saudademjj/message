# E2EE Chat Space (端到端加密即时通讯系统)

[![Go](https://img.shields.io/badge/Go-1.23-00ADD8?logo=go)](https://go.dev/)
[![React](https://img.shields.io/badge/React-19.0-61DAFB?logo=react)](https://react.dev/)
[![WebSocket](https://img.shields.io/badge/WebSocket-Enabled-brightgreen)](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)
[![Cryptography](https://img.shields.io/badge/Security-E2EE-blueviolet)](https://en.wikipedia.org/wiki/End-to-end_encryption)

本项目是一个基于 Go 和 React 实现的即时通讯实验项目。其主要目的是探索端到端加密 (E2EE) 在 Web 通信中的应用。消息在发出前利用 Web Crypto API 在客户端进行加密，服务器端仅作为消息中继节点，不涉及明文数据的处理。

## 技术实现

- 端到端加密: 系统利用 Web Crypto API 进行加解密。消息在发送端进行非对称加密，由接收端持有对应私钥解密。
- 身份验证与签名: 支持多设备管理，并结合数字签名校验消息的完整性。
- 零知识转发: 服务器逻辑设计为仅中继加密载荷，确保明文数据不在服务端存储或流转。
- 实时层: 基于 WebSocket 提供消息投递服务，支持心跳维持。

## 技术栈

### 后端架构
- 语言: Go 1.23
- 库: Gorilla WebSocket, pgx (PostgreSQL), JWT-Go
- 其他: Docker 容器化支持

### 前端架构
- 框架: React 19 (Vite)
- 样式: Tailwind CSS, Framer Motion
- 安全: Browser-native Web Crypto API

## 项目结构

```text
.
├── backend             # Go 后端实现
│   ├── cmd             # 应用入口
│   ├── internal        # 服务端逻辑
│   └── migrations      # 数据库迁移
├── frontend            # React 前端实现
│   ├── src/crypto      # E2EE 逻辑模块
│   └── src/hooks       # 状态与通讯封装
└── docker-compose.yml  # 本地启动配置
```

## 快速启动

### 1. 使用 Docker
```bash
cp .env.example .env
docker-compose up -d
```

### 2. 本地开发运行
后端: `go run cmd/server/main.go`
前端: `npm install && npm run dev`

## 许可证
MIT License
