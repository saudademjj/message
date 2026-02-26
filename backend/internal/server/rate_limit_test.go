package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestKeyedRateLimiterAllowsAndBlocks(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newKeyedRateLimiter(1, 1, time.Minute)
	limiter.now = func() time.Time { return now }

	if !limiter.Allow("203.0.113.10") {
		t.Fatalf("expected first request to pass")
	}
	if limiter.Allow("203.0.113.10") {
		t.Fatalf("expected second immediate request to be blocked")
	}

	now = now.Add(1 * time.Second)
	if !limiter.Allow("203.0.113.10") {
		t.Fatalf("expected request to pass after token refill")
	}
}

func TestKeyedRateLimiterCleanup(t *testing.T) {
	now := time.Unix(0, 0)
	limiter := newKeyedRateLimiter(10, 10, 2*time.Second)
	limiter.cleanupInterval = time.Second
	limiter.now = func() time.Time { return now }

	if !limiter.Allow("old") {
		t.Fatalf("expected old key request to pass")
	}

	now = now.Add(3 * time.Second)
	if !limiter.Allow("new") {
		t.Fatalf("expected new key request to pass")
	}

	limiter.mu.Lock()
	defer limiter.mu.Unlock()
	if _, exists := limiter.entries["old"]; exists {
		t.Fatalf("expected old key entry to be cleaned up")
	}
	if _, exists := limiter.entries["new"]; !exists {
		t.Fatalf("expected new key entry to remain")
	}
}

func TestClientKeyFromRequest(t *testing.T) {
	t.Run("default uses remote addr", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		request.RemoteAddr = "198.51.100.10:44321"
		if got := clientKeyFromRequest(request, false); got != "198.51.100.10" {
			t.Fatalf("unexpected key: %q", got)
		}
	})

	t.Run("trusted proxy uses forwarded for", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		request.RemoteAddr = "10.0.0.2:1234"
		request.Header.Set("X-Forwarded-For", "203.0.113.9, 10.0.0.2")
		if got := clientKeyFromRequest(request, true); got != "203.0.113.9" {
			t.Fatalf("unexpected key: %q", got)
		}
	})
}

func TestRespondRateLimited(t *testing.T) {
	response := httptest.NewRecorder()
	respondRateLimited(response, "too many login attempts")

	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("expected %d, got %d", http.StatusTooManyRequests, response.Code)
	}
	if response.Header().Get("Retry-After") != "60" {
		t.Fatalf("expected Retry-After header")
	}
	payload := decodeBodyMap(t, response)
	if payload["error"] != "too many login attempts" {
		t.Fatalf("unexpected payload: %#v", payload)
	}
}
