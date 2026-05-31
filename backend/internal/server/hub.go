package server

import (
	"encoding/json"
	"time"

	"github.com/gorilla/websocket"
)

func NewHub() *Hub {
	return &Hub{
		rooms:        make(map[int64]map[*Client]struct{}),
		summaryUsers: make(map[int64]map[*SummaryClient]struct{}),
	}
}

var _ Broadcaster = (*Hub)(nil)

func (h *Hub) AddClient(client *Client) []PeerSnapshot {
	h.mu.Lock()
	defer h.mu.Unlock()

	roomClients, ok := h.rooms[client.roomID]
	if !ok {
		roomClients = make(map[*Client]struct{})
		h.rooms[client.roomID] = roomClients
	}

	peers := make([]PeerSnapshot, 0, len(roomClients))
	for peer := range roomClients {
		pub, signing := peer.getAnnouncedKeys()
		if len(pub) == 0 || len(signing) == 0 {
			continue
		}
		peers = append(peers, PeerSnapshot{
			UserID:              peer.userID,
			Username:            peer.username,
			DeviceID:            peer.deviceID,
			DeviceName:          peer.deviceName,
			PublicKeyJWK:        pub,
			SigningPublicKeyJWK: signing,
		})
	}

	roomClients[client] = struct{}{}
	return peers
}

func (h *Hub) KickUserDevice(userID int64, deviceID string, code int, reason string) {
	h.mu.RLock()
	targets := make([]*Client, 0, 4)
	summaryTargets := make([]*SummaryClient, 0, 2)
	for _, roomClients := range h.rooms {
		for client := range roomClients {
			if client.userID == userID && client.deviceID == deviceID {
				targets = append(targets, client)
			}
		}
	}
	for client := range h.summaryUsers[userID] {
		if client.deviceID == deviceID {
			summaryTargets = append(summaryTargets, client)
		}
	}
	h.mu.RUnlock()

	if len(targets) == 0 && len(summaryTargets) == 0 {
		return
	}

	deadline := time.Now().Add(1 * time.Second)
	for _, client := range targets {
		_ = client.conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(code, reason),
			deadline,
		)
		_ = client.conn.Close()
	}
	for _, client := range summaryTargets {
		_ = client.conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(code, reason),
			deadline,
		)
		_ = client.conn.Close()
	}
}

func (h *Hub) RemoveClient(client *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	roomClients, ok := h.rooms[client.roomID]
	if !ok {
		return
	}

	delete(roomClients, client)
	if len(roomClients) == 0 {
		delete(h.rooms, client.roomID)
	}
}

func (h *Hub) Broadcast(roomID int64, payload []byte) {
	h.mu.RLock()
	roomClients, ok := h.rooms[roomID]
	if !ok {
		h.mu.RUnlock()
		return
	}
	clients := make([]*Client, 0, len(roomClients))
	for client := range roomClients {
		clients = append(clients, client)
	}
	h.mu.RUnlock()

	for _, client := range clients {
		select {
		case client.send <- payload:
		default:
			logger.Warn(
				"websocket_broadcast_drop",
				"user_id",
				client.userID,
				"room_id",
				roomID,
				"reason",
				"send queue full",
			)
		}
	}
}

func (h *Hub) BroadcastToRoomClients(roomID int64, build func(*Client) ([]byte, bool)) {
	h.mu.RLock()
	roomClients, ok := h.rooms[roomID]
	if !ok {
		h.mu.RUnlock()
		return
	}
	clients := make([]*Client, 0, len(roomClients))
	for client := range roomClients {
		clients = append(clients, client)
	}
	h.mu.RUnlock()

	for _, client := range clients {
		payload, ok := build(client)
		if !ok {
			continue
		}
		select {
		case client.send <- payload:
		default:
			logger.Warn(
				"websocket_targeted_broadcast_drop",
				"user_id",
				client.userID,
				"device_id",
				client.deviceID,
				"room_id",
				roomID,
				"reason",
				"send queue full",
			)
		}
	}
}

func (h *Hub) Unicast(roomID int64, userID int64, payload []byte) {
	h.mu.RLock()
	roomClients, ok := h.rooms[roomID]
	if !ok {
		h.mu.RUnlock()
		return
	}
	targets := make([]*Client, 0, len(roomClients))
	for client := range roomClients {
		if client.userID == userID {
			targets = append(targets, client)
		}
	}
	h.mu.RUnlock()

	for _, client := range targets {
		select {
		case client.send <- payload:
		default:
			logger.Warn(
				"websocket_unicast_drop",
				"user_id",
				client.userID,
				"room_id",
				roomID,
				"reason",
				"send queue full",
			)
		}
	}
}

func (h *Hub) UnicastToDevice(roomID int64, userID int64, deviceID string, payload []byte) {
	trimmedDeviceID := normalizeDeviceID(deviceID)
	if trimmedDeviceID == "" {
		h.Unicast(roomID, userID, payload)
		return
	}

	h.mu.RLock()
	roomClients, ok := h.rooms[roomID]
	if !ok {
		h.mu.RUnlock()
		return
	}
	targets := make([]*Client, 0, len(roomClients))
	for client := range roomClients {
		if client.userID == userID && client.deviceID == trimmedDeviceID {
			targets = append(targets, client)
		}
	}
	h.mu.RUnlock()

	for _, client := range targets {
		select {
		case client.send <- payload:
		default:
			logger.Warn(
				"websocket_unicast_device_drop",
				"user_id",
				client.userID,
				"device_id",
				client.deviceID,
				"room_id",
				roomID,
				"reason",
				"send queue full",
			)
		}
	}
}

