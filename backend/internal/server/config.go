package server

import (
	"fmt"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type runtimeConfig struct {
	Addr                    string
	AppEnv                  string
	DBURL                   string
	JWTSecret               string
	AccessTokenTTL          time.Duration
	RefreshTokenTTL         time.Duration
	CORSOrigin              string
	AdminUsername           string
	AdminPasswordHash       string
	AdminRoomName           string
	TrustProxyHeaders       bool
	LoginIPRatePerMinute    int
	LoginIPRateBurst        int
	LoginUserRatePerMinute  int
	LoginUserRateBurst      int
	WSConnectRatePerMinute  int
	WSConnectRateBurst      int
	GracefulShutdownTimeout time.Duration
}

func loadRuntimeConfig() (runtimeConfig, error) {
	trustProxyHeaders, err := readBoolEnv("TRUST_PROXY_HEADERS", defaultTrustProxy)
	if err != nil {
		return runtimeConfig{}, err
	}
	loginIPRatePerMinute, err := readPositiveIntEnv("LOGIN_RATE_LIMIT_IP_PER_MINUTE", defaultLoginIPPerMin)
	if err != nil {
		return runtimeConfig{}, err
	}
	loginIPRateBurst, err := readPositiveIntEnv("LOGIN_RATE_LIMIT_IP_BURST", defaultLoginIPBurst)
	if err != nil {
		return runtimeConfig{}, err
	}
	loginUserRatePerMinute, err := readPositiveIntEnv("LOGIN_RATE_LIMIT_USER_PER_MINUTE", defaultLoginUserPerMin)
	if err != nil {
		return runtimeConfig{}, err
	}
	loginUserRateBurst, err := readPositiveIntEnv("LOGIN_RATE_LIMIT_USER_BURST", defaultLoginUserBurst)
	if err != nil {
		return runtimeConfig{}, err
	}
	wsConnectRatePerMinute, err := readPositiveIntEnv("WS_RATE_LIMIT_IP_PER_MINUTE", defaultWSConnPerMin)
	if err != nil {
		return runtimeConfig{}, err
	}
	wsConnectRateBurst, err := readPositiveIntEnv("WS_RATE_LIMIT_IP_BURST", defaultWSConnBurst)
	if err != nil {
		return runtimeConfig{}, err
	}
	shutdownTimeoutSecs, err := readPositiveIntEnv("GRACEFUL_SHUTDOWN_TIMEOUT_SECONDS", defaultShutdownSecs)
	if err != nil {
		return runtimeConfig{}, err
	}
	accessTokenTTLMinutes, err := readPositiveIntEnv("ACCESS_TOKEN_TTL_MINUTES", defaultAccessTokenMins)
	if err != nil {
		return runtimeConfig{}, err
	}
	refreshTokenTTLHours, err := readPositiveIntEnv("REFRESH_TOKEN_TTL_HOURS", defaultRefreshTokenHrs)
	if err != nil {
		return runtimeConfig{}, err
	}

	cfg := runtimeConfig{
		Addr:                    readEnvOrFallback("APP_ADDR", defaultAddr),
		AppEnv:                  normalizeAppEnv(readEnvOrFallback("APP_ENV", defaultAppEnv)),
		DBURL:                   strings.TrimSpace(os.Getenv("DATABASE_URL")),
		JWTSecret:               strings.TrimSpace(os.Getenv("JWT_SECRET")),
		AccessTokenTTL:          time.Duration(accessTokenTTLMinutes) * time.Minute,
		RefreshTokenTTL:         time.Duration(refreshTokenTTLHours) * time.Hour,
		CORSOrigin:              strings.TrimSpace(os.Getenv("CORS_ORIGIN")),
		AdminUsername:           strings.TrimSpace(readEnvOrFallback("ADMIN_USERNAME", defaultAdminUsername)),
		AdminPasswordHash:       strings.TrimSpace(os.Getenv("ADMIN_PASSWORD_HASH")),
		AdminRoomName:           strings.TrimSpace(readEnvOrFallback("ADMIN_ROOM_NAME", defaultAdminRoomName)),
		TrustProxyHeaders:       trustProxyHeaders,
		LoginIPRatePerMinute:    loginIPRatePerMinute,
		LoginIPRateBurst:        loginIPRateBurst,
		LoginUserRatePerMinute:  loginUserRatePerMinute,
		LoginUserRateBurst:      loginUserRateBurst,
		WSConnectRatePerMinute:  wsConnectRatePerMinute,
		WSConnectRateBurst:      wsConnectRateBurst,
		GracefulShutdownTimeout: time.Duration(shutdownTimeoutSecs) * time.Second,
	}

	if cfg.DBURL == "" {
		return runtimeConfig{}, fmt.Errorf("DATABASE_URL must not be empty")
	}
	if err := validateDatabaseURL(cfg.DBURL, isProductionEnv(cfg.AppEnv)); err != nil {
		return runtimeConfig{}, err
	}

	if err := validateJWTSecret(cfg.JWTSecret); err != nil {
		return runtimeConfig{}, err
	}
	if err := validateSessionTokenTTL(cfg.AccessTokenTTL, cfg.RefreshTokenTTL); err != nil {
		return runtimeConfig{}, err
	}

	if err := validateCORSOrigin(cfg.CORSOrigin, !isProductionEnv(cfg.AppEnv)); err != nil {
		return runtimeConfig{}, err
	}

	if cfg.AdminUsername == "" {
		return runtimeConfig{}, fmt.Errorf("ADMIN_USERNAME must not be empty")
	}
	if cfg.AdminPasswordHash == "" {
		return runtimeConfig{}, fmt.Errorf("ADMIN_PASSWORD_HASH must not be empty")
	}
	if cfg.AdminRoomName == "" {
		return runtimeConfig{}, fmt.Errorf("ADMIN_ROOM_NAME must not be empty")
	}

	return cfg, nil
}

func readEnvOrFallback(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func readPositiveIntEnv(key string, fallback int) (int, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return parsed, nil
}

func readBoolEnv(key string, fallback bool) (bool, error) {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false", key)
	}
	return parsed, nil
}

func normalizeAppEnv(value string) string {
	normalized := strings.ToLower(strings.TrimSpace(value))
	if normalized == "" {
		return defaultAppEnv
	}
	return normalized
}

func isProductionEnv(value string) bool {
	switch normalizeAppEnv(value) {
	case "production", "prod":
		return true
	default:
		return false
	}
}

func validateJWTSecret(secret string) error {
	trimmed := strings.TrimSpace(secret)
	if trimmed == "" {
		return fmt.Errorf("JWT_SECRET must not be empty")
	}

	lower := strings.ToLower(trimmed)
	switch lower {
	case "replace-me", "changeme", "change-me", "secret", "jwt-secret", "jwtsecret", "change-this-jwt-secret":
		return fmt.Errorf("JWT_SECRET is too weak; please set a strong random secret")
	}

	if len(trimmed) < 32 {
		return fmt.Errorf("JWT_SECRET must be at least 32 characters")
	}

	return nil
}

func validateSessionTokenTTL(accessTTL, refreshTTL time.Duration) error {
	if accessTTL < 5*time.Minute {
		return fmt.Errorf("ACCESS_TOKEN_TTL_MINUTES must be at least 5")
	}
	if accessTTL > 24*time.Hour {
		return fmt.Errorf("ACCESS_TOKEN_TTL_MINUTES must be <= 1440")
	}
	if refreshTTL < 24*time.Hour {
		return fmt.Errorf("REFRESH_TOKEN_TTL_HOURS must be at least 24")
	}
	if refreshTTL > 90*24*time.Hour {
		return fmt.Errorf("REFRESH_TOKEN_TTL_HOURS must be <= 2160")
	}
	if refreshTTL <= accessTTL {
		return fmt.Errorf("REFRESH_TOKEN_TTL_HOURS must be greater than ACCESS_TOKEN_TTL_MINUTES")
	}
	return nil
}

func validateDatabaseURL(dbURL string, requireTLS bool) error {
	parsed, err := url.Parse(dbURL)
	if err != nil {
		return fmt.Errorf("invalid DATABASE_URL: %w", err)
	}

	scheme := strings.ToLower(strings.TrimSpace(parsed.Scheme))
	if scheme != "postgres" && scheme != "postgresql" {
		return fmt.Errorf("DATABASE_URL must use postgres or postgresql scheme")
	}

	if parsed.User == nil {
		return fmt.Errorf("DATABASE_URL must include database credentials")
	}

	password, hasPassword := parsed.User.Password()
	if !hasPassword || strings.TrimSpace(password) == "" {
		return fmt.Errorf("DATABASE_URL must include a password")
	}

	lowerPassword := strings.ToLower(strings.TrimSpace(password))
	switch lowerPassword {
	case "change-me", "change-this-db-password", "changeme", "password", "postgres":
		return fmt.Errorf("DATABASE_URL password is too weak; please use a strong password")
	}

	sslMode := strings.ToLower(strings.TrimSpace(parsed.Query().Get("sslmode")))
	if requireTLS {
		switch sslMode {
		case "require", "verify-ca", "verify-full":
		default:
			return fmt.Errorf("DATABASE_URL must enforce TLS in production (sslmode=require|verify-ca|verify-full)")
		}
	}

	return nil
}

func validateCORSOrigin(origin string, allowWildcard bool) error {
	trimmed := strings.TrimSpace(origin)
	if trimmed == "" {
		return fmt.Errorf("CORS_ORIGIN must not be empty")
	}
	if trimmed == "*" {
		if allowWildcard {
			return nil
		}
		return fmt.Errorf("CORS_ORIGIN cannot be '*' in production")
	}

	parsed, err := url.Parse(trimmed)
	if err != nil {
		return fmt.Errorf("invalid CORS_ORIGIN: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("CORS_ORIGIN must be a valid http/https origin")
	}
	if parsed.Host == "" {
		return fmt.Errorf("CORS_ORIGIN must include host")
	}
	if parsed.Path != "" && parsed.Path != "/" {
		return fmt.Errorf("CORS_ORIGIN must not include path")
	}

	return nil
}
