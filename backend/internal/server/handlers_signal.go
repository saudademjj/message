package server

import (
	"context"
	"crypto/sha256"
	"crypto/sha512"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const maxOneTimePreKeysPerUpload = 512

func canonicalRawJSON(raw json.RawMessage) (json.RawMessage, error) {
	if len(raw) == 0 || !json.Valid(raw) {
		return nil, errors.New("invalid json")
	}
	var decoded any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		return nil, err
	}
	canonical, err := json.Marshal(decoded)
	if err != nil {
		return nil, err
	}
	return canonical, nil
}

func canonicalSignedPreKeyPayload(publicKeyJWK json.RawMessage) ([]byte, error) {
	parsed, err := parseJWKMap(publicKeyJWK)
	if err != nil {
		return nil, err
	}
	doc := map[string]any{
		"type":         "signal-signed-prekey",
		"publicKeyJwk": parsed,
	}
	return json.Marshal(doc)
}

func verifySignedPreKeySignature(signingPublicJWK, signedPreKeyPublicJWK json.RawMessage, signatureB64 string) error {
	canonical, err := canonicalSignedPreKeyPayload(signedPreKeyPublicJWK)
	if err != nil {
		return fmt.Errorf("invalid signed prekey payload: %w", err)
	}
	if err := verifyPayloadSignature(signingPublicJWK, canonical, signatureB64); err != nil {
		return fmt.Errorf("invalid signed prekey signature: %w", err)
	}
	return nil
}

