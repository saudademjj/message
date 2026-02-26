package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func decodeBodyMap(t *testing.T, response *httptest.ResponseRecorder) map[string]any {
	t.Helper()
	body := map[string]any{}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode response: %v", err)
	}
	return body
}

func TestHandleLogout(t *testing.T) {
	app := &App{}

	t.Run("method not allowed", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/api/logout", nil)
		response := httptest.NewRecorder()

		app.handleLogout(response, request)

		if response.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected %d, got %d", http.StatusMethodNotAllowed, response.Code)
		}
		payload := decodeBodyMap(t, response)
		if payload["error"] != "method not allowed" {
			t.Fatalf("unexpected payload: %#v", payload)
		}
	})

	t.Run("logout without cookie does not require csrf", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/api/logout", nil)
		response := httptest.NewRecorder()

		app.handleLogout(response, request)

		if response.Code != http.StatusOK {
			t.Fatalf("expected %d, got %d", http.StatusOK, response.Code)
		}
		payload := decodeBodyMap(t, response)
		if payload["loggedOut"] != true {
			t.Fatalf("unexpected payload: %#v", payload)
		}
	})

	t.Run("logout with auth cookie requires csrf", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/api/logout", nil)
		request.AddCookie(&http.Cookie{Name: authCookieName, Value: "token-value"})
		response := httptest.NewRecorder()

		app.handleLogout(response, request)

		if response.Code != http.StatusForbidden {
			t.Fatalf("expected %d, got %d", http.StatusForbidden, response.Code)
		}
		payload := decodeBodyMap(t, response)
		if payload["error"] != "csrf token validation failed" {
			t.Fatalf("unexpected payload: %#v", payload)
		}
	})

	t.Run("logout with auth cookie and valid csrf", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/api/logout", strings.NewReader(""))
		request.AddCookie(&http.Cookie{Name: authCookieName, Value: "token-value"})
		request.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "csrf-value"})
		request.Header.Set("X-CSRF-Token", "csrf-value")
		response := httptest.NewRecorder()

		app.handleLogout(response, request)

		if response.Code != http.StatusOK {
			t.Fatalf("expected %d, got %d", http.StatusOK, response.Code)
		}
		payload := decodeBodyMap(t, response)
		if payload["loggedOut"] != true {
			t.Fatalf("unexpected payload: %#v", payload)
		}
	})
}

func TestHandleLoginRateLimitByIP(t *testing.T) {
	app := &App{
		loginIPLimiter: newKeyedRateLimiter(0, 1, time.Minute),
	}

	firstRequest := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"username":"alice","password":"short"}`))
	firstRequest.RemoteAddr = "203.0.113.10:12345"
	firstResponse := httptest.NewRecorder()
	app.handleLogin(firstResponse, firstRequest)
	if firstResponse.Code != http.StatusBadRequest {
		t.Fatalf("expected first response to be %d, got %d", http.StatusBadRequest, firstResponse.Code)
	}

	secondRequest := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"username":"alice","password":"short"}`))
	secondRequest.RemoteAddr = "203.0.113.10:12345"
	secondResponse := httptest.NewRecorder()
	app.handleLogin(secondResponse, secondRequest)
	if secondResponse.Code != http.StatusTooManyRequests {
		t.Fatalf("expected second response to be %d, got %d", http.StatusTooManyRequests, secondResponse.Code)
	}
}

func TestHandleLoginRateLimitByUsername(t *testing.T) {
	app := &App{
		loginIPLimiter:   newKeyedRateLimiter(100, 100, time.Minute),
		loginUserLimiter: newKeyedRateLimiter(0, 1, time.Minute),
	}

	firstRequest := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"username":"alice","password":"short"}`))
	firstResponse := httptest.NewRecorder()
	app.handleLogin(firstResponse, firstRequest)
	if firstResponse.Code != http.StatusBadRequest {
		t.Fatalf("expected first response to be %d, got %d", http.StatusBadRequest, firstResponse.Code)
	}

	secondRequest := httptest.NewRequest(http.MethodPost, "/api/login", strings.NewReader(`{"username":"alice","password":"short"}`))
	secondResponse := httptest.NewRecorder()
	app.handleLogin(secondResponse, secondRequest)
	if secondResponse.Code != http.StatusTooManyRequests {
		t.Fatalf("expected second response to be %d, got %d", http.StatusTooManyRequests, secondResponse.Code)
	}
}
