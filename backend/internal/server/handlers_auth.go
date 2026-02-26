package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func (a *App) handleHealth(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := a.db.PingContext(ctx); err != nil {
		respondJSON(w, http.StatusServiceUnavailable, map[string]any{"status": "degraded", "error": err.Error()})
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"status": "ok"})
}

func (a *App) handleRegister(w http.ResponseWriter, r *http.Request) {
	respondJSON(w, http.StatusForbidden, map[string]any{"error": "registration is disabled on this deployment"})
}

func (a *App) handleLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	if a.loginIPLimiter != nil && !a.loginIPLimiter.Allow(clientKeyFromRequest(r, a.trustProxyHeaders)) {
		respondRateLimited(w, "too many login attempts")
		return
	}

	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decodeJSON(r, &req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}

	req.Username = strings.TrimSpace(req.Username)
	if a.loginUserLimiter != nil && req.Username != "" && !a.loginUserLimiter.Allow(strings.ToLower(req.Username)) {
		respondRateLimited(w, "too many login attempts for this account")
		return
	}
	if len(req.Username) < 3 || len(req.Username) > 32 {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "username length must be between 3 and 32"})
		return
	}
	if len(req.Password) < 8 || len(req.Password) > 128 {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "password length must be between 8 and 128"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	var userID int64
	var hash string
	var role string
	err := a.db.QueryRowContext(ctx,
		`SELECT id, password_hash, role FROM users WHERE username = $1`,
		req.Username,
	).Scan(&userID, &hash, &role)
	if err != nil {
		respondJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid credentials"})
		return
	}
	if role != "admin" && role != "user" {
		respondJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid credentials"})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)); err != nil {
		respondJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid credentials"})
		return
	}

	tokenString, err := a.issueToken(userID, req.Username, role)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to issue token"})
		return
	}
	refreshToken, err := a.issueRefreshToken(ctx, userID)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to initialize refresh session"})
		return
	}
	csrfToken, err := generateCSRFToken()
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to initialize session"})
		return
	}
	setSessionCookies(
		w,
		tokenString,
		refreshToken,
		csrfToken,
		isSecureRequest(r),
		a.effectiveAccessTokenTTL(),
		a.effectiveRefreshTokenTTL(),
	)

	respondJSON(w, http.StatusOK, map[string]any{
		"user": map[string]any{
			"id":       userID,
			"username": req.Username,
			"role":     role,
		},
	})
}

func (a *App) handleSession(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	if r.Method != http.MethodGet {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"user": map[string]any{
			"id":       auth.UserID,
			"username": auth.Username,
			"role":     auth.Role,
		},
	})
}

