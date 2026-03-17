<div align="center">
  <a href="./README_en.md">English</a> | 简体中文
</div>

# E2EE Chat Space (端到端加密即时通讯系统)

![Go](https://img.shields.io/badge/Go-1.23-00ADD8?style=flat-square&logo=go)
![React](https://img.shields.io/badge/React-19.0-61DAFB?style=flat-square&logo=react)
![WebSocket](https://img.shields.io/badge/WebSocket-Enabled-blue?style=flat-square)
![Cryptography](https://img.shields.io/badge/Security-E2EE-blueviolet?style=flat-square)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql)

本项目是一个专注于隐私安全与实时通信的高级实验性即时通讯系统。核心架构基于**零信任 (Zero-Trust)** 模型，通过客户端原生加密确保消息在整个生命周期内（传输中、静态存储）均处于密文状态。

## 🔐 安全架构深度解析

### 1. 端到端加密流程 (E2EE Workflow)
系统不依赖于任何中心化的加解密服务，所有密码学操作均在用户设备端完成：
- **密钥生成**: 每个独立设备启动时，通过 `crypto.subtle` 生成 RSA-OAEP (2048-bit) 非对称密钥对。
- **初始握手**: 建立会话时，双方交换公钥并利用 RSA 加密传输临时的 AES-256 会话密钥（Session Key）。
- **消息流加密**: 实时对话采用 **AES-GCM** 对称加密。GCM 模式不仅提供机密性，还内置了身份验证标签（Auth Tag），能有效防御重放攻击与报文篡改。

### 2. 零知识中继 (Zero-Knowledge Relay)
Go 后端服务被设计为纯粹的数据平面：
- **报文结构**: 报文由 `Header` (包含签名与目标 ID) 和 `Payload` (加密内容) 组成。
- **服务器职责**: 验证发送方签名 -> 根据目标 ID 路由报文 -> 转发至 WebSocket 管道。
- **隐私保护**: 数据库仅记录“某人向某人发送了报文”，而不具备解析报文内容的技术可能性。

### 3. 多设备一致性模型
系统支持多设备同步。通过一种类似于 Signal 的双棘轮算法（Double Ratchet）简化版逻辑，确保同一账户的不同物理设备能够独立处理各自的加密上下文。

## 🏗️ 技术实现细节

### 后端层 (Go 1.23)
- **并发 Hub 治理**: 利用 `sync.Map` 与 `channels` 构建高性能的消息分发中心，单实例可支撑数万个活跃连接。
- **数据库驱动**: 采用高性能的 `pgx/v5` 驱动，利用其二进制协议加速元数据的读取。

### 前端层 (React 19)
- **Web Crypto 原生驱动**: 弃用所有第三方加密 JS 库，直接调用浏览器硬件加速的 Web Crypto API，规避侧信道泄露风险。
- **状态总线**: 结合 React Context 封装 WebSocket 的重连、心跳与加密状态机逻辑。

## 📂 项目结构规范

```text
message/
├── backend/                # Go 高并发后端
│   ├── internal/
│   │   ├── hub/            # WebSocket 连接池与实时路由引擎
│   │   ├── auth/           # 基于设备公钥指纹的身份认证
│   │   └── storage/        # 针对大规模加密报文优化的存储层
│   └── migrations/         # 包含设备管理索引的 SQL 迁移脚本
├── frontend/               # React 安全前端
│   ├── src/
│   │   ├── crypto/         # 核心加解密库封装 (RSA/AES/SHA)
│   │   ├── store/          # 客户端加密消息的索引与存储
│   │   └── hooks/          # 实时消息流处理的生命周期管理
└── docker-compose.yml      # 包含 PostgreSQL 与后端服务的完整镜像配置
```

## 🚀 部署指南

### 1. 物理环境
- Go >= 1.23
- Node.js >= 20
- PostgreSQL >= 16

### 2. 启动流程
```bash
# 进入后端目录并引导
cd backend && go run cmd/server/main.go

# 进入前端目录并启动
cd frontend && npm install && npm run dev
```

## 🗺️ 未来展望
- [ ] 增加基于 WebRTC 的端到端加密音视频通话。
- [ ] 实现加密附件的分布式分片存储方案。
- [ ] 引入完全的 Forward Secrecy (前向保密) 机制。

## 许可证
本项目遵循 MIT License 协议。
