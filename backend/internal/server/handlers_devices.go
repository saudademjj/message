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
	if (len(parts) != 3 && len(parts) != 4 && len(parts) != 5) || parts[0] != "api" || parts[1] != "devices" {
		respondJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	deviceID := normalizeDeviceID(parts[2])
	if deviceID == "" {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid device id"})
		return
	}
	if len(parts) == 5 {
		if parts[3] == "envelopes" && parts[4] == "refill" {
			a.handleDeviceEnvelopeRefillCommit(w, r, auth, deviceID)
			return
		}
		respondJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		return
	}
	if len(parts) == 4 {
		switch parts[3] {
		case "approve":
			a.handleApproveDevice(w, r, auth, deviceID)
		case "envelopes":
			a.handleDeviceEnvelopeRefill(w, r, auth, deviceID)
		case "envelopes-refill":
			a.handleDeviceEnvelopeRefill(w, r, auth, deviceID)
		default:
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "not found"})
		}
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

func (a *App) handleApproveDevice(w http.ResponseWriter, r *http.Request, auth AuthContext, deviceID string) {
	if r.Method != http.MethodPost {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	if deviceID == auth.DeviceID {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "current device is already active"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	approver, err := a.loadActiveDevice(ctx, auth.UserID, auth.DeviceID)
	if err != nil || approver.TrustStatus != "approved" {
		respondJSON(w, http.StatusForbidden, map[string]any{"error": "only an approved existing device can approve a new device"})
		return
	}
	device, err := a.approveUserDevice(ctx, auth.UserID, deviceID, auth.UserID)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) || errors.Is(err, errInvalidIdentity) {
			respondJSON(w, http.StatusNotFound, map[string]any{"error": "device not found"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to approve device"})
		return
	}
	go a.publishUserBundleChanged(auth.UserID, deviceID, "")
	respondJSON(w, http.StatusOK, map[string]any{"device": toDeviceSnapshot(device, auth.DeviceID)})
}

func (a *App) handleDeviceEnvelopeRefill(w http.ResponseWriter, r *http.Request, auth AuthContext, deviceID string) {
	if r.Method != http.MethodPost {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	var req struct {
		RoomID     int64   `json:"roomId"`
		MessageIDs []int64 `json:"messageIds"`
	}
	if err := decodeJSON(r, &req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	if req.RoomID <= 0 || len(req.MessageIDs) > 200 {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "roomId and up to 200 messageIds are required"})
		return
	}
	if deviceID == auth.DeviceID {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "cannot refill current device"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	if err := a.ensureMembership(ctx, auth.UserID, req.RoomID); err != nil {
		respondJSON(w, http.StatusForbidden, map[string]any{"error": "not a room member"})
		return
	}
	device, err := a.loadActiveDevice(ctx, auth.UserID, deviceID)
	if err != nil || device.TrustStatus != "approved" {
		respondJSON(w, http.StatusForbidden, map[string]any{"error": "target device must be approved before refill"})
		return
	}
	missing, err := a.listMissingEnvelopeMessages(ctx, auth.UserID, deviceID, req.RoomID, req.MessageIDs)
	if err != nil {
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to inspect missing envelopes"})
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"roomId":     req.RoomID,
		"deviceId":   deviceID,
		"messageIds": missing,
	})
}

func (a *App) handleDeviceEnvelopeRefillCommit(w http.ResponseWriter, r *http.Request, auth AuthContext, deviceID string) {
	if r.Method != http.MethodPut {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	var req struct {
		RoomID    int64                       `json:"roomId"`
		Envelopes []DeviceEnvelopeRefillEntry `json:"envelopes"`
	}
	if err := decodeJSON(r, &req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid json body"})
		return
	}
	if req.RoomID <= 0 || len(req.Envelopes) == 0 || len(req.Envelopes) > 200 {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "roomId and 1..200 envelopes are required"})
		return
	}
	if deviceID == auth.DeviceID {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "cannot refill current device"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := a.ensureMembership(ctx, auth.UserID, req.RoomID); err != nil {
		respondJSON(w, http.StatusForbidden, map[string]any{"error": "not a room member"})
		return
	}
	device, err := a.loadActiveDevice(ctx, auth.UserID, deviceID)
	if err != nil || device.TrustStatus != "approved" {
		respondJSON(w, http.StatusForbidden, map[string]any{"error": "target device must be approved before refill"})
		return
	}
	inserted, err := a.storeDeviceEnvelopeRefill(
		ctx,
		auth.UserID,
		deviceID,
		req.RoomID,
		auth.UserID,
		auth.DeviceID,
		req.Envelopes,
	)
	if err != nil {
		if errors.Is(err, errInvalidIdentity) || errors.Is(err, errInvalidPayloadFormat) {
			respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid envelope refill"})
			return
		}
		respondJSON(w, http.StatusInternalServerError, map[string]any{"error": "failed to store envelope refill"})
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"roomId":   req.RoomID,
		"deviceId": deviceID,
		"inserted": inserted,
	})
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
	go a.publishUserBundleChanged(auth.UserID, deviceID, "")
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
