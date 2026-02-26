package server

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strings"
	"time"
)

func (a *App) handleDevices(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	if r.Method != http.MethodGet {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	devices, err := a.listUserDevices(ctx, auth.UserID)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to load devices"})
		return
	}
	response := make([]DeviceSnapshot, 0, len(devices))
	for _, item := range devices {
		response = append(response, toDeviceSnapshot(item, auth.DeviceID))
	}
	respondJSON(w, http.StatusOK, map[string]any{"devices": response})
}

func (a *App) handleDeviceSubroutes(w http.ResponseWriter, r *http.Request, auth AuthContext) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 3 || parts[0] != "api" || parts[1] != "devices" {
		respondJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	deviceID := normalizeDeviceID(parts[2])
	if deviceID == "" {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid device id"})
		return
	}
	switch r.Method {
	case http.MethodPatch:
		a.handleRenameDevice(w, r, auth, deviceID)
	case http.MethodDelete:
		a.handleRevokeDevice(w, r, auth, deviceID)
	default:
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
	}
}

func (a *App) handleRenameDevice(w http.ResponseWriter, r *http.Request, auth AuthContext, deviceID string) {
	var req struct {
		DeviceName string `json:"deviceName"`
		Name       string `json:"name"`
	}
	if err := decodeJSON(r, &req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	name := req.DeviceName
	if strings.TrimSpace(name) == "" {
		name = req.Name
	}
	nextName := normalizeDeviceName(name, defaultDeviceName)

	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	device, err := a.renameUserDevice(ctx, auth.UserID, deviceID, nextName)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, errInvalidIdentity) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "device not found"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to rename device"})
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{"device": toDeviceSnapshot(device, auth.DeviceID)})
}

func (a *App) handleRevokeDevice(w http.ResponseWriter, r *http.Request, auth AuthContext, deviceID string) {
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()

	device, err := a.revokeUserDevice(ctx, auth.UserID, deviceID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, errInvalidIdentity) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "device not found"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to revoke device"})
		return
	}
	if err := a.revokeRefreshTokensForDevice(ctx, auth.UserID, deviceID); err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to revoke device sessions"})
		return
	}

	wasCurrent := device.DeviceID == auth.DeviceID
	a.hub.KickUserDevice(auth.UserID, deviceID, 4004, "device revoked")
	if wasCurrent {
		clearSessionCookies(w, isSecureRequest(r))
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"revoked":      true,
		"forcedLogout": wasCurrent,
		"device":       toDeviceSnapshot(device, auth.DeviceID),
	})
}

