package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestHandleAccountProfileMethodNotAllowed(t *testing.T) {
	t.Parallel()

	app := &App{adminUsername: "admin"}
	auth := AuthContext{UserID: 2, Username: "alice", Role: "user", DeviceID: "device-a"}

	request := httptest.NewRequest(http.MethodGet, "/api/account/profile", nil)
	response := httptest.NewRecorder()

	app.handleAccountProfile(response, request, auth)

	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected %d, got %d", http.StatusMethodNotAllowed, response.Code)
	}
}

func TestHandleAccountProfileAdminGuard(t *testing.T) {
	t.Parallel()

	app := &App{adminUsername: "admin"}

	t.Run("role admin rejected", func(t *testing.T) {
		auth := AuthContext{UserID: 1, Username: "root", Role: "admin", DeviceID: "device-a"}
		request := httptest.NewRequest(http.MethodPatch, "/api/account/profile", strings.NewReader(`{"username":"newname"}`))
		response := httptest.NewRecorder()

		app.handleAccountProfile(response, request, auth)

		if response.Code != http.StatusForbidden {
			t.Fatalf("expected %d, got %d", http.StatusForbidden, response.Code)
		}
		payload := decodeBodyMap(t, response)
		if payload["error"] != "管理员账号请通过部署配置修改" {
			t.Fatalf("unexpected payload: %#v", payload)
		}
	})

	t.Run("admin username rejected", func(t *testing.T) {
		auth := AuthContext{UserID: 1, Username: "admin", Role: "user", DeviceID: "device-a"}
		request := httptest.NewRequest(http.MethodPatch, "/api/account/profile", strings.NewReader(`{"username":"newname"}`))
		response := httptest.NewRecorder()

		app.handleAccountProfile(response, request, auth)

		if response.Code != http.StatusForbidden {
			t.Fatalf("expected %d, got %d", http.StatusForbidden, response.Code)
		}
	})
}

func TestHandleAccountProfileValidation(t *testing.T) {
	t.Parallel()

	app := &App{adminUsername: "admin"}
	auth := AuthContext{UserID: 2, Username: "alice", Role: "user", DeviceID: "device-a"}

	t.Run("invalid json", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPatch, "/api/account/profile", strings.NewReader(`{`))
		response := httptest.NewRecorder()

		app.handleAccountProfile(response, request, auth)

		if response.Code != http.StatusBadRequest {
			t.Fatalf("expected %d, got %d", http.StatusBadRequest, response.Code)
		}
		payload := decodeBodyMap(t, response)
		if payload["error"] != "invalid json body" {
			t.Fatalf("unexpected payload: %#v", payload)
		}
	})

	t.Run("username too short", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPatch, "/api/account/profile", strings.NewReader(`{"username":"ab"}`))
		response := httptest.NewRecorder()

		app.handleAccountProfile(response, request, auth)

		if response.Code != http.StatusBadRequest {
			t.Fatalf("expected %d, got %d", http.StatusBadRequest, response.Code)
		}
		payload := decodeBodyMap(t, response)
		if payload["error"] != "username length must be between 3 and 32" {
			t.Fatalf("unexpected payload: %#v", payload)
		}
	})

	t.Run("reserved admin username", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPatch, "/api/account/profile", strings.NewReader(`{"username":"admin"}`))
		response := httptest.NewRecorder()

		app.handleAccountProfile(response, request, auth)

		if response.Code != http.StatusConflict {
			t.Fatalf("expected %d, got %d", http.StatusConflict, response.Code)
		}
		payload := decodeBodyMap(t, response)
		if payload["error"] != "username already exists" {
			t.Fatalf("unexpected payload: %#v", payload)
		}
	})
}

func TestHandleAccountPasswordMethodNotAllowed(t *testing.T) {
	t.Parallel()

	app := &App{adminUsername: "admin"}
	auth := AuthContext{UserID: 2, Username: "alice", Role: "user", DeviceID: "device-a"}

	request := httptest.NewRequest(http.MethodGet, "/api/account/password", nil)
	response := httptest.NewRecorder()

	app.handleAccountPassword(response, request, auth)

	if response.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected %d, got %d", http.StatusMethodNotAllowed, response.Code)
	}
}

func TestHandleAccountPasswordAdminGuard(t *testing.T) {
	t.Parallel()

	app := &App{adminUsername: "admin"}
	auth := AuthContext{UserID: 1, Username: "root", Role: "admin", DeviceID: "device-a"}

	request := httptest.NewRequest(http.MethodPost, "/api/account/password", strings.NewReader(`{"currentPassword":"oldpassword","newPassword":"newpassword"}`))
	response := httptest.NewRecorder()

	app.handleAccountPassword(response, request, auth)

	if response.Code != http.StatusForbidden {
		t.Fatalf("expected %d, got %d", http.StatusForbidden, response.Code)
	}
	payload := decodeBodyMap(t, response)
	if payload["error"] != "管理员账号请通过部署配置修改" {
		t.Fatalf("unexpected payload: %#v", payload)
	}
}

func TestHandleAccountPasswordValidation(t *testing.T) {
	t.Parallel()

	app := &App{adminUsername: "admin"}
	auth := AuthContext{UserID: 2, Username: "alice", Role: "user", DeviceID: "device-a"}

	t.Run("invalid json", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/api/account/password", strings.NewReader(`{`))
		response := httptest.NewRecorder()

		app.handleAccountPassword(response, request, auth)

		if response.Code != http.StatusBadRequest {
			t.Fatalf("expected %d, got %d", http.StatusBadRequest, response.Code)
		}
		payload := decodeBodyMap(t, response)
		if payload["error"] != "invalid json body" {
			t.Fatalf("unexpected payload: %#v", payload)
		}
	})

	t.Run("new password too short", func(t *testing.T) {
		request := httptest.NewRequest(http.MethodPost, "/api/account/password", strings.NewReader(`{"currentPassword":"oldpassword","newPassword":"short"}`))
		response := httptest.NewRecorder()

		app.handleAccountPassword(response, request, auth)

		if response.Code != http.StatusBadRequest {
			t.Fatalf("expected %d, got %d", http.StatusBadRequest, response.Code)
		}
		payload := decodeBodyMap(t, response)
		if payload["error"] != "password length must be between 8 and 128" {
			t.Fatalf("unexpected payload: %#v", payload)
		}
	})
}
