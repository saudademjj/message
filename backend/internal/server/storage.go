package server

import (
	"context"
	"encoding/json"
	"time"
)

func (a *App) storeMessage(ctx context.Context, roomID, senderID int64, payload CipherPayload) (int64, time.Time, error) {
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return 0, time.Time{}, err
	}

	var messageID int64
	var createdAt time.Time
	err = a.db.QueryRowContext(ctx, `
INSERT INTO messages(room_id, sender_id, payload)
VALUES ($1, $2, $3)
RETURNING id, created_at
`, roomID, senderID, payloadJSON).Scan(&messageID, &createdAt)
	if err != nil {
		return 0, time.Time{}, err
	}

	return messageID, createdAt, nil
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
