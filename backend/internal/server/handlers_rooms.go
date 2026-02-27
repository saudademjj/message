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
)

type roomAccessDecision struct {
	Allowed bool
	Code    string
	Error   string
}

func decideDirectJoin(role string, isSystem bool) roomAccessDecision {
	if role == "admin" {
		return roomAccessDecision{Allowed: true}
	}
	if isSystem {
		return roomAccessDecision{
			Allowed: false,
			Code:    "system_room_admin_only",
			Error:   "system room can only be joined by admin",
		}
	}
	return roomAccessDecision{
		Allowed: false,
		Code:    "invite_required",
		Error:   "direct room join is disabled; use invite link",
	}
}

func decideSystemRoomAccess(role string, isSystem bool) roomAccessDecision {
	if !isSystem || role == "admin" {
		return roomAccessDecision{Allowed: true}
	}
	return roomAccessDecision{
		Allowed: false,
		Code:    "system_room_admin_only",
		Error:   "system room can only be managed by admin",
	}
}

func isUniqueViolation(err error) bool {
	if err == nil {
		return false
	}
	value := strings.ToLower(err.Error())
	return strings.Contains(value, "duplicate key value") || strings.Contains(value, "sqlstate 23505")
}

func (a *App) handleRooms(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	switch r.Method {
	case http.MethodGet:
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()

		rows, err := a.db.QueryContext(ctx, `
SELECT r.id, r.name, r.created_at
FROM rooms r
JOIN room_members rm ON rm.room_id = r.id
WHERE rm.user_id = $1
ORDER BY r.id ASC
`, auth.UserID)
		if err != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to fetch rooms"})
			return
		}
		defer rows.Close()

		type roomResp struct {
			ID        int64  `json:"id"`
			Name      string `json:"name"`
			CreatedAt string `json:"createdAt"`
		}
		rooms := []roomResp{}
		for rows.Next() {
			var room roomResp
			var createdAt time.Time
			if err := rows.Scan(&room.ID, &room.Name, &createdAt); err != nil {
				respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to decode rooms"})
				return
			}
			room.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
			rooms = append(rooms, room)
		}
		respondJSON(w, http.StatusOK, map[string]any{"rooms": rooms})

	case http.MethodPost:
		var req struct {
			Name string `json:"name"`
		}
		if err := decodeJSON(r, &req); err != nil {
			respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
			return
		}

		req.Name = strings.TrimSpace(req.Name)
		if len(req.Name) < 2 || len(req.Name) > 64 {
			respondJSON(w, http.StatusBadRequest, map[string]any{"error": "room name length must be between 2 and 64"})
			return
		}

		var roomID int64
		var roomName string
		var createdAt time.Time
		ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
		defer cancel()
		tx, err := a.db.BeginTx(ctx, nil)
		if err != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to begin transaction"})
			return
		}
		defer tx.Rollback()
		err = tx.QueryRowContext(ctx, `
INSERT INTO rooms(name, created_by)
VALUES ($1, $2)
RETURNING id, name, created_at
`, req.Name, auth.UserID).Scan(&roomID, &roomName, &createdAt)
		if err != nil {
			if isUniqueViolation(err) {
				respondJSON(w, http.StatusConflict, map[string]any{
					"error": "room name already exists",
					"code":  "room_name_conflict",
				})
				return
			}
			respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to create room"})
			return
		}

		if _, err := tx.ExecContext(ctx,
			`INSERT INTO room_members(room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			roomID, auth.UserID,
		); err != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to add room membership"})
			return
		}

		if err := tx.Commit(); err != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to commit room transaction"})
			return
		}

		respondJSON(w, http.StatusCreated, map[string]any{
			"room": map[string]any{
				"id":        roomID,
				"name":      roomName,
				"createdAt": createdAt.UTC().Format(time.RFC3339Nano),
			},
		})

	default:
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
	}
}

func (a *App) handleRoomSubroutes(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 3 || len(parts) > 4 || parts[0] != "api" || parts[1] != "rooms" {
		respondJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}

	roomID, err := strconv.ParseInt(parts[2], 10, 64)
	if err != nil || roomID <= 0 {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid room id"})
		return
	}

	if len(parts) == 3 {
		a.handleDeleteRoom(w, r, auth, roomID)
		return
	}

	action := parts[3]
	switch action {
	case "join":
		a.handleJoinRoom(w, r, auth, roomID)
	case "messages":
		a.handleRoomMessages(w, r, auth, roomID)
	case "members":
		a.handleRoomMembers(w, r, auth, roomID)
	case "invite":
		a.handleRoomInvite(w, r, auth, roomID)
	default:
		respondJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
	}
}

func (a *App) handleDeleteRoom(w http.ResponseWriter, r *http.Request, auth AuthContext, roomID int64) {
	if r.Method != http.MethodDelete {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()

	var createdBy sql.NullInt64
	var isSystem bool
	err := a.db.QueryRowContext(ctx,
		`SELECT created_by, COALESCE(is_system, FALSE) FROM rooms WHERE id = $1`,
		roomID,
	).Scan(&createdBy, &isSystem)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "room not found"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to load room"})
		return
	}
	if isSystem {
		respondJSON(w, http.StatusForbidden, map[string]any{"error": "system room cannot be deleted"})
		return
	}

	allowed := auth.Role == "admin" || (createdBy.Valid && createdBy.Int64 == auth.UserID)
	if !allowed {
		respondJSON(w, http.StatusForbidden, map[string]any{"error": "only room creator or admin can delete room"})
		return
	}

	var deletedID int64
	err = a.db.QueryRowContext(ctx,
		`DELETE FROM rooms WHERE id = $1 RETURNING id`,
		roomID,
	).Scan(&deletedID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "room not found"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to delete room"})
		return
	}

	respondJSON(w, http.StatusOK, map[string]any{"deleted": true, "roomId": deletedID})
}

func (a *App) handleJoinRoom(w http.ResponseWriter, r *http.Request, auth AuthContext, roomID int64) {
	if r.Method != http.MethodPost {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	var isSystem bool
	if err := a.db.QueryRowContext(ctx, `SELECT COALESCE(is_system, FALSE) FROM rooms WHERE id = $1`, roomID).Scan(&isSystem); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "room not found"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to load room"})
		return
	}

	decision := decideDirectJoin(auth.Role, isSystem)
	if !decision.Allowed {
		respondJSON(w, http.StatusForbidden, map[string]any{
			"error": decision.Error,
			"code":  decision.Code,
		})
		return
	}

	if _, err := a.db.ExecContext(ctx,
		`INSERT INTO room_members(room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		roomID, auth.UserID,
	); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to join room"})
		return
	}

	respondJSON(w, http.StatusOK, map[string]any{"joined": true})
}

