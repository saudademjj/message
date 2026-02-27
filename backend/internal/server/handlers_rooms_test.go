package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestDecideDirectJoin(t *testing.T) {
	t.Parallel()

	if decision := decideDirectJoin("admin", true); !decision.Allowed {
		t.Fatalf("expected admin to join system room")
	}
	if decision := decideDirectJoin("admin", false); !decision.Allowed {
		t.Fatalf("expected admin to join normal room")
	}

	userSystem := decideDirectJoin("user", true)
	if userSystem.Allowed || userSystem.Code != "system_room_admin_only" {
		t.Fatalf("unexpected decision for user/system room: %#v", userSystem)
	}

	userNormal := decideDirectJoin("user", false)
	if userNormal.Allowed || userNormal.Code != "invite_required" {
		t.Fatalf("unexpected decision for user/normal room: %#v", userNormal)
	}
}

func TestDecideSystemRoomAccess(t *testing.T) {
	t.Parallel()

	if decision := decideSystemRoomAccess("admin", true); !decision.Allowed {
		t.Fatalf("expected admin system-room access")
	}
	if decision := decideSystemRoomAccess("user", false); !decision.Allowed {
		t.Fatalf("expected non-system room access for user")
	}
	userSystem := decideSystemRoomAccess("user", true)
	if userSystem.Allowed || userSystem.Code != "system_room_admin_only" {
		t.Fatalf("unexpected decision for user/system room: %#v", userSystem)
	}
}

func TestHandleRoomSubroutesGuards(t *testing.T) {
	t.Parallel()

	app := &App{}
	auth := AuthContext{UserID: 1, Username: "alice", Role: "user"}

	t.Run("invalid path", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/api/rooms", nil)
		response := httptest.NewRecorder()

		app.handleRoomSubroutes(response, request, auth)

		if response.Code != http.StatusNotFound {
			t.Fatalf("expected %d, got %d", http.StatusNotFound, response.Code)
		}
	})

	t.Run("invalid room id", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/api/rooms/abc/messages", nil)
		response := httptest.NewRecorder()

		app.handleRoomSubroutes(response, request, auth)

		if response.Code != http.StatusBadRequest {
			t.Fatalf("expected %d, got %d", http.StatusBadRequest, response.Code)
		}
	})

	t.Run("unknown action", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/api/rooms/1/unknown", nil)
		response := httptest.NewRecorder()

		app.handleRoomSubroutes(response, request, auth)

		if response.Code != http.StatusNotFound {
			t.Fatalf("expected %d, got %d", http.StatusNotFound, response.Code)
		}
	})
}

func TestHandleRoomMethodsWithoutDB(t *testing.T) {
	t.Parallel()

	app := &App{}
	auth := AuthContext{UserID: 1, Username: "alice", Role: "user"}

	t.Run("delete room wrong method", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/api/rooms/1", nil)
		response := httptest.NewRecorder()

		app.handleDeleteRoom(response, request, auth, 1)

		if response.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected %d, got %d", http.StatusMethodNotAllowed, response.Code)
		}
	})

	t.Run("join room wrong method", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/api/rooms/1/join", nil)
		response := httptest.NewRecorder()

		app.handleJoinRoom(response, request, auth, 1)

		if response.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected %d, got %d", http.StatusMethodNotAllowed, response.Code)
		}
	})

	t.Run("messages wrong method", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/api/rooms/1/messages", nil)
		response := httptest.NewRecorder()

		app.handleRoomMessages(response, request, auth, 1)

		if response.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected %d, got %d", http.StatusMethodNotAllowed, response.Code)
		}
	})

	t.Run("members wrong method", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/api/rooms/1/members", nil)
		response := httptest.NewRecorder()

		app.handleRoomMembers(response, request, auth, 1)

		if response.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected %d, got %d", http.StatusMethodNotAllowed, response.Code)
		}
	})

	t.Run("invite join wrong method", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodGet, "/api/invites/join", nil)
		response := httptest.NewRecorder()

		app.handleInviteJoin(response, request, auth)

		if response.Code != http.StatusMethodNotAllowed {
			t.Fatalf("expected %d, got %d", http.StatusMethodNotAllowed, response.Code)
		}
	})
}
