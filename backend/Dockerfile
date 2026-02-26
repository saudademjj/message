FROM golang:1.23-bookworm AS builder
WORKDIR /app

COPY go.mod go.sum* ./
RUN go mod download

COPY . .
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -o /out/chat-backend ./cmd/server

FROM debian:bookworm-slim
RUN useradd -r -u 10001 -m appuser

COPY --from=builder /out/chat-backend /usr/local/bin/chat-backend
USER appuser
EXPOSE 8081
ENTRYPOINT ["/usr/local/bin/chat-backend"]
