package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

func (a *App) handleWS(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	if a.wsConnectLimiter != nil && !a.wsConnectLimiter.Allow(clientKeyFromRequest(r, a.trustProxyHeaders)) {
		respondRateLimited(w, "too many websocket connection attempts")
		return
	}

	tokenString, _ := authTokenFromRequest(r)
	if tokenString == "" {
		respondJSON(w, http.StatusUnauthorized, map[string]any{"error": "authorization required"})
		return
	}
	claims, err := a.parseToken(tokenString)
	if err != nil {
		respondJSON(w, http.StatusUnauthorized, map[string]any{"error": "invalid token"})
		return
	}

	roomID, err := strconv.ParseInt(strings.TrimSpace(r.URL.Query().Get("room_id")), 10, 64)
	if err != nil || roomID <= 0 {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid room_id"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
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

	if err := a.ensureRoomExists(ctx, roomID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "room not found"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to verify room"})
		return
	}

	if err := a.ensureMembership(ctx, claims.UserID, roomID); err != nil {
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
		app:      a,
		conn:     conn,
		send:     make(chan []byte, 256),
		userID:   claims.UserID,
		username: claims.Username,
		roomID:   roomID,
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
			"type":   "peer_left",
			"roomId": c.roomID,
			"userId": c.userID,
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
				"publicKeyJwk":        json.RawMessage(incoming.PublicKeyJWK),
				"signingPublicKeyJwk": json.RawMessage(incoming.SigningPublicKeyJWK),
			}); err == nil {
				c.app.hub.Broadcast(c.roomID, payload)
			}

		case "ciphertext":
			if incoming.Ciphertext == "" || incoming.MessageIV == "" || len(incoming.WrappedKeys) == 0 {
				continue
			}
			if incoming.Signature == "" {
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
				SenderDeviceID:      incoming.SenderDeviceID,
				EncryptionScheme:    incoming.EncryptionScheme,
			}
			if payload.Version <= 0 {
				payload.Version = 1
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

			if out, err := json.Marshal(map[string]any{
				"type":           "ciphertext",
				"id":             messageID,
				"roomId":         c.roomID,
				"senderId":       c.userID,
				"senderUsername": c.username,
				"createdAt":      createdAt.UTC().Format(time.RFC3339Nano),
				"payload":        payload,
			}); err == nil {
				c.app.hub.Broadcast(c.roomID, out)
			}

		case "dr_handshake":
			if incoming.ToUserID <= 0 {
				continue
			}
			step := strings.ToLower(strings.TrimSpace(incoming.Step))
			if step != "init" && step != "ack" {
				continue
			}
			if len(incoming.RatchetDHPublic) == 0 || !json.Valid(incoming.RatchetDHPublic) {
				continue
			}
			if len(incoming.IdentityPublicJWK) == 0 || !json.Valid(incoming.IdentityPublicJWK) {
				continue
			}
			if len(incoming.IdentitySigningPubJWK) == 0 || !json.Valid(incoming.IdentitySigningPubJWK) {
				continue
			}
			announcedSigning := c.getSigningPublicKey()
			if len(announcedSigning) == 0 || !jsonEqualCanonical(announcedSigning, incoming.IdentitySigningPubJWK) {
				continue
			}
			payload, err := json.Marshal(map[string]any{
				"type":                        "dr_handshake",
				"roomId":                      c.roomID,
				"fromUserId":                  c.userID,
				"fromUsername":                c.username,
				"toUserId":                    incoming.ToUserID,
				"step":                        step,
				"sessionVersion":              incoming.SessionVersion,
				"ratchetDhPublicKeyJwk":       json.RawMessage(incoming.RatchetDHPublic),
				"identityPublicKeyJwk":        json.RawMessage(incoming.IdentityPublicJWK),
				"identitySigningPublicKeyJwk": json.RawMessage(incoming.IdentitySigningPubJWK),
			})
			if err == nil {
				c.app.hub.Broadcast(c.roomID, payload)
			}

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

			payload := CipherPayload{
				Version:             incoming.Version,
				Ciphertext:          incoming.Ciphertext,
				MessageIV:           incoming.MessageIV,
				WrappedKeys:         incoming.WrappedKeys,
				SenderPublicJWK:     senderPub,
				SenderSigningPubJWK: incoming.SenderSigningPubJWK,
				Signature:           incoming.Signature,
				ContentType:         incoming.ContentType,
				SenderDeviceID:      incoming.SenderDeviceID,
				EncryptionScheme:    incoming.EncryptionScheme,
			}
			if payload.Version <= 0 {
				payload.Version = 1
			}
			if err := verifyCipherSignature(payload); err != nil {
				cancel()
				continue
			}

			payloadJSON, err := json.Marshal(payload)
			if err != nil {
				cancel()
				continue
			}

			var editedAt time.Time
			err = c.app.db.QueryRowContext(ctx,
				`UPDATE messages
					 SET payload = $1::jsonb, edited_at = NOW(), revoked_at = NULL
					 WHERE id = $2 AND room_id = $3 AND sender_id = $4
					 RETURNING edited_at`,
				payloadJSON, incoming.MessageID, c.roomID, c.userID,
			).Scan(&editedAt)
			cancel()
			if err != nil {
				continue
			}

			if out, err := json.Marshal(map[string]any{
				"type":         "message_update",
				"roomId":       c.roomID,
				"messageId":    incoming.MessageID,
				"mode":         "edit",
				"fromUserId":   c.userID,
				"fromUsername": c.username,
				"editedAt":     editedAt.UTC().Format(time.RFC3339Nano),
				"payload":      payload,
			}); err == nil {
				c.app.hub.Broadcast(c.roomID, out)
			}

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
			if err != nil || senderID <= 0 || senderID == c.userID {
				continue
			}

			if payload, err := json.Marshal(map[string]any{
				"type":         "decrypt_recovery_request",
				"roomId":       c.roomID,
				"messageId":    incoming.MessageID,
				"fromUserId":   c.userID,
				"fromUsername": c.username,
				"toUserId":     senderID,
				"action":       action,
			}); err == nil {
				c.app.hub.Unicast(c.roomID, senderID, payload)
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
				SenderDeviceID:      incoming.SenderDeviceID,
				EncryptionScheme:    incoming.EncryptionScheme,
			}
			if payload.Version <= 0 {
				payload.Version = 1
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

			if out, err := json.Marshal(map[string]any{
				"type":         "decrypt_recovery_payload",
				"roomId":       c.roomID,
				"messageId":    incoming.MessageID,
				"fromUserId":   c.userID,
				"fromUsername": c.username,
				"toUserId":     incoming.ToUserID,
				"payload":      payload,
			}); err == nil {
				c.app.hub.Unicast(c.roomID, incoming.ToUserID, out)
			}
		}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()

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
		}
	}
}
