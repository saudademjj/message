package server

import (
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	defaultInviteTTL = 72 * time.Hour
)

type InviteClaims struct {
	RoomID     int64  `json:"rid"`
	CreatedBy  int64  `json:"createdBy"`
	InviteType string `json:"inviteType"`
	jwt.RegisteredClaims
}

func (a *App) issueToken(userID int64, username, role, deviceID string, deviceSessionVersion int) (string, error) {
	now := time.Now().UTC()
	ttl := a.effectiveAccessTokenTTL()
	claims := Claims{
		UserID:               userID,
		Username:             username,
		Role:                 role,
		DeviceID:             deviceID,
		DeviceSessionVersion: deviceSessionVersion,
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "e2ee-chat-backend",
			Subject:   fmt.Sprintf("%d", userID),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(now.Add(ttl)),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	return token.SignedString(a.jwtSecret)
}

func generateCSRFToken() (string, error) {
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func (a *App) parseToken(tokenString string) (*Claims, error) {
	claims := &Claims{}
	token, err := jwt.ParseWithClaims(tokenString, claims, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return a.jwtSecret, nil
	})
	if err != nil || !token.Valid {
		return nil, errors.New("invalid token")
	}
	if claims.UserID <= 0 || strings.TrimSpace(claims.Username) == "" {
		return nil, errors.New("invalid token claims")
	}
	if claims.Role != "admin" && claims.Role != "user" {
		return nil, errors.New("invalid token claims")
	}
	if normalizeDeviceID(claims.DeviceID) == "" || claims.DeviceSessionVersion <= 0 {
		return nil, errors.New("invalid token claims")
	}
	return claims, nil
}

func (a *App) issueInviteToken(roomID, createdBy int64) (string, time.Time, error) {
	now := time.Now().UTC()
	expiresAt := now.Add(defaultInviteTTL)
	claims := InviteClaims{
		RoomID:     roomID,
		CreatedBy:  createdBy,
		InviteType: "room_join",
		RegisteredClaims: jwt.RegisteredClaims{
			Issuer:    "e2ee-chat-backend",
			Subject:   strconv.FormatInt(roomID, 10),
			IssuedAt:  jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(expiresAt),
		},
	}
	token := jwt.NewWithClaims(jwt.SigningMethodHS256, claims)
	signed, err := token.SignedString(a.jwtSecret)
	if err != nil {
		return "", time.Time{}, err
	}
	return signed, expiresAt, nil
}

func (a *App) parseInviteToken(tokenString string) (*InviteClaims, error) {
	claims := &InviteClaims{}
	token, err := jwt.ParseWithClaims(tokenString, claims, func(token *jwt.Token) (any, error) {
		if _, ok := token.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, errors.New("unexpected signing method")
		}
		return a.jwtSecret, nil
	})
	if err != nil || !token.Valid {
		return nil, errors.New("invalid invite token")
	}
	if claims.RoomID <= 0 || claims.InviteType != "room_join" {
		return nil, errors.New("invalid invite token claims")
	}
	if claims.ExpiresAt == nil || claims.ExpiresAt.Time.Before(time.Now().UTC()) {
		return nil, errors.New("invite token expired")
	}
	return claims, nil
}
