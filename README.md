<div align="center">
  <a href="./README_en.md">English</a> | 简体中文
</div>

# E2EE Chat -- 端到端加密聊天系统

![Go](https://img.shields.io/badge/Go-1.23-00ADD8?style=flat-square&logo=go)
![React](https://img.shields.io/badge/React-19.0-61DAFB?style=flat-square&logo=react)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql)
![WebSocket](https://img.shields.io/badge/WebSocket-Native-010101?style=flat-square)
![WebCrypto](https://img.shields.io/badge/Web_Crypto-API-blueviolet?style=flat-square)

一个安全、解耦的端到端加密（E2EE）聊天室应用，确保绝对隐私。后端基于 Go 构建，作为零知识中继层不参与任何解密操作；前端基于 React + Web Crypto API 实现客户端加解密；数据库仅存储密文载荷。

## 核心安全架构

### 端到端加密工作流

系统不依赖集中式解密服务，所有密码学操作均在用户设备上完成：

- 密钥生成：每台设备初始化时通过 `crypto.subtle` 生成 RSA-OAEP（2048-bit）非对称密钥对
- 初始握手：建立会话时，双方交换公钥，使用 RSA 安全传输临时 AES-256 会话密钥
- 流式加密：实时对话采用 AES-GCM 对称加密，GCM 模式同时提供机密性保障和认证标签，防御重放攻击与数据包篡改

### 零知识中继

Go 后端被设计为纯数据平面：

- 数据包结构：由 Header（包含签名和目标 ID）和加密 Payload 组成
- 服务端职责：验证发送方签名 -> 根据目标 ID 路由 -> 转发至 WebSocket 管道
- 隐私保证：数据库仅记录元数据（谁发送了什么给谁），服务端在技术上无法解密载荷内容

### 多设备一致性模型

支持多设备同步。采用类似 Signal Double Ratchet 算法的简化逻辑，同一账户下的不同物理设备独立管理各自的加密上下文。

## 技术实现细节

### 后端（Go 1.23）

- 并发 Hub 管理：基于 `sync.Map` 和 `channels` 构建高性能消息分发中心，单实例可支撑数万活跃连接
- 数据库驱动：使用高性能 `pgx/v5` 驱动，利用其二进制协议实现快速元数据检索
- 设备指纹认证：基于设备唯一标识的身份验证机制
- WebSocket 连接池：自动管理连接生命周期、心跳检测与断线重连

### 前端（React 19）

- 原生 Web Crypto：摒弃第三方 JS 加密库，使用硬件加速的 Web Crypto API 以降低侧信道风险
- 状态总线：通过 React Context 封装 WebSocket 重连、心跳和加密状态机
- 客户端索引：本地建立加密消息的索引结构，支持离线消息检索

## 目录结构

```text
message/
├── backend/                # Go 并发后端
│   ├── cmd/
│   │   └── server/         # 服务入口
│   ├── internal/
│   │   ├── hub/            # WebSocket 连接池与路由引擎
│   │   ├── auth/           # 设备指纹认证模块
│   │   └── storage/        # 加密载荷的优化存储
│   └── migrations/         # SQL 脚本（含设备管理索引）
├── frontend/               # React 安全前端
│   ├── src/
│   │   ├── crypto/         # 密码学封装（RSA/AES/SHA）
│   │   ├── store/          # 加密消息的客户端索引
│   │   └── hooks/          # 实时流的生命周期管理
├── docker-compose.yml      # 数据库与后端的完整镜像配置
└── deploy-restart.sh       # 部署重启脚本
```

## 快速开始

### 环境要求

- Go >= 1.23
- Node.js >= 20
- PostgreSQL >= 16

### 使用 Docker Compose（推荐）

```bash
git clone https://github.com/saudademjj/message.git
cd message
cp .env.example .env
docker compose up -d --build
```

### 手动启动

```bash
# 启动后端
cd backend && go run cmd/server/main.go

# 启动前端
cd frontend && npm install && npm run dev
```

## 未来规划

- [ ] 基于 WebRTC 实现 E2EE 语音和视频通话
- [ ] 加密附件的分布式分片存储
- [ ] 完整的前向保密（Forward Secrecy）集成

## 许可证

MIT License
