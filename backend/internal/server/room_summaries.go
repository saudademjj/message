package server

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"time"
)

func listRoomSummaries(ctx context.Context, db *sql.DB, userID int64, deviceID string) ([]RoomSummary, error) {
	rows, err := db.QueryContext(ctx, `
SELECT
    r.id,
    r.name,
    r.created_at,
    MAX(m.id) AS last_message_id,
    COALESCE(MAX(m.created_at), r.created_at) AS last_activity_at,
    COUNT(e.message_id) FILTER (
        WHERE e.read_at IS NULL
          AND m.sender_id <> $1
    ) AS unread_count
FROM rooms r
JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = $1
LEFT JOIN messages m ON m.room_id = r.id
LEFT JOIN chat_mailbox.device_envelopes e
  ON e.message_id = m.id
 AND e.recipient_user_id = $1
 AND e.recipient_device_id = $2
GROUP BY r.id, r.name, r.created_at
ORDER BY COALESCE(MAX(m.created_at), r.created_at) DESC, r.id DESC
`, userID, deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	summaries := make([]RoomSummary, 0, 16)
	for rows.Next() {
		summary, scanErr := scanRoomSummary(rows.Scan)
		if scanErr != nil {
			return nil, scanErr
		}
		summaries = append(summaries, summary)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	sortRoomSummaries(summaries)
	return summaries, nil
}

func loadRoomSummary(ctx context.Context, db *sql.DB, userID int64, deviceID string, roomID int64) (RoomSummary, error) {
	return scanRoomSummary(db.QueryRowContext(ctx, `
SELECT
    r.id,
    r.name,
    r.created_at,
    MAX(m.id) AS last_message_id,
    COALESCE(MAX(m.created_at), r.created_at) AS last_activity_at,
    COUNT(e.message_id) FILTER (
        WHERE e.read_at IS NULL
          AND m.sender_id <> $1
    ) AS unread_count
FROM rooms r
JOIN room_members rm ON rm.room_id = r.id AND rm.user_id = $1
LEFT JOIN messages m ON m.room_id = r.id
LEFT JOIN chat_mailbox.device_envelopes e
  ON e.message_id = m.id
 AND e.recipient_user_id = $1
 AND e.recipient_device_id = $2
WHERE r.id = $3
GROUP BY r.id, r.name, r.created_at
`, userID, deviceID, roomID).Scan)
}

func scanRoomSummary(scan func(dest ...any) error) (RoomSummary, error) {
	var (
		summary        RoomSummary
		createdAt      time.Time
		lastMessageID  sql.NullInt64
		lastActivityAt time.Time
	)
	if err := scan(
		&summary.ID,
		&summary.Name,
		&createdAt,
		&lastMessageID,
		&lastActivityAt,
		&summary.UnreadCount,
	); err != nil {
		return RoomSummary{}, err
	}
	summary.CreatedAt = createdAt.UTC().Format(time.RFC3339Nano)
	summary.LastActivityAt = lastActivityAt.UTC().Format(time.RFC3339Nano)
	if lastMessageID.Valid {
		value := lastMessageID.Int64
		summary.LastMessageID = &value
	}
	return summary, nil
}

func sortRoomSummaries(summaries []RoomSummary) {
	sort.SliceStable(summaries, func(left, right int) bool {
		leftAt, leftErr := time.Parse(time.RFC3339Nano, summaries[left].LastActivityAt)
		rightAt, rightErr := time.Parse(time.RFC3339Nano, summaries[right].LastActivityAt)
		if leftErr == nil && rightErr == nil && !leftAt.Equal(rightAt) {
			return leftAt.After(rightAt)
		}
		return summaries[left].ID > summaries[right].ID
	})
}

func (a *App) publishRoomSummaryUpdate(userID int64, deviceID string, roomID int64) {
	if a.hub == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	summary, err := loadRoomSummary(ctx, a.db, userID, deviceID, roomID)
	if err != nil {
		if !errors.Is(err, sql.ErrNoRows) {
			logger.Warn(
				"load_room_summary_failed",
				"user_id",
				userID,
				"room_id",
				roomID,
				"error",
				err,
			)
		}
		return
	}
	payload, err := json.Marshal(map[string]any{
		"type": "room_summary_update",
		"room": summary,
	})
	if err != nil {
		return
	}
	a.hub.UnicastSummaryToDevice(userID, deviceID, payload)
}

func (a *App) publishRoomSummaryUpdatesForRoom(roomID int64) {
	if a.hub == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	rows, err := a.db.QueryContext(ctx, `
SELECT rm.user_id, d.device_id
FROM room_members rm
JOIN user_devices d ON d.user_id = rm.user_id AND d.revoked_at IS NULL
WHERE rm.room_id = $1
`, roomID)
	if err != nil {
		logger.Warn("list_room_summary_recipients_failed", "room_id", roomID, "error", err)
		return
	}
	defer rows.Close()

	type targetDevice struct {
		userID   int64
		deviceID string
	}
	targets := make([]targetDevice, 0, 8)
	for rows.Next() {
		var target targetDevice
		if err := rows.Scan(&target.userID, &target.deviceID); err != nil {
			logger.Warn("decode_room_summary_recipient_failed", "room_id", roomID, "error", err)
			return
		}
		targets = append(targets, target)
	}
	if err := rows.Err(); err != nil {
		logger.Warn("iterate_room_summary_recipients_failed", "room_id", roomID, "error", err)
		return
	}
	for _, target := range targets {
		a.publishRoomSummaryUpdate(target.userID, target.deviceID, roomID)
	}
}
