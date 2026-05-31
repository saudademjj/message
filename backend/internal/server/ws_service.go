package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

var (
	errLegacyPayloadVersion = errors.New("legacy payload version is not supported")
	errInvalidPayloadFormat = errors.New("invalid payload format")
)

const (
	protocolErrorLegacyPayload = "legacy_payload_not_supported"
	protocolErrorInvalidFormat = "invalid_payload_format"
	protocolErrorRateLimited   = "ciphertext_rate_limited"
	protocolErrorAuthExpired   = "websocket_auth_expired"
)

func validWrappedRecipientAddress(recipientID string) bool {
	parts := strings.SplitN(strings.TrimSpace(recipientID), ":", 2)
	if len(parts) != 2 {
		return false
	}
	userID, err := strconv.ParseInt(strings.TrimSpace(parts[0]), 10, 64)
	if err != nil || userID <= 0 {
		return false
	}
	return normalizeDeviceID(parts[1]) != ""
}

func validateV3CipherPayload(payload CipherPayload) error {
	if payload.Version < 3 {
		return errLegacyPayloadVersion
	}
	if strings.TrimSpace(payload.EncryptionScheme) != "DOUBLE_RATCHET_V1" {
		return fmt.Errorf("%w: unsupported encryption scheme", errInvalidPayloadFormat)
	}
	if len(payload.WrappedKeys) == 0 {
		return fmt.Errorf("%w: wrapped keys are required", errInvalidPayloadFormat)
	}
	for recipientID := range payload.WrappedKeys {
		if !validWrappedRecipientAddress(recipientID) {
			return fmt.Errorf("%w: invalid recipient address %q", errInvalidPayloadFormat, recipientID)
		}
	}
	return nil
}

// allowResyncRouting decides whether a decrypt_recovery_request /
// decrypt_recovery_payload frame may be forwarded between (requesterUserID,
// requesterDeviceID) and (targetUserID, targetDeviceID).
//
// Same-user cross-device requests are allowed (so a user's secondary device
// can ask the device that originally sent the message to retransmit), but
// same-user same-device requests are rejected because they would loop back to
// the requester itself. Different users always pass.
func allowResyncRouting(
	requesterUserID int64,
	requesterDeviceID string,
	targetUserID int64,
	targetDeviceID string,
) bool {
	if requesterUserID <= 0 || targetUserID <= 0 {
		return false
	}
	if requesterUserID != targetUserID {
		return true
	}
	requesterDevice := normalizeDeviceID(requesterDeviceID)
	targetDevice := normalizeDeviceID(targetDeviceID)
	if requesterDevice == "" {
		return false
	}
	// Empty target device implies "broadcast to all of this user's devices",
	// which would include the requester itself — disallow that for self-user.
	if targetDevice == "" {
		return false
	}
	return requesterDevice != targetDevice
}

func protocolErrorFromValidation(err error) (code string, message string) {
	if errors.Is(err, errLegacyPayloadVersion) {
		return protocolErrorLegacyPayload, "检测到旧版密文协议，当前仅支持 V3。请刷新页面升级客户端后重试。"
	}
	return protocolErrorInvalidFormat, "密文格式非法或不完整，请刷新页面后重试。"
}

func (c *Client) sendProtocolError(code string, message string) {
	frame := ProtocolErrorFrame{
		Type:    "protocol_error",
		RoomID:  c.roomID,
		Code:    code,
		Message: message,
	}
	payload, err := json.Marshal(frame)
	if err != nil {
		return
	}
	select {
	case c.send <- payload:
	default:
		logger.Warn(
			"websocket_protocol_error_drop",
			"user_id",
			c.userID,
			"room_id",
			c.roomID,
			"reason",
			"send queue full",
		)
	}
}

func (c *Client) rejectInvalidPayload(frameType string, validationErr error) {
	code, message := protocolErrorFromValidation(validationErr)
	logger.Warn(
		"drop_legacy_or_invalid_payload",
		"user_id",
		c.userID,
		"room_id",
		c.roomID,
		"frame_type",
		frameType,
		"code",
		code,
		"error",
		validationErr,
	)
	c.sendProtocolError(code, message)
}

