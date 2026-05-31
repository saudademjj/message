package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"
)

func (a *App) storeMessage(ctx context.Context, roomID, senderID int64, payload CipherPayload) (int64, time.Time, error) {
	if err := validateCipherPayloadRecipientsForRoom(ctx, a.db, roomID, payload); err != nil {
		return 0, time.Time{}, err
	}
	storedPayload := scrubPayloadForStorage(payload)
	payloadJSON, err := json.Marshal(storedPayload)
	if err != nil {
		return 0, time.Time{}, err
	}

	var messageID int64
	var createdAt time.Time
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, time.Time{}, err
	}
	defer tx.Rollback()

	err = tx.QueryRowContext(ctx, `
INSERT INTO messages(room_id, sender_id, payload)
VALUES ($1, $2, $3)
RETURNING id, created_at
`, roomID, senderID, payloadJSON).Scan(&messageID, &createdAt)
	if err != nil {
		return 0, time.Time{}, err
	}

	if err := insertDeviceEnvelopes(ctx, tx, messageID, roomID, payload); err != nil {
		return 0, time.Time{}, err
	}
	if err := tx.Commit(); err != nil {
		return 0, time.Time{}, err
	}

	return messageID, createdAt, nil
}

func scrubPayloadForStorage(payload CipherPayload) CipherPayload {
	if payload.Version < 4 {
		return payload
	}
	payload.WrappedKeys = map[string]WrappedKey{}
	return payload
}

func splitRecipientAddress(address string) (int64, string, error) {
	parts := strings.SplitN(strings.TrimSpace(address), ":", 2)
	if len(parts) != 2 {
		return 0, "", fmt.Errorf("invalid recipient address %q", address)
	}
	userID, err := strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
	if err != nil || userID <= 0 {
		return 0, "", fmt.Errorf("invalid recipient user in address %q", address)
	}
	deviceID := normalizeDeviceID(parts[1])
	if deviceID == "" {
		return 0, "", fmt.Errorf("invalid recipient device in address %q", address)
	}
	return userID, deviceID, nil
}

func validateCipherPayloadRecipientsForRoom(ctx context.Context, db *sql.DB, roomID int64, payload CipherPayload) error {
	for address := range payload.WrappedKeys {
		recipientUserID, recipientDeviceID, err := splitRecipientAddress(address)
		if err != nil {
			return err
		}
		var found int
		if err := db.QueryRowContext(ctx, `
SELECT 1
FROM room_members rm
JOIN user_devices d
  ON d.user_id = rm.user_id
 AND d.device_id = $3
 AND d.revoked_at IS NULL
WHERE rm.room_id = $1
  AND rm.user_id = $2
`, roomID, recipientUserID, recipientDeviceID).Scan(&found); err != nil {
			return fmt.Errorf("recipient %s is not an active room member device: %w", address, err)
		}
	}
	return nil
}

func insertDeviceEnvelopes(ctx context.Context, tx *sql.Tx, messageID, roomID int64, payload CipherPayload) error {
	senderDeviceID := normalizeDeviceID(payload.SenderDeviceID)
	if senderDeviceID == "" {
		senderDeviceID = "unknown"
	}
	for address, wrappedKey := range payload.WrappedKeys {
		recipientUserID, recipientDeviceID, err := splitRecipientAddress(address)
		if err != nil {
			return err
		}
		wrappedJSON, err := json.Marshal(wrappedKey)
		if err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `
INSERT INTO chat_mailbox.device_envelopes(
    message_id,
    room_id,
    recipient_user_id,
    recipient_device_id,
    wrapped_key,
    sender_device_id,
    created_at
)
VALUES ($1, $2, $3, $4, $5::jsonb, $6, NOW())
ON CONFLICT (message_id, recipient_user_id, recipient_device_id) DO UPDATE
SET wrapped_key = EXCLUDED.wrapped_key,
    sender_device_id = EXCLUDED.sender_device_id
`, messageID, roomID, recipientUserID, recipientDeviceID, wrappedJSON, senderDeviceID); err != nil {
			return err
		}
	}
	return nil
}

