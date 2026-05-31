package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// rejectAdminSelfService returns true (after writing a 403 response) when the
// authenticated principal is the deployment-pinned admin account. Admin
// username/password are owned by bootstrapAdminSecurity (which runs on every
// server start), so self-service changes would be reverted or could demote the
// admin. Both account endpoints must short-circuit before any DB access.
func (a *App) rejectAdminSelfService(w http.ResponseWriter, auth AuthContext) bool {
	if auth.Role == "admin" || auth.Username == a.adminUsername {
		respondJSON(w, http.StatusForbidden, map[string]any{"error": "管理员账号请通过部署配置修改"})
		return true
	}
	return false
}

func (a *App) accountResponse(auth AuthContext, username string) map[string]any {
	return map[string]any{
		"user": map[string]any{
			"id":       auth.UserID,
			"username": username,
			"role":     auth.Role,
		},
		"device": map[string]any{
			"deviceId":       auth.DeviceID,
			"deviceName":     auth.DeviceName,
			"sessionVersion": auth.DeviceSessionVersion,
			"lastSeenAt":     auth.DeviceLastSeenAt.UTC().Format(time.RFC3339Nano),
		},
	}
}

// reissueAccessAndCSRFCookies refreshes only the access and CSRF cookies after a
// username change, leaving the refresh token untouched. Refresh tokens are not
// username-bound and resolve the username from the DB at rotation time, so they
// remain valid. The HTTP auth middleware checks storedUsername == claims.Username,
// so a stale access cookie would 401 without this re-issue.
func (a *App) reissueAccessAndCSRFCookies(w http.ResponseWriter, r *http.Request, auth AuthContext, newUsername string) error {
	accessToken, err := a.issueToken(auth.UserID, newUsername, auth.Role, auth.DeviceID, auth.DeviceSessionVersion)
	if err != nil {
		return err
	}
	csrfToken, err := generateCSRFToken()
	if err != nil {
		return err
	}
	secure := isSecureRequest(r)
	currentRefresh := refreshTokenFromRequest(r)
	if currentRefresh != "" {
		setSessionCookies(
			w,
			accessToken,
			currentRefresh,
			csrfToken,
			secure,
			a.effectiveAccessTokenTTL(),
			a.effectiveRefreshTokenTTL(),
		)
		setDeviceCookie(w, auth.DeviceID, secure)
		return nil
	}

	// No refresh cookie present: set only the access and csrf cookies directly
	// so we never clobber the (absent) refresh token with an empty value.
	accessMaxAge := int(a.effectiveAccessTokenTTL().Seconds())
	if accessMaxAge < 1 {
		accessMaxAge = int((time.Duration(defaultAccessTokenMins) * time.Minute).Seconds())
	}
	csrfMaxAge := int(a.effectiveRefreshTokenTTL().Seconds())
	if csrfMaxAge < 1 {
		csrfMaxAge = int((time.Duration(defaultRefreshTokenHrs) * time.Hour).Seconds())
	}
	http.SetCookie(w, &http.Cookie{
		Name:     authCookieName,
		Value:    accessToken,
		Path:     "/",
		MaxAge:   accessMaxAge,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     csrfCookieName,
		Value:    csrfToken,
		Path:     "/",
		MaxAge:   csrfMaxAge,
		HttpOnly: false,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
	setDeviceCookie(w, auth.DeviceID, secure)
	return nil
}

func (a *App) handleAccountProfile(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	if r.Method != http.MethodPatch {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	if a.rejectAdminSelfService(w, auth) {
		return
	}

	var req struct {
		Username string `json:"username"`
	}
	if err := decodeJSON(r, &req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}

	newUsername := strings.TrimSpace(req.Username)
	if len(newUsername) < 3 || len(newUsername) > 32 {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "username length must be between 3 and 32"})
		return
	}
	if newUsername == a.adminUsername {
		respondJSON(w, http.StatusConflict, map[string]any{"error": "username already exists"})
		return
	}
	if newUsername == auth.Username {
		// No-op rename: keep the session intact and echo the current identity.
		respondJSON(w, http.StatusOK, a.accountResponse(auth, auth.Username))
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	result, err := a.db.ExecContext(ctx,
		`UPDATE users SET username = $1 WHERE id = $2 AND username = $3`,
		newUsername, auth.UserID, auth.Username,
	)
	if err != nil {
		if isUniqueViolation(err) {
			respondJSON(w, http.StatusConflict, map[string]any{"error": "username already exists"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to update username"})
		return
	}
	affected, err := result.RowsAffected()
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to update username"})
		return
	}
	if affected == 0 {
		respondJSON(w, http.StatusConflict, map[string]any{"error": "username already exists"})
		return
	}

	if err := a.reissueAccessAndCSRFCookies(w, r, auth, newUsername); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to refresh session"})
		return
	}

	respondJSON(w, http.StatusOK, a.accountResponse(auth, newUsername))
}

func (a *App) handleAccountPassword(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	if r.Method != http.MethodPost {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	if a.rejectAdminSelfService(w, auth) {
		return
	}

	var req struct {
		CurrentPassword string `json:"currentPassword"`
		NewPassword     string `json:"newPassword"`
	}
	if err := decodeJSON(r, &req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}

	if len(req.NewPassword) < 8 || len(req.NewPassword) > 128 {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "password length must be between 8 and 128"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	var currentHash string
	err := a.db.QueryRowContext(ctx,
		`SELECT password_hash FROM users WHERE id = $1`,
		auth.UserID,
	).Scan(&currentHash)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusUnauthorized, map[string]any{"error": "current password is incorrect"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to load account"})
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(currentHash), []byte(req.CurrentPassword)); err != nil {
		respondJSON(w, http.StatusUnauthorized, map[string]any{"error": "current password is incorrect"})
		return
	}

	newHash, err := bcrypt.GenerateFromPassword([]byte(req.NewPassword), bcrypt.DefaultCost)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to hash password"})
		return
	}

	// Apply the password change and the revocation of all OTHER sessions
	// atomically. Bumping the device session version invalidates other devices'
	// access tokens (validateDeviceClaim checks the version) and revoking their
	// refresh tokens stops silent re-issue. The current device is left intact so
	// the user is not logged out of the device that just changed the password.
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to update password"})
		return
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET password_hash = $1 WHERE id = $2`,
		string(newHash), auth.UserID,
	); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to update password"})
		return
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE user_devices
		    SET session_version = session_version + 1
		  WHERE user_id = $1 AND device_id <> $2 AND revoked_at IS NULL`,
		auth.UserID, auth.DeviceID,
	); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to revoke other sessions"})
		return
	}
	if _, err := tx.ExecContext(ctx,
		`UPDATE auth_refresh_tokens
		    SET revoked_at = NOW(), last_used_at = NOW()
		  WHERE user_id = $1 AND device_id <> $2 AND revoked_at IS NULL`,
		auth.UserID, auth.DeviceID,
	); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to revoke other sessions"})
		return
	}
	if err := tx.Commit(); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to update password"})
		return
	}

	respondJSON(w, http.StatusOK, map[string]any{"ok": true})
}
