package server

import (
	"testing"
	"time"
)

func TestValidateJWTSecret(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name      string
		secret    string
		shouldErr bool
	}{
		{name: "empty", secret: "", shouldErr: true},
		{name: "known weak", secret: "replace-me", shouldErr: true},
		{name: "too short", secret: "0123456789abcdef0123456789abc", shouldErr: true},
		{name: "strong", secret: "0123456789abcdef0123456789abcdef", shouldErr: false},
	}

	for _, item := range cases {
		item := item
		t.Run(item.name, func(t *testing.T) {
			t.Parallel()
			err := validateJWTSecret(item.secret)
			if item.shouldErr && err == nil {
				t.Fatalf("expected error")
			}
			if !item.shouldErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestValidateDatabaseURL(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name       string
		dbURL      string
		requireTLS bool
		shouldErr  bool
	}{
		{
			name:      "invalid scheme",
			dbURL:     "mysql://chat:password@localhost:3306/chat",
			shouldErr: true,
		},
		{
			name:      "weak password",
			dbURL:     "postgres://chat:change-me@localhost:5432/chat?sslmode=disable",
			shouldErr: true,
		},
		{
			name:       "production requires tls",
			dbURL:      "postgres://chat:S3curePassword1234567890@localhost:5432/chat?sslmode=disable",
			requireTLS: true,
			shouldErr:  true,
		},
		{
			name:       "production with tls",
			dbURL:      "postgres://chat:S3curePassword1234567890@localhost:5432/chat?sslmode=require",
			requireTLS: true,
			shouldErr:  false,
		},
		{
			name:       "development allows disable",
			dbURL:      "postgres://chat:S3curePassword1234567890@localhost:5432/chat?sslmode=disable",
			requireTLS: false,
			shouldErr:  false,
		},
	}

	for _, item := range cases {
		item := item
		t.Run(item.name, func(t *testing.T) {
			t.Parallel()
			err := validateDatabaseURL(item.dbURL, item.requireTLS)
			if item.shouldErr && err == nil {
				t.Fatalf("expected error")
			}
			if !item.shouldErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestValidateCORSOrigin(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name          string
		origin        string
		allowWildcard bool
		shouldErr     bool
	}{
		{name: "empty", origin: "", allowWildcard: false, shouldErr: true},
		{name: "production wildcard denied", origin: "*", allowWildcard: false, shouldErr: true},
		{name: "development wildcard allowed", origin: "*", allowWildcard: true, shouldErr: false},
		{name: "invalid origin", origin: "not-a-url", allowWildcard: false, shouldErr: true},
		{name: "valid origin", origin: "https://chat.example.com", allowWildcard: false, shouldErr: false},
	}

	for _, item := range cases {
		item := item
		t.Run(item.name, func(t *testing.T) {
			t.Parallel()
			err := validateCORSOrigin(item.origin, item.allowWildcard)
			if item.shouldErr && err == nil {
				t.Fatalf("expected error")
			}
			if !item.shouldErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}

func TestReadPositiveIntEnv(t *testing.T) {
	t.Setenv("RATE_LIMIT_TEST", "")
	value, err := readPositiveIntEnv("RATE_LIMIT_TEST", 42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if value != 42 {
		t.Fatalf("unexpected value: %d", value)
	}

	t.Setenv("RATE_LIMIT_TEST", "8")
	value, err = readPositiveIntEnv("RATE_LIMIT_TEST", 42)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if value != 8 {
		t.Fatalf("unexpected value: %d", value)
	}

	t.Setenv("RATE_LIMIT_TEST", "0")
	if _, err := readPositiveIntEnv("RATE_LIMIT_TEST", 42); err == nil {
		t.Fatalf("expected error for zero")
	}

	t.Setenv("RATE_LIMIT_TEST", "abc")
	if _, err := readPositiveIntEnv("RATE_LIMIT_TEST", 42); err == nil {
		t.Fatalf("expected error for invalid int")
	}
}

func TestReadBoolEnv(t *testing.T) {
	t.Setenv("TRUST_PROXY_TEST", "")
	value, err := readBoolEnv("TRUST_PROXY_TEST", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !value {
		t.Fatalf("expected fallback true")
	}

	t.Setenv("TRUST_PROXY_TEST", "false")
	value, err = readBoolEnv("TRUST_PROXY_TEST", true)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if value {
		t.Fatalf("expected parsed false")
	}

	t.Setenv("TRUST_PROXY_TEST", "invalid")
	if _, err := readBoolEnv("TRUST_PROXY_TEST", true); err == nil {
		t.Fatalf("expected error for invalid bool")
	}
}

func TestValidateSessionTokenTTL(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name       string
		accessTTL  time.Duration
		refreshTTL time.Duration
		shouldErr  bool
	}{
		{
			name:       "valid",
			accessTTL:  15 * time.Minute,
			refreshTTL: 14 * 24 * time.Hour,
			shouldErr:  false,
		},
		{
			name:       "access too short",
			accessTTL:  4 * time.Minute,
			refreshTTL: 14 * 24 * time.Hour,
			shouldErr:  true,
		},
		{
			name:       "refresh too short",
			accessTTL:  15 * time.Minute,
			refreshTTL: 23 * time.Hour,
			shouldErr:  true,
		},
		{
			name:       "refresh not greater",
			accessTTL:  24 * time.Hour,
			refreshTTL: 24 * time.Hour,
			shouldErr:  true,
		},
	}

	for _, item := range cases {
		item := item
		t.Run(item.name, func(t *testing.T) {
			t.Parallel()
			err := validateSessionTokenTTL(item.accessTTL, item.refreshTTL)
			if item.shouldErr && err == nil {
				t.Fatalf("expected error")
			}
			if !item.shouldErr && err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
		})
	}
}
