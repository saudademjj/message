package server

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
)

func (a *App) handleRoomSummaryWS(w http.ResponseWriter, r *http.Request) {
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

	conn, err := a.upgrader.Upgrade(w, r, nil)
	if err != nil {
		logger.Error("room_summary_websocket_upgrade_failed", "error", err)
		return
	}

	client := &SummaryClient{
		app:        a,
		conn:       conn,
		send:       make(chan []byte, 64),
		userID:     auth.UserID,
		username:   auth.Username,
		deviceID:   auth.DeviceID,
		deviceName: auth.DeviceName,
		sessionVer: auth.DeviceSessionVersion,
		tokenExp:   auth.TokenExpiresAt,
	}
	a.hub.AddSummaryClient(client)

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	summaries, err := listRoomSummaries(ctx, a.db, auth.UserID, auth.DeviceID)
	cancel()
	if err != nil {
		logger.Error("load_initial_room_summaries_failed", "user_id", auth.UserID, "error", err)
		_ = conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseInternalServerErr, "failed to load room summaries"),
			time.Now().Add(time.Second),
		)
		_ = conn.Close()
		a.hub.RemoveSummaryClient(client)
		return
	}
	if payload, err := json.Marshal(map[string]any{
		"type":  "room_summaries",
		"rooms": summaries,
	}); err == nil {
		client.send <- payload
	}

	go client.writePump()
	client.readPump()
}

func (c *SummaryClient) readPump() {
	defer func() {
		c.app.hub.RemoveSummaryClient(c)
		_ = c.conn.Close()
	}()

	c.conn.SetReadLimit(1 << 20)
	_ = c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		return c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	})

	for {
		if _, _, err := c.conn.ReadMessage(); err != nil {
			return
		}
	}
}

func (c *SummaryClient) writePump() {
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
					"room_summary_websocket_write_failed",
					"user_id",
					c.userID,
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
					"room_summary_websocket_ping_failed",
					"user_id",
					c.userID,
					"remote_addr",
					c.conn.RemoteAddr().String(),
					"error",
					err,
				)
				return
			}
		case <-authTicker.C:
			if !c.validateStillAuthorized() {
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

func (c *SummaryClient) validateStillAuthorized() bool {
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
