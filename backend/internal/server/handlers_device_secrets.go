package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"
)

const maxDeviceSecretBlobBytes = 1 << 20

func (a *App) handleDeviceSecretBlob(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	switch r.Method {
	case http.MethodGet:
		a.handleGetDeviceSecretBlob(w, r, auth)
	case http.MethodPut:
		a.handlePutDeviceSecretBlob(w, r, auth)
	default:
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
	}
}

func validateDeviceSecretBlob(blob DeviceSecretBlob) error {
	if blob.BlobVersion <= 0 {
		return errors.New("blobVersion is required")
	}
	if strings.TrimSpace(blob.KDFSalt) == "" {
		return errors.New("kdfSalt is required")
	}
	if len(blob.EncryptedBlob) == 0 || !json.Valid(blob.EncryptedBlob) {
		return errors.New("encryptedBlob must be valid json")
	}
	if len(blob.EncryptedBlob) > maxDeviceSecretBlobBytes {
		return errors.New("encryptedBlob is too large")
	}
	return nil
}

func (a *App) handleGetDeviceSecretBlob(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	var blob DeviceSecretBlob
	var updatedAt time.Time
	err := a.db.QueryRowContext(ctx, `
SELECT blob_version, kdf_salt, recovery_hint, encrypted_blob, updated_at
FROM chat_mailbox.device_secret_blobs
WHERE user_id = $1 AND device_id = $2
`, auth.UserID, auth.DeviceID).Scan(
		&blob.BlobVersion,
		&blob.KDFSalt,
		&blob.RecoveryHint,
		&blob.EncryptedBlob,
		&updatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "device secret backup not found"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to load device secret backup"})
		return
	}
	blob.UpdatedAt = updatedAt.UTC().Format(time.RFC3339Nano)
	respondJSON(w, http.StatusOK, map[string]any{"backup": blob})
}

func (a *App) handlePutDeviceSecretBlob(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	var req DeviceSecretBlob
	if err := decodeJSON(r, &req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	req.KDFSalt = strings.TrimSpace(req.KDFSalt)
	req.RecoveryHint = strings.TrimSpace(req.RecoveryHint)
	if err := validateDeviceSecretBlob(req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if _, err := a.loadActiveDevice(ctx, auth.UserID, auth.DeviceID); err != nil {
		respondJSON(w, http.StatusForbidden, map[string]any{"error": "device is not active"})
		return
	}
	_, err := a.db.ExecContext(ctx, `
INSERT INTO chat_mailbox.device_secret_blobs(user_id, device_id, blob_version, kdf_salt, recovery_hint, encrypted_blob, updated_at)
VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
ON CONFLICT (user_id, device_id) DO UPDATE
SET blob_version = EXCLUDED.blob_version,
    kdf_salt = EXCLUDED.kdf_salt,
    recovery_hint = EXCLUDED.recovery_hint,
    encrypted_blob = EXCLUDED.encrypted_blob,
    updated_at = NOW()
`, auth.UserID, auth.DeviceID, req.BlobVersion, req.KDFSalt, req.RecoveryHint, req.EncryptedBlob)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to save device secret backup"})
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"ok": true})
}