func keyFingerprint(raw json.RawMessage) (string, error) {
	canonical, err := canonicalRawJSON(raw)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

func formatSafetyNumber(localUserID int64, localIdentityKey json.RawMessage, targetUserID int64, targetIdentityKey json.RawMessage) (string, error) {
	localCanonical, err := canonicalRawJSON(localIdentityKey)
	if err != nil {
		return "", err
	}
	targetCanonical, err := canonicalRawJSON(targetIdentityKey)
	if err != nil {
		return "", err
	}
	leftID := localUserID
	rightID := targetUserID
	leftKey := localCanonical
	rightKey := targetCanonical
	if localUserID > targetUserID {
		leftID = targetUserID
		rightID = localUserID
		leftKey = targetCanonical
		rightKey = localCanonical
	}
	material := []byte(fmt.Sprintf("%d|%d|", leftID, rightID))
	material = append(material, leftKey...)
	material = append(material, rightKey...)
	digest := sha512.Sum512(material)
	groups := make([]string, 0, 12)
	for i := 0; i < 12; i += 1 {
		offset := i * 5
		value :=
			(uint64(digest[offset]) << 32) |
				(uint64(digest[offset+1]) << 24) |
				(uint64(digest[offset+2]) << 16) |
				(uint64(digest[offset+3]) << 8) |
				(uint64(digest[offset+4]))
		groups = append(groups, fmt.Sprintf("%05d", value%100000))
	}
	return strings.Join(groups, " "), nil
}

func (a *App) ensureSharedRoom(ctx context.Context, leftUserID, rightUserID int64) error {
	if leftUserID == rightUserID {
		return nil
	}
	var found int
	return a.db.QueryRowContext(ctx, `
SELECT 1
FROM room_members rm_left
JOIN room_members rm_right ON rm_left.room_id = rm_right.room_id
WHERE rm_left.user_id = $1 AND rm_right.user_id = $2
LIMIT 1
`, leftUserID, rightUserID).Scan(&found)
}

func (a *App) handleSignalPreKeyBundle(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	switch r.Method {
	case http.MethodPut:
		a.handleSignalPreKeyBundleUpsert(w, r, auth)
	case http.MethodGet:
		a.handleSignalPreKeyBundleSelf(w, r, auth)
	default:
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
	}
}

func (a *App) handleSignalPreKeyBundleSubroutes(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 4 || parts[0] != "api" || parts[1] != "signal" || parts[2] != "prekey-bundle" {
		respondJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	if r.Method != http.MethodGet {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	targetUserID, err := strconv.ParseInt(parts[3], 10, 64)
	if err != nil || targetUserID <= 0 {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid user id"})
		return
	}
	a.handleSignalPreKeyBundleFetch(w, r, auth, targetUserID)
}

func (a *App) handleSignalSafetyNumberSubroutes(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 4 || parts[0] != "api" || parts[1] != "signal" || parts[2] != "safety-number" {
		respondJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	if r.Method != http.MethodGet {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	targetUserID, err := strconv.ParseInt(parts[3], 10, 64)
	if err != nil || targetUserID <= 0 {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid user id"})
		return
	}
	a.handleSignalSafetyNumber(w, r, auth, targetUserID)
}

func (a *App) handleSignalPreKeyBundleUpsert(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	var req SignalPreKeyBundleUpload
	if err := decodeJSON(r, &req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	if len(req.IdentityKeyJWK) == 0 || !json.Valid(req.IdentityKeyJWK) {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "identity key is required"})
		return
	}
	if len(req.IdentitySigningPubJWK) == 0 || !json.Valid(req.IdentitySigningPubJWK) {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "identity signing key is required"})
		return
	}
	if req.SignedPreKey.KeyID <= 0 || len(req.SignedPreKey.PublicKeyJWK) == 0 || !json.Valid(req.SignedPreKey.PublicKeyJWK) {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "signed prekey is required"})
		return
	}
	if strings.TrimSpace(req.SignedPreKey.Signature) == "" {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "signed prekey signature is required"})
		return
	}
	if len(req.OneTimePreKeys) > maxOneTimePreKeysPerUpload {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "too many one-time prekeys in one upload"})
		return
	}
	if err := verifySignedPreKeySignature(req.IdentitySigningPubJWK, req.SignedPreKey.PublicKeyJWK, req.SignedPreKey.Signature); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	for _, entry := range req.OneTimePreKeys {
		if entry.KeyID <= 0 || len(entry.PublicKeyJWK) == 0 || !json.Valid(entry.PublicKeyJWK) {
			respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid one-time prekey"})
			return
		}
	}
	fingerprint, err := keyFingerprint(req.IdentityKeyJWK)
	if err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid identity key format"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to begin transaction"})
		return
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx, `
INSERT INTO signal_identity_keys(user_id, identity_key_jwk, identity_signing_public_key_jwk, updated_at)
VALUES ($1, $2::jsonb, $3::jsonb, NOW())
ON CONFLICT (user_id) DO UPDATE
SET identity_key_jwk = EXCLUDED.identity_key_jwk,
    identity_signing_public_key_jwk = EXCLUDED.identity_signing_public_key_jwk,
    updated_at = NOW()
`, auth.UserID, req.IdentityKeyJWK, req.IdentitySigningPubJWK); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to upsert identity key"})
		return
	}

	if _, err := tx.ExecContext(ctx, `
INSERT INTO signal_identity_key_history(user_id, fingerprint, identity_key_jwk, first_seen_at, last_seen_at)
VALUES ($1, $2, $3::jsonb, NOW(), NOW())
ON CONFLICT (user_id, fingerprint) DO UPDATE
SET identity_key_jwk = EXCLUDED.identity_key_jwk,
    last_seen_at = NOW()
`, auth.UserID, fingerprint, req.IdentityKeyJWK); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to update identity history"})
		return
	}

	if _, err := tx.ExecContext(ctx, `
INSERT INTO signal_signed_prekeys(user_id, key_id, public_key_jwk, signature, updated_at)
VALUES ($1, $2, $3::jsonb, $4, NOW())
ON CONFLICT (user_id) DO UPDATE
SET key_id = EXCLUDED.key_id,
    public_key_jwk = EXCLUDED.public_key_jwk,
    signature = EXCLUDED.signature,
    updated_at = NOW()
`, auth.UserID, req.SignedPreKey.KeyID, req.SignedPreKey.PublicKeyJWK, req.SignedPreKey.Signature); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to upsert signed prekey"})
		return
	}

	if _, err := tx.ExecContext(ctx,
		`DELETE FROM signal_one_time_prekeys WHERE user_id = $1 AND consumed_at IS NULL`,
		auth.UserID,
	); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to reset one-time prekeys"})
		return
	}

	insertedOneTimePreKeys := 0
	for _, entry := range req.OneTimePreKeys {
		if _, err := tx.ExecContext(ctx, `
INSERT INTO signal_one_time_prekeys(user_id, key_id, public_key_jwk, created_at, consumed_at)
VALUES ($1, $2, $3::jsonb, NOW(), NULL)
ON CONFLICT (user_id, key_id) DO UPDATE
SET public_key_jwk = EXCLUDED.public_key_jwk,
    consumed_at = NULL,
    created_at = NOW()
`, auth.UserID, entry.KeyID, entry.PublicKeyJWK); err != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to upsert one-time prekeys"})
			return
		}
		insertedOneTimePreKeys += 1
	}

	if err := tx.Commit(); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to commit prekey upload"})
		return
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"ok":                  true,
		"userId":              auth.UserID,
		"signedPreKeyId":      req.SignedPreKey.KeyID,
		"uploadedOneTimeKeys": insertedOneTimePreKeys,
	})
}

