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

func TestHubUnicastSummaryTargetsOnlyRequestedUser(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	aliceDesktop := &SummaryClient{userID: 1, deviceID: "desktop-01", send: make(chan []byte, 2)}
	aliceMobile := &SummaryClient{userID: 1, deviceID: "mobile-01", send: make(chan []byte, 2)}
	bobDesktop := &SummaryClient{userID: 2, deviceID: "desktop-02", send: make(chan []byte, 2)}

	hub.AddSummaryClient(aliceDesktop)
	hub.AddSummaryClient(aliceMobile)
	hub.AddSummaryClient(bobDesktop)

	hub.UnicastSummary(1, []byte("room-summary"))

	if got := <-aliceDesktop.send; string(got) != "room-summary" {
		t.Fatalf("unexpected alice desktop payload: %q", string(got))
	}
	if got := <-aliceMobile.send; string(got) != "room-summary" {
		t.Fatalf("unexpected alice mobile payload: %q", string(got))
	}
	select {
	case <-bobDesktop.send:
		t.Fatalf("different user should not receive room summary")
	default:
	}
}

func TestHubBroadcastToRoomsDeduplicatesMultiRoomClients(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	// Alice has two browser tabs in two different rooms; both should receive
	// the broadcast exactly once.
	aliceRoomOne := &Client{roomID: 1, userID: 1, deviceID: "alice-01", send: make(chan []byte, 4)}
	aliceRoomTwo := &Client{roomID: 2, userID: 1, deviceID: "alice-01", send: make(chan []byte, 4)}
	bobRoomOne := &Client{roomID: 1, userID: 2, deviceID: "bob-01", send: make(chan []byte, 4)}
	carolRoomThree := &Client{roomID: 3, userID: 3, deviceID: "carol-01", send: make(chan []byte, 4)}

	hub.AddClient(aliceRoomOne)
	hub.AddClient(aliceRoomTwo)
	hub.AddClient(bobRoomOne)
	hub.AddClient(carolRoomThree)

	hub.BroadcastToRooms([]int64{1, 2}, []byte("bundle-changed"))

	if got := <-aliceRoomOne.send; string(got) != "bundle-changed" {
		t.Fatalf("unexpected alice room one payload: %q", string(got))
	}
	if got := <-aliceRoomTwo.send; string(got) != "bundle-changed" {
		t.Fatalf("unexpected alice room two payload: %q", string(got))
	}
	if got := <-bobRoomOne.send; string(got) != "bundle-changed" {
		t.Fatalf("unexpected bob room one payload: %q", string(got))
	}
	select {
	case <-carolRoomThree.send:
		t.Fatalf("client outside the listed rooms should not receive broadcast")
	default:
	}
}

func TestHubBroadcastToRoomsEmptyRoomList(t *testing.T) {
	t.Parallel()

	hub := NewHub()
	alice := &Client{roomID: 1, userID: 1, deviceID: "alice-01", send: make(chan []byte, 1)}
	hub.AddClient(alice)

	hub.BroadcastToRooms(nil, []byte("noop"))
	hub.BroadcastToRooms([]int64{}, []byte("noop"))

	select {
	case <-alice.send:
		t.Fatalf("expected no payloads when broadcasting to empty room list")
	default:
	}
}
