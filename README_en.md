<div align="center">
  English | <a href="./README.md">简体中文</a>
</div>

# E2EE Chat -- End-to-End Encrypted Chat System

![Go](https://img.shields.io/badge/Go-1.23-00ADD8?style=flat-square&logo=go)
![React](https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql)
![WebSocket](https://img.shields.io/badge/WebSocket-Native-010101?style=flat-square)
![WebCrypto](https://img.shields.io/badge/Web_Crypto-API-blueviolet?style=flat-square)

A privacy-focused end-to-end encrypted chat application. The Go backend serves as a zero-knowledge relay that never participates in decryption; the React 19 frontend handles all encryption/decryption client-side via the Web Crypto API; the database stores only ciphertext payloads, making it technically impossible for the server to access plaintext content.

---

## Core Security Architecture

### End-to-End Encryption Workflow

All cryptographic operations occur on user devices. The system does not rely on any centralized decryption service:

- Key Generation -- Each device generates an RSA-OAEP (2048-bit) asymmetric key pair via `crypto.subtle` upon initialization
- Initial Handshake -- When establishing a session, parties exchange public keys and use RSA to securely transmit an ephemeral AES-256 session key
- Stream Encryption -- Real-time conversations use AES-GCM symmetric encryption. GCM mode provides both confidentiality and authentication tags, defending against replay attacks and packet tampering
- Identity Rotation -- Keys are automatically rotated every 240 minutes, with the last 6 historical key sets retained for decrypting messages during the transition period

### Zero-Knowledge Relay

The Go backend is designed as a pure data plane:

- Packet Structure -- Consists of a Header (containing signature and target ID) and an encrypted Payload
- Server Responsibilities -- Verify sender signature -> Route by target ID -> Forward to WebSocket pipe
- Privacy Guarantee -- The database only records metadata (who sent what to whom); payload content is always ciphertext

### Multi-Device Consistency

Supports multi-device synchronization using simplified logic similar to the Signal Double Ratchet algorithm. Different physical devices under the same account independently manage their own encryption contexts.

---

## Tech Stack

### Backend (Go 1.23)

| Technology | Description |
|------------|-------------|
| Go `net/http` | Standard library HTTP server |
| gorilla/websocket | WebSocket connection management |
| pgx/v5 | High-performance PostgreSQL driver (binary protocol) |
| golang-jwt/jwt | JWT authentication |
| golang-migrate | Database migration management |
| golang.org/x/crypto | bcrypt password hashing |
| golang.org/x/time | Rate limiting |

Key capabilities:

- Concurrent Hub -- Message distribution center built on `sync.Map` and `channels`
- Device Fingerprint Auth -- Identity verification based on unique device identifiers
- WebSocket Pool -- Automatic lifecycle management, heartbeat detection, and reconnection
- Rate Limiting -- Login: 30/min/IP, WebSocket: 60/min/IP
- Graceful Shutdown -- 20-second timeout for clean shutdown

### Frontend (React 19)

| Technology | Description |
|------------|-------------|
| React 19 | UI framework with concurrent features |
| React Router 6 | Client-side routing |
| Zustand 5 | Lightweight state management |
| Vite 5 | Build tool |
| Vitest | Unit testing framework |
| marked + highlight.js | Markdown rendering and code highlighting |
| DOMPurify | XSS protection |
| emoji-picker-react | Emoji picker |

Key capabilities:

- Native Web Crypto -- Hardware-accelerated Web Crypto API, no third-party crypto libraries, reducing side-channel risks
- Client-side Indexing -- Local index structures for encrypted messages, supporting offline retrieval
- Message Signature Verification -- Sender signs + receiver verifies, ensuring message integrity

### Database

| Technology | Description |
|------------|-------------|
| PostgreSQL 16 | Relational database |
| golang-migrate | Schema migration management |

---

## Project Structure

```text
message/
├── backend/
│   ├── cmd/server/                 # Service entry point
│   │   └── main.go
│   ├── internal/server/
│   │   ├── hub.go                  # WebSocket pool and message routing
│   │   ├── ws_service.go           # WebSocket service logic
│   │   ├── handlers_auth.go        # Auth endpoints
│   │   ├── handlers_rooms.go       # Chat room management
│   │   ├── handlers_signal.go      # Signal exchange
│   │   ├── handlers_devices.go     # Device management
│   │   ├── middleware.go           # Middleware (auth, CORS, logging)
│   │   ├── rate_limit.go           # Rate limiting
│   │   ├── signature.go            # Message signature verification
│   │   ├── storage.go              # Data persistence
│   │   ├── config.go               # Configuration management
│   │   ├── migrations.go           # Database migrations
│   │   └── *_test.go               # Unit tests
│   └── migrations/                 # SQL migration scripts
├── frontend/
│   ├── src/
│   │   ├── crypto/                 # Cryptography wrappers
│   │   │   ├── encrypt.ts          # RSA/AES encryption/decryption
│   │   │   ├── identity.ts         # Identity key management
│   │   │   ├── ratchet.ts          # Key rotation (Ratchet)
│   │   │   ├── signature.ts        # Message signing
│   │   │   └── store.ts            # Key storage
│   │   ├── contexts/               # React Contexts
│   │   │   ├── AuthContext.tsx      # Auth state
│   │   │   ├── CryptoContext.tsx    # Encryption state machine
│   │   │   └── WebSocketContext.tsx # WebSocket lifecycle
│   │   ├── hooks/                  # Custom Hooks
│   │   ├── pages/                  # Page components
│   │   ├── components/             # Shared components
│   │   └── stores/                 # Zustand stores
│   └── vitest.config.ts            # Test configuration
├── docker-compose.yml              # Container orchestration
└── deploy-restart.sh               # Deployment script
```

---

## Quick Start

### Prerequisites

- Go >= 1.23
- Node.js >= 20
- PostgreSQL >= 16

### Docker Compose (Recommended)

```bash
git clone https://github.com/saudademjj/message.git
cd message
cp .env.example .env
# Edit .env, change passwords and secrets
docker compose up -d --build
```

### Manual Setup

```bash
# Start backend
cd backend && go run cmd/server/main.go

# Start frontend
cd frontend && npm install && npm run dev
```

### Environment Variables

Configure in the `.env` file:

| Variable | Description | Default |
|----------|-------------|---------|
| `POSTGRES_DB` | Database name | chat |
| `POSTGRES_USER` | Database user | chat |
| `POSTGRES_PASSWORD` | Database password | - |
| `JWT_SECRET` | JWT signing secret | - |
| `ACCESS_TOKEN_TTL_MINUTES` | Access token TTL (minutes) | 15 |
| `REFRESH_TOKEN_TTL_HOURS` | Refresh token TTL (hours) | 336 |
| `CORS_ORIGIN` | Frontend CORS origin | http://localhost:8088 |
| `VITE_API_BASE` | API base URL | http://localhost:8081 |
| `VITE_IDENTITY_ROTATE_MINUTES` | Key rotation interval (minutes) | 240 |
| `VITE_IDENTITY_KEY_HISTORY` | Historical keys retained | 6 |

### Frontend Scripts

```bash
npm run dev             # Start dev server
npm run build           # Production build
npm run test            # Run tests
npm run test:coverage   # Test coverage
npm run lint            # Linting
```

---

## Roadmap

- [ ] E2EE voice and video calls via WebRTC
- [ ] Distributed sharded storage for encrypted attachments
- [ ] Full Forward Secrecy integration

---

## License

[MIT](LICENSE)
