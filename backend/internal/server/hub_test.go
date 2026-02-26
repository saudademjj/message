package server

import (
	"encoding/json"
	"testing"
)

func TestHubAddClientAndPeerSnapshot(t *testing.T) {
	t.Parallel()

	hub := NewHub()

	first := &Client{roomID: 1, userID: 1, username: "alice", send: make(chan []byte, 2)}
	first.setPublicKey(json.RawMessage(`{"k":"pub-1"}`))
	first.setSigningPublicKey(json.RawMessage(`{"k":"sig-1"}`))
	if peers := hub.AddClient(first); len(peers) != 0 {
		t.Fatalf("expected no peers for first join, got %d", len(peers))
	}

	second := &Client{roomID: 1, userID: 2, username: "bob", send: make(chan []byte, 2)}
	peers := hub.AddClient(second)
	if len(peers) != 1 {
		t.Fatalf("expected 1 peer, got %d", len(peers))
	}
	if peers[0].UserID != 1 || peers[0].Username != "alice" {
		t.Fatalf("unexpected peer snapshot: %+v", peers[0])
	}
}

func TestHubBroadcastAndUnicast(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	alice := &Client{roomID: 7, userID: 1, username: "alice", send: make(chan []byte, 2)}
	bob := &Client{roomID: 7, userID: 2, username: "bob", send: make(chan []byte, 2)}
	otherRoom := &Client{roomID: 8, userID: 3, username: "carol", send: make(chan []byte, 2)}

	hub.AddClient(alice)
	hub.AddClient(bob)
	hub.AddClient(otherRoom)

	payload := []byte("frame")
	hub.Broadcast(7, payload)

	if got := <-alice.send; string(got) != "frame" {
		t.Fatalf("unexpected alice payload: %q", string(got))
	}
	if got := <-bob.send; string(got) != "frame" {
		t.Fatalf("unexpected bob payload: %q", string(got))
	}
	select {
	case <-otherRoom.send:
		t.Fatalf("other room should not receive broadcast")
	default:
	}

	hub.Unicast(7, 2, []byte("direct"))
	if got := <-bob.send; string(got) != "direct" {
		t.Fatalf("unexpected bob unicast payload: %q", string(got))
	}
	select {
	case <-alice.send:
		t.Fatalf("alice should not receive bob unicast")
	default:
	}
}

func TestHubRemoveClient(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	client := &Client{roomID: 42, userID: 1, username: "alice", send: make(chan []byte, 1)}
	hub.AddClient(client)
	hub.RemoveClient(client)

	hub.mu.RLock()
	_, exists := hub.rooms[42]
	hub.mu.RUnlock()
	if exists {
		t.Fatalf("expected room to be removed after last client leaves")
	}
}

func TestHubUnicastToDevice(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	aliceMobile := &Client{roomID: 9, userID: 1, username: "alice", deviceID: "mobile-01", send: make(chan []byte, 2)}
	aliceDesktop := &Client{roomID: 9, userID: 1, username: "alice", deviceID: "desktop-01", send: make(chan []byte, 2)}
	bobMobile := &Client{roomID: 9, userID: 2, username: "bob", deviceID: "mobile-02", send: make(chan []byte, 2)}

	hub.AddClient(aliceMobile)
	hub.AddClient(aliceDesktop)
	hub.AddClient(bobMobile)

	hub.UnicastToDevice(9, 1, "desktop-01", []byte("desktop-only"))

	if got := <-aliceDesktop.send; string(got) != "desktop-only" {
		t.Fatalf("unexpected desktop payload: %q", string(got))
	}
	select {
	case <-aliceMobile.send:
		t.Fatalf("mobile client should not receive desktop-targeted unicast")
	default:
	}
	select {
	case <-bobMobile.send:
		t.Fatalf("different user should not receive device-targeted unicast")
	default:
	}
}
