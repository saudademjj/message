package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestHandleWSRateLimit(t *testing.T) {
	app := &App{
		wsConnectLimiter: newKeyedRateLimiter(0, 1, time.Minute),
	}

	firstRequest := httptest.NewRequest(http.MethodGet, "/ws?room_id=1", nil)
	firstRequest.RemoteAddr = "203.0.113.50:40000"
	firstResponse := httptest.NewRecorder()
	app.handleWS(firstResponse, firstRequest)
	if firstResponse.Code != http.StatusUnauthorized {
		t.Fatalf("expected first response to be %d, got %d", http.StatusUnauthorized, firstResponse.Code)
	}

	secondRequest := httptest.NewRequest(http.MethodGet, "/ws?room_id=1", nil)
	secondRequest.RemoteAddr = "203.0.113.50:40000"
	secondResponse := httptest.NewRecorder()
	app.handleWS(secondResponse, secondRequest)
	if secondResponse.Code != http.StatusTooManyRequests {
		t.Fatalf("expected second response to be %d, got %d", http.StatusTooManyRequests, secondResponse.Code)
	}
}