func payloadForRecipient(payload CipherPayload, recipientUserID int64, recipientDeviceID string, envelopeRaw []byte) CipherPayload {
	if len(envelopeRaw) == 0 {
		if payload.Version >= 4 {
			payload.WrappedKeys = map[string]WrappedKey{}
		}
		return payload
	}
	var wrapped WrappedKey
	if err := json.Unmarshal(envelopeRaw, &wrapped); err != nil {
		return payload
	}
	address := fmt.Sprintf("%d:%s", recipientUserID, recipientDeviceID)
	payload.WrappedKeys = map[string]WrappedKey{address: wrapped}
	return payload
}

func mustMarshalWrappedKeyForTarget(payload CipherPayload, recipientUserID int64, recipientDeviceID string) []byte {
	address := fmt.Sprintf("%d:%s", recipientUserID, recipientDeviceID)
	wrapped, ok := payload.WrappedKeys[address]
	if !ok {
		return nil
	}
	raw, err := json.Marshal(wrapped)
	if err != nil {
		return nil
	}
	return raw
}

// senderEchoPayload builds a copy of payload destined for one of the message
// sender's OWN devices (identified by targetUserID:targetDeviceID, where
// targetUserID == senderUserID). The target device's own address keeps its real
// wrapped key (so that device — whether the originating device or a sibling
// device of the same account — can decrypt the message), while every OTHER
// recipient address is reduced to an empty WrappedKey{} placeholder. The
// frontend only reads the KEYS of WrappedKeys to count distinct recipient
// userIDs (the "expected readers" of the sender's own message), so the
// placeholders restore the read-indicator behavior without leaking other
// devices' wrapped keys.
//
// This must be parameterized by the target device (not a single fixed sender
// device): all of the sender's devices receive an "own" copy, and each sibling
// device that is a legitimate recipient needs ITS real wrapped key preserved —
// otherwise sibling devices cannot decrypt live messages.
func senderEchoPayload(payload CipherPayload, targetUserID int64, targetDeviceID string) CipherPayload {
	targetAddress := fmt.Sprintf("%d:%s", targetUserID, normalizeDeviceID(targetDeviceID))
	echoed := make(map[string]WrappedKey, len(payload.WrappedKeys))
	for address, wrapped := range payload.WrappedKeys {
		if address == targetAddress {
			echoed[address] = wrapped
			continue
		}
		echoed[address] = WrappedKey{}
	}
	payload.WrappedKeys = echoed
	return payload
}

// recipientAddressesForMessages fetches the distinct recipient device addresses
// (formatted "userID:deviceID") for each of the given message IDs from the
// device_envelopes table. It is used to reconstruct the full recipient set on a
// sender's own message copies so the frontend can count expected readers. The
// returned map is keyed by message ID. Empty input short-circuits with no query.
func recipientAddressesForMessages(ctx context.Context, db *sql.DB, messageIDs []int64) (map[int64][]string, error) {
	result := make(map[int64][]string, len(messageIDs))
	if len(messageIDs) == 0 {
		return result, nil
	}
	placeholders := make([]string, 0, len(messageIDs))
	args := make([]any, 0, len(messageIDs))
	for index, messageID := range messageIDs {
		placeholders = append(placeholders, fmt.Sprintf("$%d", index+1))
		args = append(args, messageID)
	}
	query := fmt.Sprintf(`
SELECT DISTINCT message_id, recipient_user_id, recipient_device_id
FROM chat_mailbox.device_envelopes
WHERE message_id IN (%s)
`, strings.Join(placeholders, ", "))
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var messageID int64
		var recipientUserID int64
		var recipientDeviceID string
		if err := rows.Scan(&messageID, &recipientUserID, &recipientDeviceID); err != nil {
			return nil, err
		}
		address := fmt.Sprintf("%d:%s", recipientUserID, recipientDeviceID)
		result[messageID] = append(result[messageID], address)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return result, nil
}