// BroadcastToRooms delivers the given payload to every connected client in the
// listed rooms. Useful for fan-out events that are not bound to a single
// room (e.g. announcing that a user has updated their multi-device prekey
// bundle so peers in any shared room can refresh their ratchet sessions).
func (h *Hub) BroadcastToRooms(roomIDs []int64, payload []byte) {
	if len(roomIDs) == 0 {
		return
	}
	seenClients := make(map[*Client]struct{}, len(roomIDs)*4)

	h.mu.RLock()
	clients := make([]*Client, 0, len(roomIDs)*4)
	for _, roomID := range roomIDs {
		roomClients, ok := h.rooms[roomID]
		if !ok {
			continue
		}
		for client := range roomClients {
			if _, exists := seenClients[client]; exists {
				continue
			}
			seenClients[client] = struct{}{}
			clients = append(clients, client)
		}
	}
	h.mu.RUnlock()

	for _, client := range clients {
		select {
		case client.send <- payload:
		default:
			logger.Warn(
				"websocket_room_broadcast_drop",
				"user_id",
				client.userID,
				"room_id",
				client.roomID,
				"reason",
				"send queue full",
			)
		}
	}
}

func (h *Hub) AddSummaryClient(client *SummaryClient) {
	h.mu.Lock()
	defer h.mu.Unlock()

	clients, ok := h.summaryUsers[client.userID]
	if !ok {
		clients = make(map[*SummaryClient]struct{})
		h.summaryUsers[client.userID] = clients
	}
	clients[client] = struct{}{}
}

func (h *Hub) RemoveSummaryClient(client *SummaryClient) {
	h.mu.Lock()
	defer h.mu.Unlock()

	clients, ok := h.summaryUsers[client.userID]
	if !ok {
		return
	}
	delete(clients, client)
	if len(clients) == 0 {
		delete(h.summaryUsers, client.userID)
	}
}

func (h *Hub) UnicastSummary(userID int64, payload []byte) {
	h.mu.RLock()
	clients, ok := h.summaryUsers[userID]
	if !ok {
		h.mu.RUnlock()
		return
	}
	targets := make([]*SummaryClient, 0, len(clients))
	for client := range clients {
		targets = append(targets, client)
	}
	h.mu.RUnlock()

	for _, client := range targets {
		select {
		case client.send <- payload:
		default:
			logger.Warn(
				"websocket_room_summary_drop",
				"user_id",
				client.userID,
				"reason",
				"send queue full",
			)
		}
	}
}

func (h *Hub) UnicastSummaryToDevice(userID int64, deviceID string, payload []byte) {
	trimmedDeviceID := normalizeDeviceID(deviceID)
	if trimmedDeviceID == "" {
		h.UnicastSummary(userID, payload)
		return
	}

	h.mu.RLock()
	clients, ok := h.summaryUsers[userID]
	if !ok {
		h.mu.RUnlock()
		return
	}
	targets := make([]*SummaryClient, 0, len(clients))
	for client := range clients {
		if client.deviceID == trimmedDeviceID {
			targets = append(targets, client)
		}
	}
	h.mu.RUnlock()

	for _, client := range targets {
		select {
		case client.send <- payload:
		default:
			logger.Warn(
				"websocket_room_summary_device_drop",
				"user_id",
				client.userID,
				"device_id",
				client.deviceID,
				"reason",
				"send queue full",
			)
		}
	}
}

func (h *Hub) Shutdown() {
	h.mu.Lock()
	clients := make([]*Client, 0, len(h.rooms))
	for _, roomClients := range h.rooms {
		for client := range roomClients {
			clients = append(clients, client)
		}
	}
	summaryClients := make([]*SummaryClient, 0, len(h.summaryUsers))
	for _, users := range h.summaryUsers {
		for client := range users {
			summaryClients = append(summaryClients, client)
		}
	}
	h.rooms = make(map[int64]map[*Client]struct{})
	h.summaryUsers = make(map[int64]map[*SummaryClient]struct{})
	h.mu.Unlock()

	deadline := time.Now().Add(1 * time.Second)
	for _, client := range clients {
		_ = client.conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseGoingAway, "server shutting down"),
			deadline,
		)
		_ = client.conn.Close()
	}
	for _, client := range summaryClients {
		_ = client.conn.WriteControl(
			websocket.CloseMessage,
			websocket.FormatCloseMessage(websocket.CloseGoingAway, "server shutting down"),
			deadline,
		)
		_ = client.conn.Close()
	}
}

func (c *Client) setPublicKey(publicKey json.RawMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.publicKey = append([]byte(nil), publicKey...)
}

func (c *Client) getPublicKey() json.RawMessage {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(c.publicKey) == 0 {
		return nil
	}
	return append([]byte(nil), c.publicKey...)
}

func (c *Client) setSigningPublicKey(publicKey json.RawMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.signingPublicKey = append([]byte(nil), publicKey...)
}

func (c *Client) getSigningPublicKey() json.RawMessage {
	c.mu.RLock()
	defer c.mu.RUnlock()
	if len(c.signingPublicKey) == 0 {
		return nil
	}
	return append([]byte(nil), c.signingPublicKey...)
}

func (c *Client) getAnnouncedKeys() (json.RawMessage, json.RawMessage) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	var publicKey json.RawMessage
	var signingKey json.RawMessage
	if len(c.publicKey) > 0 {
		publicKey = append([]byte(nil), c.publicKey...)
	}
	if len(c.signingPublicKey) > 0 {
		signingKey = append([]byte(nil), c.signingPublicKey...)
	}
	return publicKey, signingKey
}
