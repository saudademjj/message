<div align="center">
  English | <a href="./README.md">简体中文</a>
</div>

# E2EE Chat Space (End-to-End Encrypted Instant Messaging System)

![Go](https://img.shields.io/badge/Go-1.23-00ADD8?style=flat-square&logo=go)
![React](https://img.shields.io/badge/React-19.0-61DAFB?style=flat-square&logo=react)
![WebSocket](https://img.shields.io/badge/WebSocket-Enabled-blue?style=flat-square)
![Cryptography](https://img.shields.io/badge/Security-E2EE-blueviolet?style=flat-square)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-4169E1?style=flat-square&logo=postgresql)
![Docker](https://img.shields.io/badge/Docker-Enabled-2496ED?style=flat-square&logo=docker)

This project is a high-security instant messaging experimental system built with a Go backend and a React 19 frontend. The core design adheres to **Zero-Trust** architectural principles by implementing **End-to-End Encryption (E2EE)** at the client layer. This ensures absolute message privacy: only the participating parties possess the decryption keys, and no third party—including the server—can perceive the plaintext message content.

## Security Engineering Implementation

### 1. Client-side Cryptographic Loop
The system deeply integrates the browser-native **Web Crypto API** to drive low-level cryptographic algorithms. Compared to third-party JavaScript libraries, native APIs provide better performance and higher resistance to side-channel attacks.
- **Identity Recognition**: Utilizes RSA-2048 asymmetric algorithms to generate device key pairs.
- **Symmetric Message Encryption**: Employs the AES-GCM (Advanced Encryption Standard) to ensure messages are not only encrypted but also integrity-checked against tampering.

### 2. Zero-Knowledge Relay Server
The backend service, built with Go, acts solely as a "Relay Station" for data packets.
- **Transparent Packet Forwarding**: The server only verifies the device signature and target routing of the packets; it does not store any decryption keys.
- **Signature Verification**: Every upstream message includes a digital signature based on the sender's public key, allowing the server to perform initial filtering and prevent identity spoofing.

### 3. Multi-device Encryption Context Management
The system supports attaching multiple independent physical devices to a single account. Each device generates an independent encryption context during initialization, and multi-terminal message synchronization is achieved through specific handshake protocols.

## Technical Stack & Key Selections

- **Backend Layer**: Go 1.23. Leverages lightweight Goroutines to maintain thousands of active concurrent WebSocket connections.
- **Real-time Communication**: Based on the Gorilla WebSocket protocol, achieving low-latency, full-duplex data exchange.
- **Frontend Layer**: React 19 + Vite. Employs a responsive component-based design, encapsulating complex encryption lifecycles via custom Hooks.
- **Styling System**: Tailwind CSS + Framer Motion. Builds a UI experience that provides a sense of security and fluid interaction.

## Project Structure

```text
message/
├── backend/                # Go Backend Project
│   ├── cmd/                # Entry points
│   ├── internal/           # Core business logic (Auth, Server, Hub, Storage)
│   ├── migrations/         # SQL schema migration scripts
│   └── go.mod              # Dependency manifest
├── frontend/               # React Frontend Project
│   ├── src/
│   │   ├── crypto/         # Web Crypto API wrappers
│   │   ├── context/        # Global state and WS instance management
│   │   ├── hooks/          # Encapsulated encryption, signing, and IO logic
│   │   └── pages/          # View containers
│   └── package.json        # Dependencies and scripts
└── docker-compose.yml      # Full-stack containerization config
```

## Quick Start

### 1. Build via Docker Compose (Recommended)
```bash
cp .env.example .env
docker-compose up -d --build
```

### 2. Manual Start for Development
- **Backend**: `cd backend && go run cmd/server/main.go`
- **Frontend**: `cd frontend && npm install && npm run dev`

## License
This project is licensed under the MIT License.
