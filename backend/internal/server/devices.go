package server

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"time"
)

const (
	deviceIDBytes             = 18
	deviceNameMaxLen          = 64
	deviceCookieTTL           = 365 * 24 * time.Hour
	deviceRecoverySessionName = "Recovered Device"
)

var (
	deviceIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{8,128}$`)
)

func normalizeDeviceID(value string) string {
	trimmed := strings.TrimSpace(value)
	if !deviceIDPattern.MatchString(trimmed) {
		return ""
	}
	return trimmed
}

func normalizeDeviceName(value string, fallback string) string {
	candidate := strings.TrimSpace(value)
	if candidate == "" {
		candidate = strings.TrimSpace(fallback)
	}
	if candidate == "" {
		candidate = defaultDeviceName
	}
	runes := []rune(candidate)
	if len(runes) > deviceNameMaxLen {
		candidate = string(runes[:deviceNameMaxLen])
	}
	return candidate
}

func buildDefaultDeviceName(r *http.Request) string {
	ua := strings.ToLower(strings.TrimSpace(r.UserAgent()))
	switch {
	case strings.Contains(ua, "iphone"), strings.Contains(ua, "ipad"), strings.Contains(ua, "ios"):
		return "iOS Device"
	case strings.Contains(ua, "android"):
		return "Android Device"
	case strings.Contains(ua, "windows"):
		return "Windows Device"
	case strings.Contains(ua, "macintosh"), strings.Contains(ua, "mac os"):
		return "Mac Device"
	case strings.Contains(ua, "linux"):
		return "Linux Device"
	default:
		return defaultDeviceName
	}
}

func generateDeviceID() (string, error) {
	raw := make([]byte, deviceIDBytes)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func deviceIDFromRequest(r *http.Request) string {
	cookie, err := r.Cookie(deviceCookieName)
	if err != nil {
		return ""
	}
	return normalizeDeviceID(cookie.Value)
}

func setDeviceCookie(w http.ResponseWriter, deviceID string, secure bool) {
	if normalizeDeviceID(deviceID) == "" {
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     deviceCookieName,
		Value:    deviceID,
		Path:     "/",
		MaxAge:   int(deviceCookieTTL.Seconds()),
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
}

type deviceRecord struct {
	UserID         int64
	DeviceID       string
	DeviceName     string
	SessionVersion int
	CreatedAt      time.Time
	LastSeenAt     time.Time
	RevokedAt      sql.NullTime
}

func (a *App) listUserDevices(ctx context.Context, userID int64) ([]deviceRecord, error) {
	rows, err := a.db.QueryContext(ctx, `
SELECT user_id, device_id, device_name, session_version, created_at, last_seen_at, revoked_at
FROM user_devices
WHERE user_id = $1
ORDER BY (revoked_at IS NULL) DESC, last_seen_at DESC, created_at DESC
`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	devices := make([]deviceRecord, 0, 8)
	for rows.Next() {
		var item deviceRecord
		if err := rows.Scan(
			&item.UserID,
			&item.DeviceID,
			&item.DeviceName,
			&item.SessionVersion,
			&item.CreatedAt,
			&item.LastSeenAt,
			&item.RevokedAt,
		); err != nil {
			return nil, err
		}
		devices = append(devices, item)
	}
	return devices, rows.Err()
}

func (a *App) loadActiveDevice(ctx context.Context, userID int64, deviceID string) (deviceRecord, error) {
	var device deviceRecord
	err := a.db.QueryRowContext(ctx, `
SELECT user_id, device_id, device_name, session_version, created_at, last_seen_at, revoked_at
FROM user_devices
WHERE user_id = $1
  AND device_id = $2
  AND revoked_at IS NULL
`, userID, deviceID).Scan(
		&device.UserID,
		&device.DeviceID,
		&device.DeviceName,
		&device.SessionVersion,
		&device.CreatedAt,
		&device.LastSeenAt,
		&device.RevokedAt,
	)
	if err != nil {
		return deviceRecord{}, err
	}
	return device, nil
}

func (a *App) touchDevice(ctx context.Context, userID int64, deviceID string) (deviceRecord, error) {
	var device deviceRecord
	err := a.db.QueryRowContext(ctx, `
UPDATE user_devices
SET last_seen_at = NOW()
WHERE user_id = $1
  AND device_id = $2
  AND revoked_at IS NULL
RETURNING user_id, device_id, device_name, session_version, created_at, last_seen_at, revoked_at
`, userID, deviceID).Scan(
		&device.UserID,
		&device.DeviceID,
		&device.DeviceName,
		&device.SessionVersion,
		&device.CreatedAt,
		&device.LastSeenAt,
		&device.RevokedAt,
	)
	if err != nil {
		return deviceRecord{}, err
	}
	return device, nil
}

func (a *App) upsertLoginDevice(
	ctx context.Context,
	userID int64,
	incomingDeviceID string,
	incomingDeviceName string,
) (deviceRecord, error) {
	deviceID := normalizeDeviceID(incomingDeviceID)
	if deviceID == "" {
		nextDeviceID, err := generateDeviceID()
		if err != nil {
			return deviceRecord{}, err
		}
		deviceID = nextDeviceID
	}
	deviceName := normalizeDeviceName(incomingDeviceName, defaultDeviceName)

	var device deviceRecord
	err := a.db.QueryRowContext(ctx, `
INSERT INTO user_devices(user_id, device_id, device_name, session_version, created_at, last_seen_at, revoked_at)
VALUES ($1, $2, $3, 1, NOW(), NOW(), NULL)
ON CONFLICT (user_id, device_id) DO UPDATE
SET device_name = CASE
        WHEN user_devices.revoked_at IS NULL THEN EXCLUDED.device_name
        ELSE user_devices.device_name
    END,
    last_seen_at = CASE
        WHEN user_devices.revoked_at IS NULL THEN NOW()
        ELSE user_devices.last_seen_at
    END
RETURNING user_id, device_id, device_name, session_version, created_at, last_seen_at, revoked_at
`, userID, deviceID, deviceName).Scan(
		&device.UserID,
		&device.DeviceID,
		&device.DeviceName,
		&device.SessionVersion,
		&device.CreatedAt,
		&device.LastSeenAt,
		&device.RevokedAt,
	)
	if err != nil {
		return deviceRecord{}, err
	}

	// Reuse of a revoked device id should transparently create a fresh device id.
	if device.RevokedAt.Valid {
		recoveryDeviceID, idErr := generateDeviceID()
		if idErr != nil {
			return deviceRecord{}, idErr
		}
		recoveryName := normalizeDeviceName(deviceRecoverySessionName, deviceName)
		err = a.db.QueryRowContext(ctx, `
INSERT INTO user_devices(user_id, device_id, device_name, session_version, created_at, last_seen_at, revoked_at)
VALUES ($1, $2, $3, 1, NOW(), NOW(), NULL)
RETURNING user_id, device_id, device_name, session_version, created_at, last_seen_at, revoked_at
`, userID, recoveryDeviceID, recoveryName).Scan(
			&device.UserID,
			&device.DeviceID,
			&device.DeviceName,
			&device.SessionVersion,
			&device.CreatedAt,
			&device.LastSeenAt,
			&device.RevokedAt,
		)
		if err != nil {
			return deviceRecord{}, err
		}
	}

	return device, nil
}

func (a *App) validateDeviceClaim(
	ctx context.Context,
	userID int64,
	deviceID string,
	deviceSessionVersion int,
) (deviceRecord, error) {
	normalizedDeviceID := normalizeDeviceID(deviceID)
	if normalizedDeviceID == "" || deviceSessionVersion <= 0 {
		return deviceRecord{}, errInvalidIdentity
	}
	device, err := a.touchDevice(ctx, userID, normalizedDeviceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return deviceRecord{}, errInvalidIdentity
		}
		return deviceRecord{}, err
	}
	if device.SessionVersion != deviceSessionVersion {
		return deviceRecord{}, errInvalidIdentity
	}
	return device, nil
}

func (a *App) renameUserDevice(
	ctx context.Context,
	userID int64,
	deviceID string,
	deviceName string,
) (deviceRecord, error) {
	normalizedDeviceID := normalizeDeviceID(deviceID)
	if normalizedDeviceID == "" {
		return deviceRecord{}, errInvalidIdentity
	}
	nextName := normalizeDeviceName(deviceName, defaultDeviceName)
	var device deviceRecord
	err := a.db.QueryRowContext(ctx, `
UPDATE user_devices
SET device_name = $3, last_seen_at = NOW()
WHERE user_id = $1
  AND device_id = $2
  AND revoked_at IS NULL
RETURNING user_id, device_id, device_name, session_version, created_at, last_seen_at, revoked_at
`, userID, normalizedDeviceID, nextName).Scan(
		&device.UserID,
		&device.DeviceID,
		&device.DeviceName,
		&device.SessionVersion,
		&device.CreatedAt,
		&device.LastSeenAt,
		&device.RevokedAt,
	)
	if err != nil {
		return deviceRecord{}, err
	}
	return device, nil
}

func (a *App) revokeUserDevice(ctx context.Context, userID int64, deviceID string) (deviceRecord, error) {
	normalizedDeviceID := normalizeDeviceID(deviceID)
	if normalizedDeviceID == "" {
		return deviceRecord{}, errInvalidIdentity
	}
	var device deviceRecord
	err := a.db.QueryRowContext(ctx, `
UPDATE user_devices
SET revoked_at = COALESCE(revoked_at, NOW()),
    session_version = session_version + 1,
    last_seen_at = NOW()
WHERE user_id = $1
  AND device_id = $2
RETURNING user_id, device_id, device_name, session_version, created_at, last_seen_at, revoked_at
`, userID, normalizedDeviceID).Scan(
		&device.UserID,
		&device.DeviceID,
		&device.DeviceName,
		&device.SessionVersion,
		&device.CreatedAt,
		&device.LastSeenAt,
		&device.RevokedAt,
	)
	if err != nil {
		return deviceRecord{}, err
	}
	return device, nil
}

func toDeviceSnapshot(record deviceRecord, currentDeviceID string) DeviceSnapshot {
	var revokedAt *string
	if record.RevokedAt.Valid {
		value := record.RevokedAt.Time.UTC().Format(time.RFC3339Nano)
		revokedAt = &value
	}
	return DeviceSnapshot{
		DeviceID:       record.DeviceID,
		DeviceName:     record.DeviceName,
		SessionVersion: record.SessionVersion,
		CreatedAt:      record.CreatedAt.UTC().Format(time.RFC3339Nano),
		LastSeenAt:     record.LastSeenAt.UTC().Format(time.RFC3339Nano),
		RevokedAt:      revokedAt,
		Current:        record.DeviceID == currentDeviceID,
	}
}

