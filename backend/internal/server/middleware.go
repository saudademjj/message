package server

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
)

const (
	apiContentSecurityPolicy = "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
	hstsHeaderValue          = "max-age=31536000; includeSubDomains; preload"
)

func (a *App) withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		headers := w.Header()
		headers.Set("Content-Security-Policy", apiContentSecurityPolicy)
		headers.Set("X-Content-Type-Options", "nosniff")
		headers.Set("X-Frame-Options", "DENY")
		headers.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		headers.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if isSecureRequest(r) {
			headers.Set("Strict-Transport-Security", hstsHeaderValue)
		}
		next.ServeHTTP(w, r)
	})
}

func (a *App) withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if a.corsOrigin == "*" {
			if origin == "" {
				w.Header().Set("Access-Control-Allow-Origin", "*")
			} else {
				w.Header().Set("Access-Control-Allow-Origin", origin)
			}
		} else if origin == a.corsOrigin {
			w.Header().Set("Access-Control-Allow-Origin", origin)
		}
		w.Header().Set("Vary", "Origin")
		w.Header().Set("Access-Control-Allow-Credentials", "true")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-CSRF-Token")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")

		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func requiresCSRF(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	default:
		return true
	}
}

func validateCSRFToken(r *http.Request) bool {
	cookie, err := r.Cookie(csrfCookieName)
	if err != nil {
		return false
	}
	headerValue := strings.TrimSpace(r.Header.Get("X-CSRF-Token"))
	cookieValue := strings.TrimSpace(cookie.Value)
	if headerValue == "" || cookieValue == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(headerValue), []byte(cookieValue)) == 1
}

func (a *App) withAuth(next func(http.ResponseWriter, *http.Request, AuthContext)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tokenString, authSource := authTokenFromRequest(r)
		if tokenString == "" {
			respondJSON(w, http.StatusUnauthorized, map[string]any{"error": "authorization required"})
			return
		}
		claims, err := a.parseToken(tokenString)
		if err != nil {
			respondJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid token"})
			return
		}
		if authSource == "cookie" && requiresCSRF(r.Method) && !validateCSRFToken(r) {
			respondJSON(w, http.StatusForbidden, map[string]any{"error": "csrf token validation failed"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		defer cancel()
		role, err := a.ensureUserIdentity(ctx, claims.UserID, claims.Username)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) || errors.Is(err, errInvalidIdentity) {
				respondJSON(w, http.StatusUnauthorized, map[string]any{"error": "authorization required"})
				return
			}
			respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to validate identity"})
			return
		}
		if role != claims.Role {
			respondJSON(w, http.StatusUnauthorized, map[string]any{"error": "token role mismatch"})
			return
		}
		next(w, r, AuthContext{UserID: claims.UserID, Username: claims.Username, Role: role})
	}
}

func (a *App) withAdmin(next func(http.ResponseWriter, *http.Request, AuthContext)) func(http.ResponseWriter, *http.Request, AuthContext) {
	return func(w http.ResponseWriter, r *http.Request, auth AuthContext) {
		if auth.Role != "admin" {
			respondJSON(w, http.StatusForbidden, map[string]any{"error": "admin authorization required"})
			return
		}
		next(w, r, auth)
	}
}
