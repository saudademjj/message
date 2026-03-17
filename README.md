<div align="center">
  <a href="./README_en.md">English</a> | 简体中文
</div>

# E2EE Chat Space (端到端加密即时通讯系统)

![Go](https://img.shields.io/badge/Go-1.23-00ADD8?style=flat-square&logo=go)
![React](https://img.shields.io/badge/React-19.0-61DAFB?style=flat-square&logo=react)
![WebSocket](https://img.shields.io/badge/WebSocket-Enabled-blue?style=flat-square)
![Cryptography](https://img.shields.io/badge/Security-E2EE-blueviolet?style=flat-square)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql)
![Docker](https://img.shields.io/badge/Docker-Enabled-2496ED?style=flat-square&logo=docker)

本项目是一个基于 Go 语言后端与 React 19 前端构建的高安全性即时通讯实验系统。核心设计遵循**零信任 (Zero-Trust)** 架构原则，通过在客户端层级实现**端到端加密 (End-to-End Encryption)**，确保消息的绝对隐私：只有对话双方拥有解密私钥，包括服务器在内的任何第三方均无法感知消息明文。

## 安全工程实现

### 1. 客户端加解密闭环
系统深度调用浏览器原生的 **Web Crypto API** 驱动底层密码学算法。相较于第三方 JavaScript 库，原生 API 提供了更好的性能与更高的侧信道攻击防御能力。
- **身份识别**: 采用 RSA-2048 非对称算法生成设备密钥对。
- **消息对称加密**: 使用 AES-GCM 高级加密标准，确保消息不仅被加密，且具备抗篡改的完整性校验。

### 2. 零知识中继服务器
Go 语言构建的后端服务仅充当数据报文的“中转站”。
- **报文透明转发**: 服务器仅验证报文的设备签名与目标路由，不存储任何解密密钥。
- **签名验证**: 每一条上行消息均包含基于发送方公钥的数字签名，由服务器进行初步过滤，防止非法冒用。

### 3. 多设备加密上下文管理
系统支持一个账户挂载多个独立物理设备。每个设备在初始化时生成独立的加密上下文，通过特定的握手协议实现多端消息的同步加解密。

## 技术栈与关键选型

- **后端层**: Go 1.23。利用轻量级协程 (Goroutines) 维护数千个活跃的 WebSocket 长连接。
- **实时通信**: 基于 Gorilla WebSocket 协议，实现低延迟、双全工的数据交换。
- **前端层**: React 19 + Vite。采用响应式组件化设计，通过自定义 Hooks 封装复杂的加密生命周期。
- **样式系统**: Tailwind CSS + Framer Motion。构建具备“安全感”与交互流畅性的 UI 体验。

## 项目工程结构

```text
message/
├── backend/                # Go 后端工程
│   ├── cmd/                # 程序引导入口
│   ├── internal/           # 核心业务逻辑 (Auth, Server, Hub, Storage)
│   ├── migrations/         # 数据库版本控制脚本
│   └── go.mod              # 依赖清单
├── frontend/               # React 前端工程
│   ├── src/
│   │   ├── crypto/         # Web Crypto API 加密逻辑封装
│   │   ├── context/        # 全局状态与 WS 实例管理
│   │   ├── hooks/          # 封装加解密、签名与收发逻辑
│   │   └── pages/          # 视图层容器
│   └── package.json        # 依赖与脚本
└── docker-compose.yml      # 全栈容器化配置文件
```

## 快速启动

### 1. 使用 Docker Compose 一键构建 (推荐)
```bash
cp .env.example .env
docker-compose up -d --build
```

### 2. 开发者模式手动启动
- **后端**: `cd backend && go run cmd/server/main.go`
- **前端**: `cd frontend && npm install && npm run dev`

## 许可证
本项目采用 MIT License 协议。
