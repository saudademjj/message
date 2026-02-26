package server

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"strings"
	"time"
)

const refreshTokenRawBytes = 48

var (
	errRefreshTokenInvalid = errors.New("invalid refresh token")
	errRefreshTokenExpired = errors.New("refresh token expired")
)

func generateRefreshToken() (string, error) {
	raw := make([]byte, refreshTokenRawBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func hashRefreshToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func normalizeRefreshToken(token string) string {
	return strings.TrimSpace(token)
}

func (a *App) effectiveRefreshTokenTTL() time.Duration {
	if a.refreshTokenTTL > 0 {
		return a.refreshTokenTTL
	}
	return time.Duration(defaultRefreshTokenHrs) * time.Hour
}

func (a *App) effectiveAccessTokenTTL() time.Duration {
	if a.accessTokenTTL > 0 {
		return a.accessTokenTTL
	}
	return time.Duration(defaultAccessTokenMins) * time.Minute
}

func (a *App) issueRefreshToken(
	ctx context.Context,
	userID int64,
	deviceID string,
	deviceSessionVersion int,
) (string, error) {
	if userID <= 0 || normalizeDeviceID(deviceID) == "" || deviceSessionVersion <= 0 {
		return "", errRefreshTokenInvalid
	}
	token, err := generateRefreshToken()
	if err != nil {
		return "", err
	}
	hashed := hashRefreshToken(token)
	now := time.Now().UTC()
	expiresAt := now.Add(a.effectiveRefreshTokenTTL())
	if _, err := a.db.ExecContext(
		ctx,
		`INSERT INTO auth_refresh_tokens(user_id, device_id, device_session_version, token_hash, expires_at, created_at, last_used_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $6)`,
		userID,
		deviceID,
		deviceSessionVersion,
		hashed,
		expiresAt,
		now,
	); err != nil {
		return "", err
	}
	return token, nil
}

func (a *App) rotateRefreshToken(ctx context.Context, presentedToken string) (AuthContext, string, error) {
	token := normalizeRefreshToken(presentedToken)
	if token == "" {
		return AuthContext{}, "", errRefreshTokenInvalid
	}

	tx, err := a.db.BeginTx(ctx, &sql.TxOptions{})
	if err != nil {
		return AuthContext{}, "", err
	}
	defer tx.Rollback()

	now := time.Now().UTC()
	hashed := hashRefreshToken(token)
	var tokenID int64
	var userID int64
	var deviceID string
	var tokenDeviceSessionVersion int
	var expiresAt time.Time
	var revokedAt sql.NullTime
	err = tx.QueryRowContext(
		ctx,
		`SELECT id, user_id, device_id, device_session_version, expires_at, revoked_at
		   FROM auth_refresh_tokens
		  WHERE token_hash = $1
		  FOR UPDATE`,
		hashed,
	).Scan(&tokenID, &userID, &deviceID, &tokenDeviceSessionVersion, &expiresAt, &revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthContext{}, "", errRefreshTokenInvalid
	}
	if err != nil {
		return AuthContext{}, "", err
	}
	if revokedAt.Valid {
		return AuthContext{}, "", errRefreshTokenInvalid
	}
	if normalizeDeviceID(deviceID) == "" || tokenDeviceSessionVersion <= 0 {
		return AuthContext{}, "", errRefreshTokenInvalid
	}
	if !expiresAt.After(now) {
		_, _ = tx.ExecContext(
			ctx,
			`UPDATE auth_refresh_tokens
			    SET revoked_at = $2, last_used_at = $2
			  WHERE id = $1 AND revoked_at IS NULL`,
			tokenID,
			now,
		)
		return AuthContext{}, "", errRefreshTokenExpired
	}

	if _, err := tx.ExecContext(
		ctx,
		`UPDATE auth_refresh_tokens
		    SET revoked_at = $2, last_used_at = $2
		  WHERE id = $1 AND revoked_at IS NULL`,
		tokenID,
		now,
	); err != nil {
		return AuthContext{}, "", err
	}

	var username string
	var role string
	err = tx.QueryRowContext(
		ctx,
		`SELECT username, role FROM users WHERE id = $1`,
		userID,
	).Scan(&username, &role)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthContext{}, "", errRefreshTokenInvalid
	}
	if err != nil {
		return AuthContext{}, "", err
	}
	if role != "admin" && role != "user" {
		return AuthContext{}, "", errRefreshTokenInvalid
	}

	var deviceName string
	var currentDeviceSessionVersion int
	var lastSeenAt time.Time
	var deviceRevokedAt sql.NullTime
	err = tx.QueryRowContext(
		ctx,
		`SELECT device_name, session_version, last_seen_at, revoked_at
		   FROM user_devices
		  WHERE user_id = $1 AND device_id = $2
		  FOR UPDATE`,
		userID,
		deviceID,
	).Scan(&deviceName, &currentDeviceSessionVersion, &lastSeenAt, &deviceRevokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthContext{}, "", errRefreshTokenInvalid
	}
	if err != nil {
		return AuthContext{}, "", err
	}
	if deviceRevokedAt.Valid || currentDeviceSessionVersion != tokenDeviceSessionVersion {
		return AuthContext{}, "", errRefreshTokenInvalid
	}

	if _, err := tx.ExecContext(
		ctx,
		`UPDATE user_devices
		    SET last_seen_at = $3
		  WHERE user_id = $1 AND device_id = $2`,
		userID,
		deviceID,
		now,
	); err != nil {
		return AuthContext{}, "", err
	}

	newToken, err := generateRefreshToken()
	if err != nil {
		return AuthContext{}, "", err
	}
	newHashed := hashRefreshToken(newToken)
	newExpiresAt := now.Add(a.effectiveRefreshTokenTTL())
	if _, err := tx.ExecContext(
		ctx,
		`INSERT INTO auth_refresh_tokens(user_id, device_id, device_session_version, token_hash, expires_at, created_at, last_used_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $6)`,
		userID,
		deviceID,
		currentDeviceSessionVersion,
		newHashed,
		newExpiresAt,
		now,
	); err != nil {
		return AuthContext{}, "", err
	}

	if err := tx.Commit(); err != nil {
		return AuthContext{}, "", err
	}

	return AuthContext{
		UserID:               userID,
		Username:             username,
		Role:                 role,
		DeviceID:             deviceID,
		DeviceName:           deviceName,
		DeviceSessionVersion: currentDeviceSessionVersion,
		DeviceLastSeenAt:     now,
	}, newToken, nil
}

func (a *App) revokeRefreshToken(ctx context.Context, presentedToken string) error {
	token := normalizeRefreshToken(presentedToken)
	if token == "" {
		return nil
	}
	hashed := hashRefreshToken(token)
	now := time.Now().UTC()
	_, err := a.db.ExecContext(
		ctx,
		`UPDATE auth_refresh_tokens
		    SET revoked_at = $2, last_used_at = $2
		  WHERE token_hash = $1 AND revoked_at IS NULL`,
		hashed,
		now,
	)
	return err
}

func (a *App) revokeRefreshTokensForDevice(ctx context.Context, userID int64, deviceID string) error {
	if userID <= 0 || normalizeDeviceID(deviceID) == "" {
		return nil
	}
	now := time.Now().UTC()
	_, err := a.db.ExecContext(
		ctx,
		`UPDATE auth_refresh_tokens
		    SET revoked_at = $3, last_used_at = $3
		  WHERE user_id = $1 AND device_id = $2 AND revoked_at IS NULL`,
		userID,
		deviceID,
		now,
	)
	return err
}
