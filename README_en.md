<div align="center">
  English | <a href="./README.md">简体中文</a>
</div>

# E2EE Chat Space (End-to-End Encrypted Messaging System)

![Go](https://img.shields.io/badge/Go-1.23-00ADD8?style=flat-square&logo=go)
![React](https://img.shields.io/badge/React-19.0-61DAFB?style=flat-square&logo=react)
![WebSocket](https://img.shields.io/badge/WebSocket-Enabled-blue?style=flat-square)
![Cryptography](https://img.shields.io/badge/Security-E2EE-blueviolet?style=flat-square)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql)

An advanced experimental instant messaging system focused on privacy and real-time communication. The core architecture is based on a **Zero-Trust** model, utilizing native client-side encryption to ensure messages remain ciphertext throughout their entire lifecycle (in transit and at rest).

## 🔐 Security Architecture Analysis

### 1. End-to-End Encryption Workflow (E2EE)
The system operates without centralized decryption services; all cryptographic operations occur on user devices:
- **Key Generation**: Upon initialization, each device generates an RSA-OAEP (2048-bit) asymmetric key pair via `crypto.subtle`.
- **Initial Handshake**: When establishing a session, parties exchange public keys and use RSA to securely transmit an ephemeral AES-256 Session Key.
- **Stream Encryption**: Real-time conversations employ **AES-GCM** symmetric encryption. GCM mode provides confidentiality and includes an authentication tag to defend against replay attacks and packet tampering.

### 2. Zero-Knowledge Relay
The Go-based backend is designed as a pure data plane:
- **Packet Structure**: Packets consist of a `Header` (containing signature and target ID) and an encrypted `Payload`.
- **Server Responsibilities**: Verify sender signature -> Route packet based on target ID -> Forward to WebSocket pipe.
- **Privacy Assurance**: The database only records metadata (who sent what to whom); the server possesses no technical means to decrypt payloads.

### 3. Multi-Device Consistency Model
Supports multi-device synchronization. Utilizing a simplified logic similar to the Signal Double Ratchet algorithm, different physical devices under the same account handle their encryption contexts independently.

## 🏗️ Technical Implementation Details

### Backend (Go 1.23)
- **Concurrent Hub Management**: Built with `sync.Map` and `channels` to create a high-performance message distribution center capable of supporting tens of thousands of active connections per instance.
- **Database Driver**: Uses the high-performance `pgx/v5` driver, leveraging its binary protocol for rapid metadata retrieval.

### Frontend (React 19)
- **Native Web Crypto**: Eschews third-party JS libraries in favor of the hardware-accelerated Web Crypto API to mitigate side-channel risks.
- **State Bus**: Encapsulates WebSocket reconnection, heartbeats, and encryption state machines via React Context.

## 📂 Project Structure

```text
message/
├── backend/                # Go Concurrency Backend
│   ├── internal/
│   │   ├── hub/            # WS connection pool and routing engine
│   │   ├── auth/           # Device fingerprint-based authentication
│   │   └── storage/        # Optimized storage for encrypted payloads
│   └── migrations/         # SQL scripts including device management indexes
├── frontend/               # React Secure Frontend
│   ├── src/
│   │   ├── crypto/         # Cryptography wrappers (RSA/AES/SHA)
│   │   ├── store/          # Client-side indexing for encrypted messages
│   │   └── hooks/          # Lifecycle management for real-time streams
└── docker-compose.yml      # Full image configuration for DB and Backend
```

## 🚀 Deployment Guide

### 1. Requirements
- Go >= 1.23
- Node.js >= 20
- PostgreSQL >= 16

### 2. Launch Steps
```bash
# Enter backend and start
cd backend && go run cmd/server/main.go

# Enter frontend and start
cd frontend && npm install && npm run dev
```

## 🗺️ Future Roadmap
- [ ] Implement E2EE voice and video calls via WebRTC.
- [ ] Distributed sharded storage for encrypted attachments.
- [ ] Full Forward Secrecy integration.

## License
MIT License
