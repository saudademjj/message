# E2EE Chat

[English](README_en.md) | 简体中文

`E2EE Chat` 是一个前后端分离的端到端加密聊天室：

- 后端：`Go HTTP API` + 原生 `WebSocket`
- 前端：`React` + `Web Crypto API`
- 数据库：`PostgreSQL`，仅保存密文负载

项目目标不是“把聊天功能做出来”而已，而是在浏览器端尽量完整地落实端到端加密、会话保护和基本运维安全约束。

## 核心能力

- 房间制聊天与实时消息推送
- 浏览器端生成与保存身份密钥材料
- `X3DH + Double Ratchet` 风格消息协商与轮换
- 服务器只存储密文 payload，不解密消息内容
- `httpOnly` Cookie 会话 + CSRF 防护
- 登录与 WebSocket 握手限流
- Docker Compose 一键启动与宿主机部署方案

## 快速开始

```bash
cp .env.example .env
docker compose up -d --build
```

默认访问地址：

- 前端：`http://localhost:8088`
- 健康检查：`http://localhost:8081/healthz`

## 关键环境变量

- `APP_ENV`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `CORS_ORIGIN`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_ROOM_NAME`

如果不走 Docker Compose，而是在宿主机直接启动后端，请额外提供：

- `DATABASE_URL`

## 安全模型

- 已解密明文保存在浏览器本地加密存储中，避免前向保密带来的历史消息不可恢复
- 服务端仅接收和持久化密文结构
- 私钥以不可导出的 `CryptoKey` 形式保存在 IndexedDB
- 登录会话使用 `httpOnly + SameSite=Strict` Cookie
- 写操作接口启用 CSRF 双提交校验
- 默认关闭公开注册，由管理员创建普通用户

## 主要接口

- 会话与用户：`/api/login`、`/api/session`、`/api/logout`、`/api/admin/users`
- 房间：`/api/rooms`、`/api/rooms/:id/join`
- 消息：`/api/rooms/:id/messages`
- Signal 相关：`/api/signal/prekey-bundle/*`、`/api/signal/safety-number/:userId`
- 实时通信：`/ws?room_id=<roomID>`

## 运行与部署

- 默认推荐 `Docker Compose`
- 如服务器不能拉取容器镜像，可使用 Go + Node.js + PostgreSQL 走宿主机部署
- 生产环境必须使用 HTTPS/WSS，否则浏览器端 Web Crypto 能力会受限

## CI

仓库内置 GitHub Actions 工作流，会在 `push` 和 `pull_request` 时执行：

- 后端 `go test ./...`
- 前端 `npm run lint && npm test && npm run build`

## 许可证

本项目使用 MIT License，详见 [LICENSE](./LICENSE)。