func (a *App) handleRefresh(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}

	refreshToken := refreshTokenFromRequest(r)
	if refreshToken == "" {
		respondJSON(w, http.StatusUnauthorized, map[string]any{"error": "refresh session required"})
		return
	}
	if !validateCSRFToken(r) {
		respondJSON(w, http.StatusForbidden, map[string]any{"error": "csrf token validation failed"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	auth, rotatedRefreshToken, err := a.rotateRefreshToken(ctx, refreshToken)
	if err != nil {
		if errors.Is(err, errRefreshTokenInvalid) || errors.Is(err, errRefreshTokenExpired) {
			respondJSON(w, http.StatusUnauthorized, map[string]any{"error": "refresh session expired"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to refresh session"})
		return
	}

	accessToken, err := a.issueToken(auth.UserID, auth.Username, auth.Role)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to issue refreshed token"})
		return
	}
	csrfToken, err := generateCSRFToken()
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to rotate csrf token"})
		return
	}

	setSessionCookies(
		w,
		accessToken,
		rotatedRefreshToken,
		csrfToken,
		isSecureRequest(r),
		a.effectiveAccessTokenTTL(),
		a.effectiveRefreshTokenTTL(),
	)

	respondJSON(w, http.StatusOK, map[string]any{
		"user": map[string]any{
			"id":       auth.UserID,
			"username": auth.Username,
			"role":     auth.Role,
		},
	})
}

func (a *App) handleLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	accessToken, _ := authTokenFromRequest(r)
	refreshToken := refreshTokenFromRequest(r)
	if accessToken != "" || refreshToken != "" {
		if !validateCSRFToken(r) {
			respondJSON(w, http.StatusForbidden, map[string]any{"error": "csrf token validation failed"})
			return
		}
	}
	if refreshToken != "" {
		ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
		if err := a.revokeRefreshToken(ctx, refreshToken); err != nil {
			cancel()
			respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to revoke refresh session"})
			return
		}
		cancel()
	}
	clearSessionCookies(w, isSecureRequest(r))
	respondJSON(w, http.StatusOK, map[string]any{"loggedOut": true})
}

func (a *App) handleAdminUsers(w http.ResponseWriter, r *http.Request, _ AuthContext) {
	switch r.Method {
	case http.MethodGet:
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()

		rows, err := a.db.QueryContext(ctx, `
SELECT id, username, role, created_at
FROM users
ORDER BY id ASC
`)
		if err != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to list users"})
			return
		}
		defer rows.Close()

		type userResp struct {
			ID        int64  `json:"id"`
			Username  string `json:"username"`
			Role      string `json:"role"`
			CreatedAt string `json:"createdAt"`
		}
		users := make([]userResp, 0, 16)
		for rows.Next() {
			var user userResp
			var createdAt time.Time
			if err := rows.Scan(&user.ID, &user.Username, &user.Role, &createdAt); err != nil {
				respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to decode user list"})
				return
			}
			user.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
			users = append(users, user)
		}
		respondJSON(w, http.StatusOK, map[string]any{"users": users})

	case http.MethodPost:
		var req struct {
			Username string `json:"username"`
			Password string `json:"password"`
			Role     string `json:"role,omitempty"`
		}
		if err := decodeJSON(r, &req); err != nil {
			respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
			return
		}

		req.Username = strings.TrimSpace(req.Username)
		req.Role = strings.ToLower(strings.TrimSpace(req.Role))
		if req.Role == "" {
			req.Role = "user"
		}
		if req.Role != "user" {
			respondJSON(w, http.StatusBadRequest, map[string]any{"error": "only role=user is allowed for managed creation"})
			return
		}
		if len(req.Username) < 3 || len(req.Username) > 32 {
			respondJSON(w, http.StatusBadRequest, map[string]any{"error": "username length must be between 3 and 32"})
			return
		}
		if len(req.Password) < 8 || len(req.Password) > 128 {
			respondJSON(w, http.StatusBadRequest, map[string]any{"error": "password length must be between 8 and 128"})
			return
		}
		if req.Username == a.adminUsername {
			respondJSON(w, http.StatusBadRequest, map[string]any{"error": "reserved username"})
			return
		}

		hash, err := bcrypt.GenerateFromPassword([]byte(req.Password), bcrypt.DefaultCost)
		if err != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to hash password"})
			return
		}

		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		var userID int64
		var createdAt time.Time
		err = a.db.QueryRowContext(ctx, `
INSERT INTO users(username, password_hash, role)
VALUES ($1, $2, $3)
RETURNING id, created_at
`, req.Username, string(hash), req.Role).Scan(&userID, &createdAt)
		if err != nil {
			if strings.Contains(strings.ToLower(err.Error()), "duplicate") {
				respondJSON(w, http.StatusConflict, map[string]any{"error": "username already exists"})
				return
			}
			respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to create user"})
			return
		}

		respondJSON(w, http.StatusCreated, map[string]any{
			"user": map[string]any{
				"id":        userID,
				"username":  req.Username,
				"role":      req.Role,
				"createdAt": createdAt.UTC().Format(time.RFC3339Nano),
			},
		})

	default:
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
	}
}

func (a *App) handleAdminUserSubroutes(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 4 || parts[0] != "api" || parts[1] != "admin" || parts[2] != "users" {
		respondJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}

	userID, err := strconv.ParseInt(parts[3], 10, 64)
	if err != nil || userID <= 0 {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid user id"})
		return
	}

	switch r.Method {
	case http.MethodDelete:
		a.handleAdminDeleteUser(w, r, auth, userID)
	default:
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
	}
}

func (a *App) handleAdminDeleteUser(w http.ResponseWriter, r *http.Request, auth AuthContext, userID int64) {
	if auth.UserID == userID {
		respondJSON(w, http.StatusForbidden, map[string]any{"error": "cannot delete the current admin session user"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	var username string
	var role string
	err := a.db.QueryRowContext(ctx,
		`SELECT username, role FROM users WHERE id = $1`,
		userID,
	).Scan(&username, &role)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "user not found"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to load user"})
		return
	}
	if role == "admin" || username == a.adminUsername {
		respondJSON(w, http.StatusForbidden, map[string]any{"error": "admin user cannot be deleted"})
		return
	}

	var deletedID int64
	err = a.db.QueryRowContext(ctx,
		`DELETE FROM users WHERE id = $1 RETURNING id`,
		userID,
	).Scan(&deletedID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "user not found"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to delete user"})
		return
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"deleted": true,
		"userId":  deletedID,
	})
}
