package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRequiresCSRF(t *testing.T) {
	t.Parallel()

	if requiresCSRF(http.MethodGet) {
		t.Fatalf("GET should not require csrf")
	}
	if requiresCSRF(http.MethodOptions) {
		t.Fatalf("OPTIONS should not require csrf")
	}
	if !requiresCSRF(http.MethodPost) {
		t.Fatalf("POST should require csrf")
	}
	if !requiresCSRF(http.MethodDelete) {
		t.Fatalf("DELETE should require csrf")
	}
}

func TestValidateCSRFToken(t *testing.T) {
	t.Parallel()

	request := httptest.NewRequest(http.MethodPost, "/api/rooms", nil)
	request.AddCookie(&http.Cookie{Name: csrfCookieName, Value: "csrf-value"})
	request.Header.Set("X-CSRF-Token", "csrf-value")
	if !validateCSRFToken(request) {
		t.Fatalf("expected csrf token to be valid")
	}

	request.Header.Set("X-CSRF-Token", "other-value")
	if validateCSRFToken(request) {
		t.Fatalf("expected csrf token to be invalid")
	}
}

func TestWithCORS(t *testing.T) {
	t.Parallel()

	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})

	t.Run("wildcard reflects request origin", func(t *testing.T) {
		app := &App{corsOrigin: "*"}
		request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		request.Header.Set("Origin", "https://chat.example.com")
		response := httptest.NewRecorder()

		app.withCORS(next).ServeHTTP(response, request)

		if response.Header().Get("Access-Control-Allow-Origin") != "https://chat.example.com" {
			t.Fatalf("unexpected allow origin: %q", response.Header().Get("Access-Control-Allow-Origin"))
		}
	})

	t.Run("explicit origin only", func(t *testing.T) {
		app := &App{corsOrigin: "https://chat.example.com"}
		request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
		request.Header.Set("Origin", "https://evil.example.com")
		response := httptest.NewRecorder()

		app.withCORS(next).ServeHTTP(response, request)

		if value := response.Header().Get("Access-Control-Allow-Origin"); value != "" {
			t.Fatalf("unexpected allow origin for mismatched origin: %q", value)
		}
	})
}

func TestWithSecurityHeaders(t *testing.T) {
	t.Parallel()

	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	app := &App{}

	request := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	request.Header.Set("X-Forwarded-Proto", "https")
	response := httptest.NewRecorder()
	app.withSecurityHeaders(next).ServeHTTP(response, request)

	headers := response.Header()
	if headers.Get("Content-Security-Policy") == "" {
		t.Fatalf("expected content security policy header")
	}
	if headers.Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("unexpected x-content-type-options header: %q", headers.Get("X-Content-Type-Options"))
	}
	if headers.Get("X-Frame-Options") != "DENY" {
		t.Fatalf("unexpected x-frame-options header: %q", headers.Get("X-Frame-Options"))
	}
	if headers.Get("Strict-Transport-Security") == "" {
		t.Fatalf("expected strict transport security header for secure requests")
	}
}

func TestWithAuthRejectsMissingOrInvalidToken(t *testing.T) {
	t.Parallel()

	app := &App{jwtSecret: []byte("0123456789abcdef0123456789abcdef")}
	handler := app.withAuth(func(w http.ResponseWriter, _ *http.Request, _ AuthContext) {
		w.WriteHeader(http.StatusNoContent)
	})

	t.Run("missing auth", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/api/session", nil)
		response := httptest.NewRecorder()
		handler(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("expected %d, got %d", http.StatusUnauthorized, response.Code)
		}
	})

	t.Run("invalid token", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/api/session", nil)
		request.Header.Set("Authorization", "Bearer invalid")
		response := httptest.NewRecorder()
		handler(response, request)
		if response.Code != http.StatusUnauthorized {
			t.Fatalf("expected %d, got %d", http.StatusUnauthorized, response.Code)
		}
	})
}

func TestWithAuthRequiresCSRFForCookieAuth(t *testing.T) {
	t.Parallel()

	app := &App{jwtSecret: []byte("0123456789abcdef0123456789abcdef")}
	token, err := app.issueToken(1, "alice", "user")
	if err != nil {
		t.Fatalf("issue token: %v", err)
	}

	handler := app.withAuth(func(w http.ResponseWriter, _ *http.Request, _ AuthContext) {
		w.WriteHeader(http.StatusNoContent)
	})

	request := httptest.NewRequest(http.MethodPost, "/api/rooms", nil)
	request.AddCookie(&http.Cookie{Name: authCookieName, Value: token})
	response := httptest.NewRecorder()

	handler(response, request)
	if response.Code != http.StatusForbidden {
		t.Fatalf("expected %d, got %d", http.StatusForbidden, response.Code)
	}
}

func TestWithAdmin(t *testing.T) {
	t.Parallel()

	app := &App{}
	handler := app.withAdmin(func(w http.ResponseWriter, _ *http.Request, _ AuthContext) {
		w.WriteHeader(http.StatusNoContent)
	})

	request := httptest.NewRequest(http.MethodGet, "/api/admin/users", nil)
	response := httptest.NewRecorder()
	handler(response, request, AuthContext{UserID: 2, Username: "bob", Role: "user"})
	if response.Code != http.StatusForbidden {
		t.Fatalf("expected %d, got %d", http.StatusForbidden, response.Code)
	}

	adminResponse := httptest.NewRecorder()
	handler(adminResponse, request, AuthContext{UserID: 1, Username: "admin", Role: "admin"})
	if adminResponse.Code != http.StatusNoContent {
		t.Fatalf("expected %d, got %d", http.StatusNoContent, adminResponse.Code)
	}
}