func (a *App) updateMessagePayload(ctx context.Context, messageID, roomID, senderID int64, payload CipherPayload) (time.Time, error) {
	if err := validateCipherPayloadRecipientsForRoom(ctx, a.db, roomID, payload); err != nil {
		return time.Time{}, err
	}
	storedPayload := scrubPayloadForStorage(payload)
	payloadJSON, err := json.Marshal(storedPayload)
	if err != nil {
		return time.Time{}, err
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return time.Time{}, err
	}
	defer tx.Rollback()

	var editedAt time.Time
	err = tx.QueryRowContext(ctx,
		`UPDATE messages
			 SET payload = $1::jsonb, edited_at = NOW(), revoked_at = NULL
			 WHERE id = $2 AND room_id = $3 AND sender_id = $4
			 RETURNING edited_at`,
		payloadJSON, messageID, roomID, senderID,
	).Scan(&editedAt)
	if err != nil {
		return time.Time{}, err
	}
	if _, err := tx.ExecContext(ctx, `
DELETE FROM chat_mailbox.device_envelopes
WHERE message_id = $1
`, messageID); err != nil {
		return time.Time{}, err
	}
	if err := insertDeviceEnvelopes(ctx, tx, messageID, roomID, payload); err != nil {
		return time.Time{}, err
	}
	if err := tx.Commit(); err != nil {
		return time.Time{}, err
	}
	return editedAt, nil
}

func markEnvelopeDelivered(ctx context.Context, db *sql.DB, userID int64, deviceID string, messageIDs []int64) {
	if len(messageIDs) == 0 || normalizeDeviceID(deviceID) == "" {
		return
	}
	for _, messageID := range messageIDs {
		if messageID <= 0 {
			continue
		}
		_, _ = db.ExecContext(ctx, `
UPDATE chat_mailbox.device_envelopes
SET delivered_at = COALESCE(delivered_at, NOW())
WHERE recipient_user_id = $1
  AND recipient_device_id = $2
  AND message_id = $3
`, userID, deviceID, messageID)
	}
}

func (a *App) listMissingEnvelopeMessages(
	ctx context.Context,
	userID int64,
	deviceID string,
	roomID int64,
	messageIDs []int64,
) ([]int64, error) {
	if normalizeDeviceID(deviceID) == "" {
		return nil, errInvalidIdentity
	}
	seen := make(map[int64]struct{}, len(messageIDs))
	ids := make([]int64, 0, len(messageIDs))
	for _, messageID := range messageIDs {
		if messageID <= 0 {
			continue
		}
		if _, ok := seen[messageID]; ok {
			continue
		}
		seen[messageID] = struct{}{}
		ids = append(ids, messageID)
	}
	if len(ids) == 0 {
		rows, err := a.db.QueryContext(ctx, `
SELECT m.id
FROM messages m
JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $2
LEFT JOIN chat_mailbox.device_envelopes e
  ON e.message_id = m.id
 AND e.recipient_user_id = $2
 AND e.recipient_device_id = $3
WHERE m.room_id = $1
  AND m.sender_id = $2
  AND e.message_id IS NULL
ORDER BY m.id DESC
LIMIT 200
`, roomID, userID, deviceID)
		if err != nil {
			return nil, err
		}
		defer rows.Close()
		for rows.Next() {
			var messageID int64
			if err := rows.Scan(&messageID); err != nil {
				return nil, err
			}
			ids = append(ids, messageID)
		}
		if err := rows.Err(); err != nil {
			return nil, err
		}
	}
	missing := make([]int64, 0, len(ids))
	for _, messageID := range ids {
		var found int
		err := a.db.QueryRowContext(ctx, `
SELECT 1
FROM messages m
JOIN room_members rm ON rm.room_id = m.room_id AND rm.user_id = $2
LEFT JOIN chat_mailbox.device_envelopes e
  ON e.message_id = m.id
 AND e.recipient_user_id = $2
 AND e.recipient_device_id = $3
WHERE m.id = $1
  AND m.room_id = $4
  AND (m.sender_id = $2 OR $5::BOOLEAN)
  AND e.message_id IS NULL
`, messageID, userID, deviceID, roomID, len(messageIDs) > 0).Scan(&found)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return nil, err
		}
		missing = append(missing, messageID)
	}
	return missing, nil
}