func (a *App) handleWS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	if a.wsConnectLimiter != nil && !a.wsConnectLimiter.Allow(clientKeyFromRequest(r, a.trustProxyHeaders)) {
		respondRateLimited(w, "too many websocket connection attempts")
		return
	}

	auth, status, message := a.authenticateWebSocketRequest(r)
	if status != http.StatusOK {
		respondJSON(w, status, map[string]any{"error": message})
		return
	}

	roomID, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("room_id")), 10, 64)
	if err != nil || roomID <= 0 {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid room_id"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if err := a.ensureRoomExists(ctx, roomID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "room not found"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to verify room"})
		return
	}

	if err := a.ensureMembership(ctx, auth.UserID, roomID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusForbidden, map[string]any{"error": "not a room member"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to validate room membership"})
		return
	}

	conn, err := a.upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Error("websocket_upgrade_failed", "error", err)
		return
	}

	client := &Client{
		app:        a,
		conn:       conn,
		send:       make(chan []byte, 256),
		userID:     auth.UserID,
		username:   auth.Username,
		deviceID:   auth.DeviceID,
		deviceName: auth.DeviceName,
		roomID:     roomID,
		sessionVer: auth.DeviceSessionVersion,
		tokenExp:   auth.TokenExpiresAt,
	}

	peers := a.hub.AddClient(client)
	if payload, err := json.Marshal(map[string]any{
		"type":   "room_peers",
		"roomId": roomID,
		"peers":  peers,
	}); err == nil {
		client.send <- payload
	}

	go client.writePump()
	client.readPump()
}