func (a *App) handleSignalPreKeyBundleSelf(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	a.handleSignalPreKeyBundleFetchInternal(w, r, auth, auth.UserID, false)
}

func (a *App) handleSignalPreKeyBundleFetch(w http.ResponseWriter, r *http.Request, auth AuthContext, targetUserID int64) {
	a.handleSignalPreKeyBundleFetchInternal(w, r, auth, targetUserID, true)
}

func (a *App) handleSignalPreKeyBundleFetchInternal(
	w http.ResponseWriter,
	r *http.Request,
	auth AuthContext,
	targetUserID int64,
	consumeOneTimePreKey bool,
) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()

	if err := a.ensureSharedRoom(ctx, auth.UserID, targetUserID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusForbidden, map[string]any{"error": "target user is not in any shared room"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to validate room relationship"})
		return
	}

	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to begin transaction"})
		return
	}
	defer tx.Rollback()

	var response SignalPreKeyBundleResponse
	var identityUpdatedAt time.Time
	var signedPreKeyUpdatedAt time.Time
	err = tx.QueryRowContext(ctx, `
SELECT
  u.username,
  ik.identity_key_jwk,
  ik.identity_signing_public_key_jwk,
  ik.updated_at,
  sp.key_id,
  sp.public_key_jwk,
  sp.signature,
  sp.updated_at
FROM users u
JOIN signal_identity_keys ik ON ik.user_id = u.id
JOIN signal_signed_prekeys sp ON sp.user_id = u.id
WHERE u.id = $1
`, targetUserID).Scan(
		&response.Username,
		&response.IdentityKeyJWK,
		&response.IdentitySigningPubJWK,
		&identityUpdatedAt,
		&response.SignedPreKey.KeyID,
		&response.SignedPreKey.PublicKeyJWK,
		&response.SignedPreKey.Signature,
		&signedPreKeyUpdatedAt,
	)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "target user prekey bundle is not published"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to load target prekey bundle"})
		return
	}
	response.UserID = targetUserID

	if consumeOneTimePreKey {
		var oneTimePreKey SignalOneTimePreKey
		var createdAt time.Time
		err = tx.QueryRowContext(ctx, `
SELECT key_id, public_key_jwk, created_at
FROM signal_one_time_prekeys
WHERE user_id = $1 AND consumed_at IS NULL
ORDER BY key_id ASC
LIMIT 1
FOR UPDATE SKIP LOCKED
`, targetUserID).Scan(&oneTimePreKey.KeyID, &oneTimePreKey.PublicKeyJWK, &createdAt)
		if err == nil {
			now := time.Now().UTC()
			if _, execErr := tx.ExecContext(ctx, `
UPDATE signal_one_time_prekeys
SET consumed_at = $3
WHERE user_id = $1 AND key_id = $2
`, targetUserID, oneTimePreKey.KeyID, now); execErr != nil {
				respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to consume one-time prekey"})
				return
			}
			oneTimePreKey.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
			response.OneTimePreKey = &oneTimePreKey
		} else if !errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to load one-time prekey"})
			return
		}
	}

	if err := tx.Commit(); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to finalize prekey bundle fetch"})
		return
	}

	if signedPreKeyUpdatedAt.After(identityUpdatedAt) {
		response.UpdatedAt = signedPreKeyUpdatedAt.UTC().Format(time.RFC3339Nano)
	} else {
		response.UpdatedAt = identityUpdatedAt.UTC().Format(time.RFC3339Nano)
	}

	respondJSON(w, http.StatusOK, response)
}

