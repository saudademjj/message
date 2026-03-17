# E2EE Chat

English | [简体中文](README.md)

`E2EE Chat` is a full-stack end-to-end encrypted chat application built with a Go backend, a React frontend, and PostgreSQL as ciphertext storage. The project focuses on implementing practical browser-side encryption and baseline operational hardening, not just real-time messaging.

## Core Capabilities

- Room-based real-time messaging
- Browser-generated and browser-stored identity key material
- `X3DH + Double Ratchet` style session setup and key evolution
- Ciphertext-only storage on the server
- `httpOnly` cookie sessions with CSRF protection
- Rate limiting for login and WebSocket handshakes
- Docker Compose startup and a host deployment path

## Quick Start

```bash
cp .env.example .env
docker compose up -d --build
```

Default URLs:

- Frontend: `http://localhost:8088`
- Health check: `http://localhost:8081/healthz`

## Important Environment Variables

- `APP_ENV`
- `POSTGRES_DB`
- `POSTGRES_USER`
- `POSTGRES_PASSWORD`
- `JWT_SECRET`
- `CORS_ORIGIN`
- `ADMIN_USERNAME`
- `ADMIN_PASSWORD_HASH`
- `ADMIN_ROOM_NAME`

If you run the backend outside Docker Compose, you also need:

- `DATABASE_URL`

## Security Model

- Decrypted plaintext is stored only in local encrypted browser storage
- The server only receives and stores ciphertext payloads
- Private keys are kept as non-exportable `CryptoKey` objects in IndexedDB
- Authentication uses `httpOnly + SameSite=Strict` cookies
- State-changing routes use CSRF double-submit protection
- Public registration is disabled by default and admins create users

## CI

The repository includes a GitHub Actions workflow that runs:

- `go test ./...`
- `npm run lint && npm test && npm run build`

## License

This project is licensed under the MIT License. See [LICENSE](./LICENSE).