func (a *App) handleRoomInvite(w http.ResponseWriter, r *http.Request, auth AuthContext, roomID int64) {
	if r.Method != http.MethodPost {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if err := a.ensureMembership(ctx, auth.UserID, roomID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusForbidden, map[string]any{"error": "not a room member"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to validate room membership"})
		return
	}
	var isSystem bool
	if err := a.db.QueryRowContext(ctx, `SELECT COALESCE(is_system, FALSE) FROM rooms WHERE id = $1`, roomID).Scan(&isSystem); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "room not found"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to load room"})
		return
	}
	decision := decideSystemRoomAccess(auth.Role, isSystem)
	if !decision.Allowed {
		respondJSON(w, http.StatusForbidden, map[string]any{
			"error": decision.Error,
			"code":  decision.Code,
		})
		return
	}

	inviteToken, expiresAt, err := a.issueInviteToken(roomID, auth.UserID)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to issue invite token"})
		return
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"roomId":      roomID,
		"inviteToken": inviteToken,
		"expiresAt":   expiresAt.UTC().Format(time.RFC3339Nano),
	})
}

func (a *App) handleInviteJoin(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	if r.Method != http.MethodPost {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}

	var req struct {
		InviteToken string `json:"inviteToken"`
	}
	if err := decodeJSON(r, &req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}

	req.InviteToken = strings.TrimSpace(req.InviteToken)
	if req.InviteToken == "" {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invite token is required"})
		return
	}

	claims, err := a.parseInviteToken(req.InviteToken)
	if err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid or expired invite token"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 6*time.Second)
	defer cancel()

	var roomID int64
	var roomName string
	var createdAt time.Time
	var isSystem bool
	err = a.db.QueryRowContext(ctx,
		`SELECT id, name, created_at, COALESCE(is_system, FALSE) FROM rooms WHERE id = $1`,
		claims.RoomID,
	).Scan(&roomID, &roomName, &createdAt, &isSystem)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "room not found"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to load room"})
		return
	}
	decision := decideSystemRoomAccess(auth.Role, isSystem)
	if !decision.Allowed {
		respondJSON(w, http.StatusForbidden, map[string]any{
			"error": decision.Error,
			"code":  decision.Code,
		})
		return
	}

	if _, err := a.db.ExecContext(ctx,
		`INSERT INTO room_members(room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		roomID, auth.UserID,
	); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to join room by invite"})
		return
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"joined": true,
		"room": map[string]any{
			"id":        roomID,
			"name":      roomName,
			"createdAt": createdAt.UTC().Format(time.RFC3339Nano),
		},
	})
}

func (a *App) handleRoomMessages(w http.ResponseWriter, r *http.Request, auth AuthContext, roomID int64) {
	if r.Method != http.MethodGet {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()

	if err := a.ensureMembership(ctx, auth.UserID, roomID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusForbidden, map[string]any{"error": "not a room member"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to validate room membership"})
		return
	}

	limit := int64(50)
	if value := strings.TrimSpace(r.URL.Query().Get("limit")); value != "" {
		if parsed, err := strconv.ParseInt(value, 10, 64); err == nil && parsed > 0 && parsed <= 200 {
			limit = parsed
		}
	}
	beforeID := int64(0)
	if value := strings.TrimSpace(r.URL.Query().Get("beforeId")); value != "" {
		if parsed, err := strconv.ParseInt(value, 10, 64); err == nil && parsed > 0 {
			beforeID = parsed
		}
	}
	afterID := int64(0)
	if value := strings.TrimSpace(r.URL.Query().Get("afterId")); value != "" {
		if parsed, err := strconv.ParseInt(value, 10, 64); err == nil && parsed > 0 {
			afterID = parsed
		}
	}

	var rows *sql.Rows
	var err error
	orderedAsc := false
	if afterID > 0 {
		orderedAsc = true
		rows, err = a.db.QueryContext(ctx, `
SELECT m.id, m.room_id, m.sender_id, u.username, m.payload, m.created_at, m.edited_at, m.revoked_at
	FROM messages m
	JOIN users u ON u.id = m.sender_id
	WHERE m.room_id = $1
	  AND m.id > $2
	ORDER BY m.id ASC
	LIMIT $3
	`, roomID, afterID, limit+1)
	} else {
		rows, err = a.db.QueryContext(ctx, `
SELECT m.id, m.room_id, m.sender_id, u.username, m.payload, m.created_at, m.edited_at, m.revoked_at
	FROM messages m
	JOIN users u ON u.id = m.sender_id
	WHERE m.room_id = $1
	  AND ($2::BIGINT <= 0 OR m.id < $2)
	ORDER BY m.id DESC
	LIMIT $3
	`, roomID, beforeID, limit+1)
	}
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to fetch messages"})
		return
	}
	defer rows.Close()

	messages := make([]StoredMessage, 0, limit+1)
	for rows.Next() {
		var message StoredMessage
		var payloadRaw []byte
		var createdAt time.Time
		var editedAt sql.NullTime
		var revokedAt sql.NullTime
		if err := rows.Scan(
			&message.ID,
			&message.RoomID,
			&message.SenderID,
			&message.SenderUsername,
			&payloadRaw,
			&createdAt,
			&editedAt,
			&revokedAt,
		); err != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to decode message"})
			return
		}
		if err := json.Unmarshal(payloadRaw, &message.Payload); err != nil {
			continue
		}
		message.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		if editedAt.Valid {
			value := editedAt.Time.UTC().Format(time.RFC3339Nano)
			message.EditedAt = &value
		}
		if revokedAt.Valid {
			value := revokedAt.Time.UTC().Format(time.RFC3339Nano)
			message.RevokedAt = &value
		}
		messages = append(messages, message)
	}

	hasMore := len(messages) > int(limit)
	if hasMore {
		messages = messages[:int(limit)]
	}

	if !orderedAsc {
		for left, right := 0, len(messages)-1; left < right; left, right = left+1, right-1 {
			messages[left], messages[right] = messages[right], messages[left]
		}
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"messages": messages,
		"hasMore":  hasMore,
	})
}

func (a *App) handleRoomMembers(w http.ResponseWriter, r *http.Request, auth AuthContext, roomID int64) {
	if r.Method != http.MethodGet {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if err := a.ensureMembership(ctx, auth.UserID, roomID); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			respondJSON(w, http.StatusForbidden, map[string]any{"error": "not a room member"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to validate room membership"})
		return
	}

	type roomMember struct {
		ID                int64  `json:"id"`
		Username          string `json:"username"`
		Role              string `json:"role"`
		CreatedAt         string `json:"createdAt"`
		LastReadMessageID int64  `json:"lastReadMessageId"`
	}
	rows, err := a.db.QueryContext(ctx, `
SELECT u.id, u.username, u.role, u.created_at, rm.last_read_message_id
FROM room_members rm
JOIN users u ON u.id = rm.user_id
WHERE rm.room_id = $1
ORDER BY u.id ASC
`, roomID)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to list room members"})
		return
	}
	defer rows.Close()

	members := make([]roomMember, 0, 16)
	for rows.Next() {
		var item roomMember
		var createdAt time.Time
		if err := rows.Scan(&item.ID, &item.Username, &item.Role, &createdAt, &item.LastReadMessageID); err != nil {
			respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to decode room members"})
			return
		}
		item.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
		members = append(members, item)
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"roomId":  roomID,
		"members": members,
	})
}
