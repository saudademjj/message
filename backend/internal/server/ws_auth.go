package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"time"
)

func (a *App) authenticateWebSocketRequest(r *http.Request) (AuthContext, int, string) {
	tokenString, _ := authTokenFromRequest(r)
	if tokenString == "" {
		return AuthContext{}, http.StatusUnauthorized, "authorization required"
	}
	claims, err := a.parseToken(tokenString)
	if err != nil {
		return AuthContext{}, http.StatusUnauthorized, "invalid token"
	}
	if claims.ExpiresAt == nil {
		return AuthContext{}, http.StatusUnauthorized, "invalid token"
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	role, err := a.ensureUserIdentity(ctx, claims.UserID, claims.Username)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, errInvalidIdentity) {
			return AuthContext{}, http.StatusUnauthorized, "authorization required"
		}
		return AuthContext{}, http.StatusInternalServerError, "failed to validate identity"
	}
	if role != claims.Role {
		return AuthContext{}, http.StatusUnauthorized, "token role mismatch"
	}
	device, err := a.validateDeviceClaim(ctx, claims.UserID, claims.DeviceID, claims.DeviceSessionVersion)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, errInvalidIdentity) {
			return AuthContext{}, http.StatusUnauthorized, "device session expired"
		}
		return AuthContext{}, http.StatusInternalServerError, "failed to validate device session"
	}
	return AuthContext{
		UserID:               claims.UserID,
		Username:             claims.Username,
		Role:                 role,
		DeviceID:             device.DeviceID,
		DeviceName:           device.DeviceName,
		DeviceSessionVersion: device.SessionVersion,
		DeviceLastSeenAt:     device.LastSeenAt,
		TokenExpiresAt:       claims.ExpiresAt.Time,
	}, http.StatusOK, ""
}