func (c *Client) readPump() {
	defer func() {
		c.app.hub.RemoveClient(c)
		if payload, err := json.Marshal(map[string]any{
			"type":     "peer_left",
			"roomId":   c.roomID,
			"userId":   c.userID,
			"deviceId": c.deviceID,
		}); err == nil {
			c.app.hub.Broadcast(c.roomID, payload)
		}
		_ = c.conn.Close()
	}()

	c.conn.SetReadLimit(1 << 20)
	_ = c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	})

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			if closeErr, ok := err.(*websocket.CloseError); ok {
				logger.Info(
					"websocket_closed",
					"user_id",
					c.userID,
					"room_id",
					c.roomID,
					"code",
					closeErr.Code,
					"reason",
					closeErr.Text,
					"remote_addr",
					c.conn.RemoteAddr().String(),
				)
			} else {
				logger.Warn(
					"websocket_read_failed",
					"user_id",
					c.userID,
					"room_id",
					c.roomID,
					"remote_addr",
					c.conn.RemoteAddr().String(),
					"error",
					err,
				)
			}
			return
		}

		var incoming WSIncoming
		if err := json.Unmarshal(raw, &incoming); err != nil {
			continue
		}

		switch incoming.Type {
		case "key_announce":
			if len(incoming.PublicKeyJWK) == 0 || !json.Valid(incoming.PublicKeyJWK) {
				continue
			}
			if len(incoming.SigningPublicKeyJWK) == 0 || !json.Valid(incoming.SigningPublicKeyJWK) {
				continue
			}
			c.setPublicKey(incoming.PublicKeyJWK)
			c.setSigningPublicKey(incoming.SigningPublicKeyJWK)
			if payload, err := json.Marshal(map[string]any{
				"type":                "peer_key",
				"roomId":              c.roomID,
				"userId":              c.userID,
				"username":            c.username,
				"deviceId":            c.deviceID,
				"deviceName":          c.deviceName,
				"publicKeyJwk":        json.RawMessage(incoming.PublicKeyJWK),
				"signingPublicKeyJwk": json.RawMessage(incoming.SigningPublicKeyJWK),
			}); err == nil {
				c.app.hub.Broadcast(c.roomID, payload)
			}

		case "ciphertext":
			if c.app.ciphertextLimiter != nil && !c.app.ciphertextLimiter.Allow(fmt.Sprintf("%d:%s:%d", c.userID, c.deviceID, c.roomID)) {
				c.sendProtocolError(protocolErrorRateLimited, "发送过快，请稍后再试。")
				continue
			}
			if incoming.Ciphertext == "" || incoming.MessageIV == "" || len(incoming.WrappedKeys) == 0 {
				continue
			}
			if incoming.Signature == "" {
				continue
			}
			senderDeviceID := normalizeDeviceID(incoming.SenderDeviceID)
			if senderDeviceID == "" {
				senderDeviceID = c.deviceID
			}
			if senderDeviceID != c.deviceID {
				continue
			}
			if len(incoming.SenderSigningPubJWK) == 0 || !json.Valid(incoming.SenderSigningPubJWK) {
				continue
			}
			announcedSigning := c.getSigningPublicKey()
			if len(announcedSigning) == 0 || !jsonEqualCanonical(announcedSigning, incoming.SenderSigningPubJWK) {
				continue
			}

			senderPub := incoming.SenderPublicJWK
			if len(senderPub) == 0 {
				senderPub = c.getPublicKey()
			}
			if len(senderPub) == 0 || !json.Valid(senderPub) {
				continue
			}
			announcedPub := c.getPublicKey()
			if len(announcedPub) > 0 && !jsonEqualCanonical(announcedPub, senderPub) {
				continue
			}

			payload := CipherPayload{
				Version:             incoming.Version,
				Ciphertext:          incoming.Ciphertext,
				MessageIV:           incoming.MessageIV,
				WrappedKeys:         incoming.WrappedKeys,
				SenderPublicJWK:     senderPub,
				SenderSigningPubJWK: incoming.SenderSigningPubJWK,
				Signature:           incoming.Signature,
				ContentType:         incoming.ContentType,
				SenderDeviceID:      senderDeviceID,
				EncryptionScheme:    incoming.EncryptionScheme,
			}
			if err := validateV3CipherPayload(payload); err != nil {
				c.rejectInvalidPayload("ciphertext", err)
				continue
			}
			if err := verifyCipherSignature(payload); err != nil {
				logger.Warn(
					"drop_invalid_cipher_signature",
					"user_id",
					c.userID,
					"room_id",
					c.roomID,
					"error",
					err,
				)
				continue
			}

			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := c.app.ensureMembership(ctx, c.userID, c.roomID); err != nil {
				cancel()
				continue
			}
			messageID, createdAt, err := c.app.storeMessage(ctx, c.roomID, c.userID, payload)
			cancel()
			if err != nil {
				logger.Error(
					"store_message_failed",
					"user_id",
					c.userID,
					"room_id",
					c.roomID,
					"error",
					err,
				)
				continue
			}

			c.app.hub.BroadcastToRoomClients(c.roomID, func(target *Client) ([]byte, bool) {
				var targetPayload CipherPayload
				if target.userID == c.userID {
					targetPayload = senderEchoPayload(payload, target.userID, target.deviceID)
				} else {
					targetPayload = payloadForRecipient(payload, target.userID, target.deviceID, mustMarshalWrappedKeyForTarget(payload, target.userID, target.deviceID))
				}
				out, err := json.Marshal(map[string]any{
					"type":           "ciphertext",
					"id":             messageID,
					"roomId":         c.roomID,
					"senderId":       c.userID,
					"senderUsername": c.username,
					"createdAt":      createdAt.UTC().Format(time.RFC3339Nano),
					"payload":        targetPayload,
				})
				return out, err == nil
			})
			go c.app.publishRoomSummaryUpdatesForRoom(c.roomID)

		case "typing_status":
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := c.app.ensureMembership(ctx, c.userID, c.roomID); err != nil {
				cancel()
				continue
			}
			cancel()
			if payload, err := json.Marshal(map[string]any{
				"type":         "typing_status",
				"roomId":       c.roomID,
				"fromUserId":   c.userID,
				"fromUsername": c.username,
				"isTyping":     incoming.IsTyping,
			}); err == nil {
				c.app.hub.Broadcast(c.roomID, payload)
			}

		case "read_receipt":
			if incoming.UpToMessageID <= 0 {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := c.app.ensureMembership(ctx, c.userID, c.roomID); err != nil {
				cancel()
				continue
			}
			var found int64
			err := c.app.db.QueryRowContext(ctx,
				`SELECT id FROM messages WHERE id = $1 AND room_id = $2`,
				incoming.UpToMessageID, c.roomID,
			).Scan(&found)

			if err == nil {
				_, _ = c.app.db.ExecContext(ctx,
					`UPDATE room_members SET last_read_message_id = GREATEST(last_read_message_id, $1) WHERE user_id = $2 AND room_id = $3`,
					incoming.UpToMessageID, c.userID, c.roomID,
				)
				_, _ = c.app.db.ExecContext(ctx, `
UPDATE chat_mailbox.device_envelopes
SET read_at = COALESCE(read_at, NOW()),
    delivered_at = COALESCE(delivered_at, NOW())
WHERE room_id = $1
  AND recipient_user_id = $2
  AND recipient_device_id = $3
  AND message_id <= $4
`, c.roomID, c.userID, c.deviceID, incoming.UpToMessageID)
				_, _ = c.app.db.ExecContext(ctx, `
INSERT INTO chat_mailbox.device_inbox_cursors(user_id, device_id, room_id, last_envelope_message_id, updated_at)
VALUES ($1, $2, $3, $4, NOW())
ON CONFLICT (user_id, device_id, room_id) DO UPDATE
SET last_envelope_message_id = GREATEST(chat_mailbox.device_inbox_cursors.last_envelope_message_id, EXCLUDED.last_envelope_message_id),
    updated_at = NOW()
`, c.userID, c.deviceID, c.roomID, incoming.UpToMessageID)
			}
			cancel()
			if err != nil {
				continue
			}
			if payload, err := json.Marshal(map[string]any{
				"type":          "read_receipt",
				"roomId":        c.roomID,
				"fromUserId":    c.userID,
				"fromUsername":  c.username,
				"upToMessageId": incoming.UpToMessageID,
			}); err == nil {
				c.app.hub.Broadcast(c.roomID, payload)
			}
			go c.app.publishRoomSummaryUpdate(c.userID, c.deviceID, c.roomID)

		case "message_update":
			if incoming.MessageID <= 0 {
				continue
			}
			mode := strings.ToLower(strings.TrimSpace(incoming.Mode))
			if mode != "edit" && mode != "revoke" {
				continue
			}

			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := c.app.ensureMembership(ctx, c.userID, c.roomID); err != nil {
				cancel()
				continue
			}

			if mode == "revoke" {
				var revokedAt time.Time
				err := c.app.db.QueryRowContext(ctx,
					`UPDATE messages
						 SET revoked_at = NOW(), edited_at = NULL
						 WHERE id = $1 AND room_id = $2 AND sender_id = $3 AND revoked_at IS NULL
						 RETURNING revoked_at`,
					incoming.MessageID, c.roomID, c.userID,
				).Scan(&revokedAt)
				cancel()
				if err != nil {
					continue
				}
				if payload, err := json.Marshal(map[string]any{
					"type":         "message_update",
					"roomId":       c.roomID,
					"messageId":    incoming.MessageID,
					"mode":         "revoke",
					"fromUserId":   c.userID,
					"fromUsername": c.username,
					"revokedAt":    revokedAt.UTC().Format(time.RFC3339Nano),
				}); err == nil {
					c.app.hub.Broadcast(c.roomID, payload)
				}
				continue
			}

			if incoming.Ciphertext == "" || incoming.MessageIV == "" || len(incoming.WrappedKeys) == 0 {
				cancel()
				continue
			}
			if incoming.Signature == "" {
				cancel()
				continue
			}
			if len(incoming.SenderSigningPubJWK) == 0 || !json.Valid(incoming.SenderSigningPubJWK) {
				cancel()
				continue
			}
			announcedSigning := c.getSigningPublicKey()
			if len(announcedSigning) == 0 || !jsonEqualCanonical(announcedSigning, incoming.SenderSigningPubJWK) {
				cancel()
				continue
			}

			senderPub := incoming.SenderPublicJWK
			if len(senderPub) == 0 {
				senderPub = c.getPublicKey()
			}
			if len(senderPub) == 0 || !json.Valid(senderPub) {
				cancel()
				continue
			}
			announcedPub := c.getPublicKey()
			if len(announcedPub) > 0 && !jsonEqualCanonical(announcedPub, senderPub) {
				cancel()
				continue
			}
			senderDeviceID := normalizeDeviceID(incoming.SenderDeviceID)
			if senderDeviceID == "" {
				senderDeviceID = c.deviceID
			}
			if senderDeviceID != c.deviceID {
				cancel()
				continue
			}

			payload := CipherPayload{
				Version:             incoming.Version,
				Ciphertext:          incoming.Ciphertext,
				MessageIV:           incoming.MessageIV,
				WrappedKeys:         incoming.WrappedKeys,
				SenderPublicJWK:     senderPub,
				SenderSigningPubJWK: incoming.SenderSigningPubJWK,
				Signature:           incoming.Signature,
				ContentType:         incoming.ContentType,
				SenderDeviceID:      senderDeviceID,
				EncryptionScheme:    incoming.EncryptionScheme,
			}
			if err := validateV3CipherPayload(payload); err != nil {
				cancel()
				c.rejectInvalidPayload("message_update", err)
				continue
			}
			if err := verifyCipherSignature(payload); err != nil {
				cancel()
				continue
			}

			editedAt, err := c.app.updateMessagePayload(ctx, incoming.MessageID, c.roomID, c.userID, payload)
			cancel()
			if err != nil {
				continue
			}

			c.app.hub.BroadcastToRoomClients(c.roomID, func(target *Client) ([]byte, bool) {
				var targetPayload CipherPayload
				if target.userID == c.userID {
					targetPayload = senderEchoPayload(payload, target.userID, target.deviceID)
				} else {
					targetPayload = payloadForRecipient(payload, target.userID, target.deviceID, mustMarshalWrappedKeyForTarget(payload, target.userID, target.deviceID))
				}
				out, err := json.Marshal(map[string]any{
					"type":         "message_update",
					"roomId":       c.roomID,
					"messageId":    incoming.MessageID,
					"mode":         "edit",
					"fromUserId":   c.userID,
					"fromUsername": c.username,
					"editedAt":     editedAt.UTC().Format(time.RFC3339Nano),
					"payload":      targetPayload,
				})
				return out, err == nil
			})

		case "decrypt_ack":
			if incoming.MessageID <= 0 || strings.TrimSpace(incoming.AckSignature) == "" {
				continue
			}
			if len(incoming.SenderSigningPubJWK) == 0 || !json.Valid(incoming.SenderSigningPubJWK) {
				continue
			}
			announcedSigning := c.getSigningPublicKey()
			if len(announcedSigning) == 0 || !jsonEqualCanonical(announcedSigning, incoming.SenderSigningPubJWK) {
				continue
			}
			if err := verifyAckSignature(incoming.SenderSigningPubJWK, c.roomID, incoming.MessageID, c.userID, incoming.AckSignature); err != nil {
				logger.Warn(
					"drop_invalid_decrypt_ack",
					"user_id",
					c.userID,
					"room_id",
					c.roomID,
					"message_id",
					incoming.MessageID,
					"error",
					err,
				)
				continue
			}

			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := c.app.ensureMembership(ctx, c.userID, c.roomID); err != nil {
				cancel()
				continue
			}
			var senderID int64
			err := c.app.db.QueryRowContext(ctx,
				`SELECT sender_id FROM messages WHERE id = $1 AND room_id = $2`,
				incoming.MessageID, c.roomID,
			).Scan(&senderID)
			cancel()
			if err != nil {
				continue
			}
			if senderID == c.userID {
				continue
			}

			if payload, err := json.Marshal(map[string]any{
				"type":         "decrypt_ack",
				"roomId":       c.roomID,
				"messageId":    incoming.MessageID,
				"fromUserId":   c.userID,
				"fromUsername": c.username,
			}); err == nil {
				c.app.hub.Broadcast(c.roomID, payload)
			}

		case "decrypt_recovery_request":
			if incoming.MessageID <= 0 {
				continue
			}
			action := strings.ToLower(strings.TrimSpace(incoming.Action))
			if action == "" {
				action = "resync"
			}
			if action != "resync" {
				continue
			}

			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := c.app.ensureMembership(ctx, c.userID, c.roomID); err != nil {
				cancel()
				continue
			}

			var senderID int64
			err := c.app.db.QueryRowContext(ctx,
				`SELECT sender_id FROM messages WHERE id = $1 AND room_id = $2`,
				incoming.MessageID, c.roomID,
			).Scan(&senderID)
			cancel()
			if err != nil || senderID <= 0 {
				continue
			}
			targetDeviceID := normalizeDeviceID(incoming.ToDeviceID)
			// Allow same-user cross-device resync (a user's secondary device
			// asking the device that originally sent the message to retransmit),
			// but reject same-user same-device requests which would loop back to
			// the requester itself.
			if !allowResyncRouting(c.userID, c.deviceID, senderID, targetDeviceID) {
				continue
			}

			if payload, err := json.Marshal(map[string]any{
				"type":         "decrypt_recovery_request",
				"roomId":       c.roomID,
				"messageId":    incoming.MessageID,
				"fromUserId":   c.userID,
				"fromUsername": c.username,
				"fromDeviceId": c.deviceID,
				"toUserId":     senderID,
				"toDeviceId":   targetDeviceID,
				"action":       action,
			}); err == nil {
				if targetDeviceID != "" {
					c.app.hub.UnicastToDevice(c.roomID, senderID, targetDeviceID, payload)
				} else {
					c.app.hub.Unicast(c.roomID, senderID, payload)
				}
			}

		case "envelope_refill_request":
			targetDeviceID := normalizeDeviceID(incoming.FromDeviceID)
			if targetDeviceID == "" {
				continue
			}
			if targetDeviceID == c.deviceID {
				continue
			}
			messageIDs := incoming.MessageIDs
			if len(messageIDs) > 200 {
				messageIDs = messageIDs[:200]
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := c.app.ensureMembership(ctx, c.userID, c.roomID); err != nil {
				cancel()
				continue
			}
			device, err := c.app.loadActiveDevice(ctx, c.userID, targetDeviceID)
			cancel()
			if err != nil || device.TrustStatus != "approved" {
				continue
			}
			if payload, err := json.Marshal(map[string]any{
				"type":         "envelope_refill_request",
				"roomId":       c.roomID,
				"fromUserId":   c.userID,
				"fromUsername": c.username,
				"fromDeviceId": targetDeviceID,
				"toUserId":     c.userID,
				"toDeviceId":   c.deviceID,
				"messageIds":   messageIDs,
			}); err == nil {
				c.app.hub.UnicastToDevice(c.roomID, c.userID, c.deviceID, payload)
			}

		case "decrypt_recovery_payload":
			if incoming.MessageID <= 0 || incoming.ToUserID <= 0 {
				continue
			}
			if incoming.Ciphertext == "" || incoming.MessageIV == "" || len(incoming.WrappedKeys) == 0 {
				continue
			}
			if incoming.Signature == "" {
				continue
			}
			senderDeviceID := normalizeDeviceID(incoming.SenderDeviceID)
			if senderDeviceID == "" {
				senderDeviceID = c.deviceID
			}
			if senderDeviceID != c.deviceID {
				continue
			}
			if len(incoming.SenderSigningPubJWK) == 0 || !json.Valid(incoming.SenderSigningPubJWK) {
				continue
			}
			announcedSigning := c.getSigningPublicKey()
			if len(announcedSigning) == 0 || !jsonEqualCanonical(announcedSigning, incoming.SenderSigningPubJWK) {
				continue
			}
			senderPub := incoming.SenderPublicJWK
			if len(senderPub) == 0 {
				senderPub = c.getPublicKey()
			}
			if len(senderPub) == 0 || !json.Valid(senderPub) {
				continue
			}
			announcedPub := c.getPublicKey()
			if len(announcedPub) > 0 && !jsonEqualCanonical(announcedPub, senderPub) {
				continue
			}

			payload := CipherPayload{
				Version:             incoming.Version,
				Ciphertext:          incoming.Ciphertext,
				MessageIV:           incoming.MessageIV,
				WrappedKeys:         incoming.WrappedKeys,
				SenderPublicJWK:     senderPub,
				SenderSigningPubJWK: incoming.SenderSigningPubJWK,
				Signature:           incoming.Signature,
				ContentType:         incoming.ContentType,
				SenderDeviceID:      senderDeviceID,
				EncryptionScheme:    incoming.EncryptionScheme,
			}
			if err := validateV3CipherPayload(payload); err != nil {
				c.rejectInvalidPayload("decrypt_recovery_payload", err)
				continue
			}
			if err := verifyCipherSignature(payload); err != nil {
				logger.Warn(
					"drop_invalid_decrypt_recovery_payload",
					"user_id",
					c.userID,
					"room_id",
					c.roomID,
					"message_id",
					incoming.MessageID,
					"error",
					err,
				)
				continue
			}

			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := c.app.ensureMembership(ctx, c.userID, c.roomID); err != nil {
				cancel()
				continue
			}
			if err := c.app.ensureMembership(ctx, incoming.ToUserID, c.roomID); err != nil {
				cancel()
				continue
			}
			var originalSenderID int64
			err := c.app.db.QueryRowContext(ctx,
				`SELECT sender_id FROM messages WHERE id = $1 AND room_id = $2`,
				incoming.MessageID, c.roomID,
			).Scan(&originalSenderID)
			cancel()
			if err != nil || originalSenderID != c.userID {
				continue
			}
			recoveryTargetDeviceID := normalizeDeviceID(incoming.ToDeviceID)
			// Reject self-targeted recovery (same user, same device or empty
			// target) which would loop back to the sender itself.
			if !allowResyncRouting(c.userID, c.deviceID, incoming.ToUserID, recoveryTargetDeviceID) {
				continue
			}

			if out, err := json.Marshal(map[string]any{
				"type":         "decrypt_recovery_payload",
				"roomId":       c.roomID,
				"messageId":    incoming.MessageID,
				"fromUserId":   c.userID,
				"fromUsername": c.username,
				"fromDeviceId": c.deviceID,
				"toUserId":     incoming.ToUserID,
				"toDeviceId":   recoveryTargetDeviceID,
				"payload":      payload,
			}); err == nil {
				if recoveryTargetDeviceID != "" {
					c.app.hub.UnicastToDevice(c.roomID, incoming.ToUserID, recoveryTargetDeviceID, out)
				} else {
					c.app.hub.Unicast(c.roomID, incoming.ToUserID, out)
				}
			}
		}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(30 * time.Second)
	authTicker := time.NewTicker(1 * time.Minute)
	defer ticker.Stop()
	defer authTicker.Stop()

	for {
		select {
		case payload, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.TextMessage, payload); err != nil {
				logger.Warn(
					"websocket_write_failed",
					"user_id",
					c.userID,
					"room_id",
					c.roomID,
					"remote_addr",
					c.conn.RemoteAddr().String(),
					"error",
					err,
				)
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				logger.Warn(
					"websocket_ping_failed",
					"user_id",
					c.userID,
					"room_id",
					c.roomID,
					"remote_addr",
					c.conn.RemoteAddr().String(),
					"error",
					err,
				)
				return
			}
		case <-authTicker.C:
			if !c.validateStillAuthorized() {
				c.sendProtocolError(protocolErrorAuthExpired, "登录状态已失效，请重新登录。")
				_ = c.conn.WriteControl(
					websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.ClosePolicyViolation, "device session expired"),
					time.Now().Add(time.Second),
				)
				_ = c.conn.Close()
				return
			}
		}
	}
}

func (c *Client) validateStillAuthorized() bool {
	if c.tokenExp.IsZero() || !time.Now().UTC().Before(c.tokenExp.UTC()) {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	device, err := c.app.validateDeviceClaim(ctx, c.userID, c.deviceID, c.sessionVer)
	if err != nil {
		return false
	}
	return device.DeviceID == c.deviceID
}
