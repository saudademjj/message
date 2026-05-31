# E2EE Chat Frontend

React + TypeScript 客户端，负责端到端加解密、实时聊天交互和房间状态展示。

## 本地启动

```bash
npm install
npm run dev
```

常用检查：

```bash
npm run lint
npm test
npm run build
```

## 体验亮点

- 浏览器端完成 `X3DH + Double Ratchet` 加解密，服务端只保存密文。
- 支持回复、编辑、撤回、已读回执、输入中、消息搜索、`@` 提及和通知。
- 房间列表展示最近活跃时间与实时未读数，不暴露消息明文预览。
- 时间线支持未读分割线、历史分页、断线重连和失败消息重试。
- 邀请加入、管理员用户管理、暗色模式和移动端输入适配已内置。

## 主要入口

- `src/App.tsx`：应用路由与 Provider 组合。
- `src/pages/ChatRoutePage.tsx`：聊天页装配层。
- `src/hooks/useMessages.ts`：消息收发、解密、回执与恢复。
- `src/contexts/RoomSummaryContext.tsx`：全局房间摘要实时同步。
- `src/crypto/`：端到端加密实现。
