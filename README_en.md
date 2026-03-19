<div align="center">
  English | <a href="./README.md">简体中文</a>
</div>

# E2EE Chat -- End-to-End Encrypted Chat Application

![Go](https://img.shields.io/badge/Go-1.23-00ADD8?style=flat-square&logo=go)
![React](https://img.shields.io/badge/React-19.0-61DAFB?style=flat-square&logo=react)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql)
![WebSocket](https://img.shields.io/badge/WebSocket-Native-010101?style=flat-square)
![WebCrypto](https://img.shields.io/badge/Web_Crypto-API-blueviolet?style=flat-square)

A secure, decoupled End-to-End Encrypted (E2EE) chat room application ensuring absolute privacy. The Go backend serves as a zero-knowledge relay that never decrypts messages; the React frontend handles all encryption/decryption client-side via the Web Crypto API; the database stores only encrypted payload ciphertexts.

## Core Security Architecture

### End-to-End Encryption Workflow

The system operates without centralized decryption services. All cryptographic operations occur on user devices:

- Key Generation: Each device generates an RSA-OAEP (2048-bit) asymmetric key pair via `crypto.subtle` upon initialization
- Initial Handshake: When establishing a session, parties exchange public keys and use RSA to securely transmit an ephemeral AES-256 Session Key
- Stream Encryption: Real-time conversations employ AES-GCM symmetric encryption. GCM mode provides confidentiality and includes an authentication tag to defend against replay attacks and packet tampering

### Zero-Knowledge Relay

The Go backend is designed as a pure data plane:

- Packet Structure: Packets consist of a Header (containing signature and target ID) and an encrypted Payload
- Server Responsibilities: Verify sender signature -> Route based on target ID -> Forward to WebSocket pipe
- Privacy Assurance: The database only records metadata (who sent what to whom); the server possesses no technical means to decrypt payloads

### Multi-Device Consistency Model

Supports multi-device synchronization. Utilizing simplified logic similar to the Signal Double Ratchet algorithm, different physical devices under the same account handle their encryption contexts independently.

## Technical Implementation

### Backend (Go 1.23)

- Concurrent Hub Management: Built with `sync.Map` and `channels` to create a high-performance message distribution center capable of supporting tens of thousands of active connections per instance
- Database Driver: Uses the high-performance `pgx/v5` driver, leveraging its binary protocol for rapid metadata retrieval
- Device Fingerprint Authentication: Identity verification based on unique device identifiers
- WebSocket Connection Pool: Automatic lifecycle management, heartbeat detection, and reconnection handling

### Frontend (React 19)

- Native Web Crypto: Eschews third-party JS crypto libraries in favor of the hardware-accelerated Web Crypto API to mitigate side-channel risks
- State Bus: Encapsulates WebSocket reconnection, heartbeats, and encryption state machines via React Context
- Client-side Indexing: Local index structures for encrypted messages, supporting offline message retrieval

## Directory Structure

```text
message/
├── backend/                # Go Concurrency Backend
│   ├── cmd/
│   │   └── server/         # Service entry point
│   ├── internal/
│   │   ├── hub/            # WebSocket connection pool and routing engine
│   │   ├── auth/           # Device fingerprint authentication
│   │   └── storage/        # Optimized storage for encrypted payloads
│   └── migrations/         # SQL scripts including device management indexes
├── frontend/               # React Secure Frontend
│   ├── src/
│   │   ├── crypto/         # Cryptography wrappers (RSA/AES/SHA)
│   │   ├── store/          # Client-side indexing for encrypted messages
│   │   └── hooks/          # Lifecycle management for real-time streams
├── docker-compose.yml      # Full image configuration for DB and backend
└── deploy-restart.sh       # Deployment restart script
```

## Quick Start

### Prerequisites

- Go >= 1.23
- Node.js >= 20
- PostgreSQL >= 16

### Using Docker Compose (Recommended)

```bash
git clone https://github.com/saudademjj/message.git
cd message
cp .env.example .env
docker compose up -d --build
```

### Manual Launch

```bash
# Start backend
cd backend && go run cmd/server/main.go

# Start frontend
cd frontend && npm install && npm run dev
```

## Roadmap

- [ ] Implement E2EE voice and video calls via WebRTC
- [ ] Distributed sharded storage for encrypted attachments
- [ ] Full Forward Secrecy integration

## License

MIT License