func (a *App) handleSignalSafetyNumber(w http.ResponseWriter, r *http.Request, auth AuthContext, targetUserID int64) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()

	if err := a.ensureSharedRoom(ctx, auth.UserID, targetUserID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusForbidden, map[string]any{"error": "target user is not in any shared room"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to validate room relationship"})
		return
	}

	var localIdentityKey json.RawMessage
	var localUpdatedAt time.Time
	if err := a.db.QueryRowContext(ctx, `
SELECT identity_key_jwk, updated_at
FROM signal_identity_keys
WHERE user_id = $1
`, auth.UserID).Scan(&localIdentityKey, &localUpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "local identity key is not published"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to load local identity"})
		return
	}

	var targetIdentityKey json.RawMessage
	var targetUpdatedAt time.Time
	if err := a.db.QueryRowContext(ctx, `
SELECT identity_key_jwk, updated_at
FROM signal_identity_keys
WHERE user_id = $1
`, targetUserID).Scan(&targetIdentityKey, &targetUpdatedAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "target identity key is not published"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to load target identity"})
		return
	}

	safetyNumber, err := formatSafetyNumber(auth.UserID, localIdentityKey, targetUserID, targetIdentityKey)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to derive safety number"})
		return
	}
	localFingerprint, err := keyFingerprint(localIdentityKey)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to fingerprint local identity"})
		return
	}
	targetFingerprint, err := keyFingerprint(targetIdentityKey)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to fingerprint target identity"})
		return
	}

	type historyEntry struct {
		Fingerprint string `json:"fingerprint"`
		FirstSeenAt string `json:"firstSeenAt"`
		LastSeenAt  string `json:"lastSeenAt"`
	}
	history := make([]historyEntry, 0, 8)
	rows, err := a.db.QueryContext(ctx, `
SELECT fingerprint, first_seen_at, last_seen_at
FROM signal_identity_key_history
WHERE user_id = $1
ORDER BY first_seen_at DESC
LIMIT 20
`, targetUserID)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to load identity history"})
		return
	}
	defer rows.Close()
	for rows.Next() {
		var item historyEntry
		var firstSeenAt time.Time
		var lastSeenAt time.Time
		if err := rows.Scan(&item.Fingerprint, &firstSeenAt, &lastSeenAt); err != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to decode identity history"})
			return
		}
		item.FirstSeenAt = firstSeenAt.UTC().Format(time.RFC3339Nano)
		item.LastSeenAt = lastSeenAt.UTC().Format(time.RFC3339Nano)
		history = append(history, item)
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"localUserId":               auth.UserID,
		"targetUserId":              targetUserID,
		"localIdentityKeyJwk":       localIdentityKey,
		"targetIdentityKeyJwk":      targetIdentityKey,
		"localIdentityFingerprint":  localFingerprint,
		"targetIdentityFingerprint": targetFingerprint,
		"localIdentityUpdatedAt":    localUpdatedAt.UTC().Format(time.RFC3339Nano),
		"targetIdentityUpdatedAt":   targetUpdatedAt.UTC().Format(time.RFC3339Nano),
		"safetyNumber":              safetyNumber,
		"targetHistory":             history,
	})
}
