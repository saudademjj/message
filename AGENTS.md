# AGENTS.md

Guidelines for agentic coding agents operating in this repository.

## Project Overview

End-to-end encrypted chat application with Go backend and React/TypeScript frontend.

## Build Commands

### Frontend (from `frontend/` directory)

```bash
npm run dev          # Start development server
npm run build       # Type-check and build for production (tsc -b && vite build)
npm run lint        # Run ESLint
npm test            # Run all tests (vitest run)
npm run test:watch  # Run tests in watch mode
```

### Running a Single Test (Frontend)

```bash
npx vitest run src/path/to/file.test.ts
npx vitest run --grep "test name pattern"
```

### Backend (from `backend/` directory)

```bash
go test ./...                    # Run all tests
go test -run TestName ./...      # Run specific test by name
go test ./internal/server/...    # Run tests in specific package
go build ./cmd/server            # Build the server binary
```

## Code Style Guidelines

### TypeScript/React (Frontend)

**Imports**
- ES module syntax: `import { X } from './path'`
- Group imports: external packages first, then internal modules
- Use `.tsx` extension for files with JSX

**TypeScript**
- Strict mode enabled; all variables and parameters must be typed
- Use `type` for object shapes, `interface` for extendable contracts
- Prefer explicit return types for exported functions
- Use `as const` for literal types and readonly arrays
- Avoid `any`; use `unknown` when type is truly unknown

**React**
- Functional components only; no class components
- Custom hooks prefixed with `use` (e.g., `useMessages`, `useAuth`)
- Context providers wrap application sections (AuthProvider, CryptoProvider)
- Use Zustand for global state (`useChatStore`)
- Prefer `useCallback` and `useMemo` for performance optimization

**Naming**
- camelCase for variables, functions, and methods
- PascalCase for types, interfaces, components, and classes
- UPPER_SNAKE_CASE for constants
- Files: camelCase for utilities, PascalCase for components

**Error Handling**
- Use `try/catch` with typed catch blocks (`catch (reason: unknown)`)
- Provide user-friendly error messages
- Use `ApiError` class for API errors with error codes
- Log errors appropriately; avoid exposing internals to users

**Formatting**
- No semicolons at end of statements (not enforced but common)
- 2-space indentation
- Single quotes for strings (prefer double quotes in JSX attributes)

### Go (Backend)

**Package Structure**
- Main package in `cmd/server`
- Internal packages under `internal/`
- Package name matches directory name

**Error Handling**
- Return errors explicitly; do not panic in handlers
- Use `context.WithTimeout` for database operations
- Wrap errors with context when appropriate

**HTTP Handlers**
- Handler functions receive `http.ResponseWriter` and `*http.Request`
- Use helper functions like `respondJSON` for JSON responses
- Validate input early and return appropriate HTTP status codes

**Testing**
- Test files suffixed with `_test.go`
- Use `*testing.T` for test utilities
- Table-driven tests for multiple cases
- Use `httptest.NewRecorder()` for HTTP handler tests

**Naming**
- camelCase for local variables
- PascalCase for exported functions/types
- Short names for short-lived variables (e.g., `w`, `r` for handlers)

## Architecture Notes

### Frontend
- **State Management**: Zustand store in `src/stores/chatStore.ts`
- **API Client**: `ApiClient` class in `src/api.ts` handles HTTP requests
- **Crypto**: Web Crypto API in `src/crypto/` for E2EE operations
- **WebSocket**: Real-time messaging via `WebSocketContext`
- **Routing**: React Router with route-based page components

### Backend
- **Server**: Standard `net/http` with gorilla/websocket
- **Database**: PostgreSQL via pgx driver
- **Auth**: JWT tokens with refresh tokens; CSRF protection
- **Migrations**: golang-migrate for schema migrations

## Testing Patterns

### Frontend Test Example
```typescript
import { describe, expect, it, beforeEach } from 'vitest';

describe('module name', () => {
  beforeEach(() => {
    // Reset state
  });

  it('does something', () => {
    expect(result).toBe(expected);
  });
});
```

### Backend Test Example
```go
func TestHandleSomething(t *testing.T) {
    app := &App{}
    req := httptest.NewRequest(http.MethodGet, "/api/endpoint", nil)
    rec := httptest.NewRecorder()
    app.handleSomething(rec, req)
    if rec.Code != http.StatusOK {
        t.Fatalf("expected %d, got %d", http.StatusOK, rec.Code)
    }
}
```

## Common Commands

```bash
# Full CI check (from repository root)
cd frontend && npm ci && npm run lint && npm test && npm run build
cd ../backend && go test ./... && go build ./cmd/server

# Docker development
docker-compose up --build
```