func (a *App) storeDeviceEnvelopeRefill(
	ctx context.Context,
	userID int64,
	deviceID string,
	roomID int64,
	senderUserID int64,
	senderDeviceID string,
	envelopes []DeviceEnvelopeRefillEntry,
) (int, error) {
	normalizedDeviceID := normalizeDeviceID(deviceID)
	normalizedSenderDeviceID := normalizeDeviceID(senderDeviceID)
	if normalizedDeviceID == "" || normalizedSenderDeviceID == "" {
		return 0, errInvalidIdentity
	}
	seen := make(map[int64]struct{}, len(envelopes))
	inserted := 0
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	for _, envelope := range envelopes {
		if envelope.MessageID <= 0 {
			continue
		}
		if _, ok := seen[envelope.MessageID]; ok {
			continue
		}
		seen[envelope.MessageID] = struct{}{}
		if envelope.WrappedKey.IV == "" || envelope.WrappedKey.WrappedKey == "" {
			return 0, errInvalidPayloadFormat
		}
		address := fmt.Sprintf("%d:%s", userID, normalizedDeviceID)
		if envelope.WrappedKey.RecipientAAD != "" && envelope.WrappedKey.RecipientAAD != address {
			return 0, errInvalidPayloadFormat
		}
		wrappedJSON, err := json.Marshal(envelope.WrappedKey)
		if err != nil {
			return 0, err
		}
		result, err := tx.ExecContext(ctx, `
INSERT INTO chat_mailbox.device_envelopes(
    message_id,
    room_id,
    recipient_user_id,
    recipient_device_id,
    wrapped_key,
    sender_device_id,
    created_at
)
SELECT m.id, m.room_id, $3, $4, $5::jsonb, $6, NOW()
FROM messages m
WHERE m.id = $1
  AND m.room_id = $2
  AND m.sender_id = $7
ON CONFLICT (message_id, recipient_user_id, recipient_device_id) DO UPDATE
SET wrapped_key = EXCLUDED.wrapped_key,
    sender_device_id = EXCLUDED.sender_device_id
`, envelope.MessageID, roomID, userID, normalizedDeviceID, wrappedJSON, normalizedSenderDeviceID, senderUserID)
		if err != nil {
			return 0, err
		}
		if rows, err := result.RowsAffected(); err == nil && rows > 0 {
			inserted++
		}
	}

	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return inserted, nil
}

func (a *App) ensureRoomExists(ctx context.Context, roomID int64) error {
	var found int64
	return a.db.QueryRowContext(ctx, `SELECT id FROM rooms WHERE id = $1`, roomID).Scan(&found)
}

func (a *App) ensureMembership(ctx context.Context, userID, roomID int64) error {
	var found int
	return a.db.QueryRowContext(ctx,
		`SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2`,
		roomID, userID,
	).Scan(&found)
}

func (a *App) ensureUserIdentity(ctx context.Context, userID int64, username string) (string, error) {
	var storedUsername string
	var role string
	err := a.db.QueryRowContext(ctx,
		`SELECT username, role FROM users WHERE id = $1`,
		userID,
	).Scan(&storedUsername, &role)
	if err != nil {
		return "", err
	}
	if storedUsername != username {
		return "", errInvalidIdentity
	}
	if role != "admin" && role != "user" {
		return "", errInvalidIdentity
	}
	return role, nil
}
