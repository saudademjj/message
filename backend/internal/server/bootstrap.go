package server

import (
	"bufio"
	"context"
	"database/sql"
	"errors"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	_ "github.com/jackc/pgx/v5/stdlib"
	"golang.org/x/crypto/bcrypt"
)

func Run() {
	cfg, err := loadRuntimeConfig()
	if err != nil {
		fatalLog("load runtime config failed", "error", err)
	}

	if cfg.AdminPasswordHash == "" {
		fatalLog("admin password hash must not be empty")
	}
	if _, err := bcrypt.Cost([]byte(cfg.AdminPasswordHash)); err != nil {
		fatalLog("invalid admin password hash", "error", err)
	}

	db, err := sql.Open("pgx", cfg.DBURL)
	if err != nil {
		fatalLog("open database failed", "error", err)
	}
	defer db.Close()

	db.SetConnMaxLifetime(30 * time.Minute)
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(10)

	if err := waitForDB(db, 30*time.Second); err != nil {
		fatalLog("database not ready", "error", err)
	}

	if err := runMigrations(db); err != nil {
		fatalLog("run migrations failed", "error", err)
	}
	if err := bootstrapAdminSecurity(db, cfg.AdminUsername, cfg.AdminPasswordHash, cfg.AdminRoomName); err != nil {
		fatalLog("bootstrap admin security failed", "error", err)
	}

	app := &App{
		db:                db,
		hub:               NewHub(),
		jwtSecret:         []byte(cfg.JWTSecret),
		accessTokenTTL:    cfg.AccessTokenTTL,
		refreshTokenTTL:   cfg.RefreshTokenTTL,
		corsOrigin:        cfg.CORSOrigin,
		adminUsername:     cfg.AdminUsername,
		trustProxyHeaders: cfg.TrustProxyHeaders,
		loginIPLimiter:    newKeyedRateLimiter(perMinuteLimit(cfg.LoginIPRatePerMinute), cfg.LoginIPRateBurst, defaultRateLimitEntryTTL),
		loginUserLimiter:  newKeyedRateLimiter(perMinuteLimit(cfg.LoginUserRatePerMinute), cfg.LoginUserRateBurst, defaultRateLimitEntryTTL),
		wsConnectLimiter:  newKeyedRateLimiter(perMinuteLimit(cfg.WSConnectRatePerMinute), cfg.WSConnectRateBurst, defaultRateLimitEntryTTL),
		upgrader: websocket.Upgrader{
			ReadBufferSize:  1024,
			WriteBufferSize: 1024,
			CheckOrigin: func(r *http.Request) bool {
				if cfg.CORSOrigin == "*" {
					return true
				}
				origin := r.Header.Get("Origin")
				return origin == "" || origin == cfg.CORSOrigin
			},
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", app.handleHealth)
	mux.HandleFunc("/api/register", app.handleRegister)
	mux.HandleFunc("/api/login", app.handleLogin)
	mux.HandleFunc("/api/logout", app.handleLogout)
	mux.HandleFunc("/api/refresh", app.handleRefresh)
	mux.HandleFunc("/api/session", app.withAuth(app.handleSession))
	mux.HandleFunc("/api/admin/users", app.withAuth(app.withAdmin(app.handleAdminUsers)))
	mux.HandleFunc("/api/admin/users/", app.withAuth(app.withAdmin(app.handleAdminUserSubroutes)))
	mux.HandleFunc("/api/rooms", app.withAuth(app.handleRooms))
	mux.HandleFunc("/api/rooms/", app.withAuth(app.handleRoomSubroutes))
	mux.HandleFunc("/api/signal/prekey-bundle", app.withAuth(app.handleSignalPreKeyBundle))
	mux.HandleFunc("/api/signal/prekey-bundle/", app.withAuth(app.handleSignalPreKeyBundleSubroutes))
	mux.HandleFunc("/api/signal/safety-number/", app.withAuth(app.handleSignalSafetyNumberSubroutes))
	mux.HandleFunc("/api/invites/join", app.withAuth(app.handleInviteJoin))
	mux.HandleFunc("/ws", app.handleWS)

	handler := loggingMiddleware(app.withSecurityHeaders(app.withCORS(mux)))
	server := &http.Server{
		Addr:              cfg.Addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
	}

	serverErr := make(chan error, 1)
	go func() {
		serverErr <- server.ListenAndServe()
	}()

	signalCh := make(chan os.Signal, 1)
	signal.Notify(signalCh, syscall.SIGINT, syscall.SIGTERM)
	defer signal.Stop(signalCh)

	logger.Info(
		"backend_started",
		"addr",
		cfg.Addr,
		"app_env",
		cfg.AppEnv,
		"access_token_ttl_seconds",
		int64(app.effectiveAccessTokenTTL().Seconds()),
		"refresh_token_ttl_seconds",
		int64(app.effectiveRefreshTokenTTL().Seconds()),
	)

	select {
	case err := <-serverErr:
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			fatalLog("listen failed", "error", err)
		}
	case sig := <-signalCh:
		logger.Info("shutdown_signal_received", "signal", sig.String())
		if err := gracefulShutdown(server, app.hub, cfg.GracefulShutdownTimeout); err != nil {
			logger.Error("graceful_shutdown_failed", "error", err)
		}
		if err := <-serverErr; err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Error("listen_error_after_shutdown", "error", err)
		}
	}
}

func gracefulShutdown(server *http.Server, hub *Hub, timeout time.Duration) error {
	if timeout <= 0 {
		timeout = time.Duration(defaultShutdownSecs) * time.Second
	}
	if hub != nil {
		hub.Shutdown()
	}

	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()

	err := server.Shutdown(ctx)
	if err == nil {
		return nil
	}

	closeErr := server.Close()
	if closeErr != nil {
		return errors.Join(err, closeErr)
	}
	return err
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		recorder := &responseRecorder{ResponseWriter: w, statusCode: http.StatusOK}
		next.ServeHTTP(recorder, r)

		attrs := []any{
			"method", r.Method,
			"path", r.URL.Path,
			"status", recorder.statusCode,
			"duration_ms", time.Since(start).Milliseconds(),
			"response_bytes", recorder.writtenBytes,
			"remote_addr", r.RemoteAddr,
			"user_agent", r.UserAgent(),
		}
		if recorder.statusCode >= http.StatusInternalServerError {
			logger.Error("http_request", attrs...)
			return
		}
		logger.Info("http_request", attrs...)
	})
}

type responseRecorder struct {
	http.ResponseWriter
	statusCode   int
	writtenBytes int
}

func (r *responseRecorder) WriteHeader(statusCode int) {
	r.statusCode = statusCode
	r.ResponseWriter.WriteHeader(statusCode)
}

func (r *responseRecorder) Write(payload []byte) (int, error) {
	if r.statusCode == 0 {
		r.statusCode = http.StatusOK
	}
	n, err := r.ResponseWriter.Write(payload)
	r.writtenBytes += n
	return n, err
}

func (r *responseRecorder) Flush() {
	flusher, ok := r.ResponseWriter.(http.Flusher)
	if !ok {
		return
	}
	flusher.Flush()
}

func (r *responseRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("response writer does not implement http.Hijacker")
	}
	return hijacker.Hijack()
}

func (r *responseRecorder) Push(target string, opts *http.PushOptions) error {
	pusher, ok := r.ResponseWriter.(http.Pusher)
	if !ok {
		return http.ErrNotSupported
	}
	return pusher.Push(target, opts)
}

func (r *responseRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}

func waitForDB(db *sql.DB, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		err := db.PingContext(ctx)
		cancel()
		if err == nil {
			return nil
		}
		if time.Now().After(deadline) {
			return err
		}
		time.Sleep(1 * time.Second)
	}
}
