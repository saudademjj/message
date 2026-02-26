package server

import (
	"database/sql"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/gorilla/websocket"
)

const (
	defaultAddr            = ":8081"
	defaultAppEnv          = "development"
	defaultAdminUsername   = "admin"
	defaultAdminRoomName   = "admin-secure"
	defaultTrustProxy      = false
	defaultLoginIPPerMin   = 30
	defaultLoginIPBurst    = 10
	defaultLoginUserPerMin = 12
	defaultLoginUserBurst  = 6
	defaultWSConnPerMin    = 60
	defaultWSConnBurst     = 20
	defaultShutdownSecs    = 20
	defaultAccessTokenMins = 15
	defaultRefreshTokenHrs = 24 * 14
	authCookieName         = "e2ee-chat.auth"
	refreshCookieName      = "e2ee-chat.refresh"
	csrfCookieName         = "e2ee-chat.csrf"
)

type App struct {
	db                *sql.DB
	hub               *Hub
	jwtSecret         []byte
	corsOrigin        string
	adminUsername     string
	loginIPLimiter    *keyedRateLimiter
	loginUserLimiter  *keyedRateLimiter
	wsConnectLimiter  *keyedRateLimiter
	trustProxyHeaders bool
	accessTokenTTL    time.Duration
	refreshTokenTTL   time.Duration
	upgrader          websocket.Upgrader
}

type Claims struct {
	UserID   int64  `json:"uid"`
	Username string `json:"uname"`
	Role     string `json:"role"`
	jwt.RegisteredClaims
}

type AuthContext struct {
	UserID   int64
	Username string
	Role     string
}

type Hub struct {
	mu    sync.RWMutex
	rooms map[int64]map[*Client]struct{}
}

type Client struct {
	app      *App
	conn     *websocket.Conn
	send     chan []byte
	userID   int64
	username string
	roomID   int64

	mu               sync.RWMutex
	publicKey        json.RawMessage
	signingPublicKey json.RawMessage
}

type PeerSnapshot struct {
	UserID              int64           `json:"userId"`
	Username            string          `json:"username"`
	PublicKeyJWK        json.RawMessage `json:"publicKeyJwk"`
	SigningPublicKeyJWK json.RawMessage `json:"signingPublicKeyJwk,omitempty"`
}

type WrappedKey struct {
	IV                  string          `json:"iv"`
	WrappedKey          string          `json:"wrappedKey"`
	RatchetDHPublicJWK  json.RawMessage `json:"ratchetDhPublicKeyJwk,omitempty"`
	MessageNumber       int             `json:"messageNumber,omitempty"`
	PreviousChainLength int             `json:"previousChainLength,omitempty"`
	SessionVersion      int             `json:"sessionVersion,omitempty"`
	PreKeyMessage       *PreKeyMessage  `json:"preKeyMessage,omitempty"`
}

type PreKeyMessage struct {
	IdentityKeyJWK           json.RawMessage `json:"identityKeyJwk"`
	IdentitySigningPubJWK    json.RawMessage `json:"identitySigningPublicKeyJwk,omitempty"`
	EphemeralKeyJWK          json.RawMessage `json:"ephemeralKeyJwk"`
	SignedPreKeyID           int64           `json:"signedPreKeyId"`
	OneTimePreKeyID          *int64          `json:"oneTimePreKeyId,omitempty"`
	PreKeyBundleUpdatedAtISO string          `json:"preKeyBundleUpdatedAt,omitempty"`
}

type CipherPayload struct {
	Version             int                   `json:"version"`
	Ciphertext          string                `json:"ciphertext"`
	MessageIV           string                `json:"messageIv"`
	WrappedKeys         map[string]WrappedKey `json:"wrappedKeys"`
	SenderPublicJWK     json.RawMessage       `json:"senderPublicKeyJwk"`
	SenderSigningPubJWK json.RawMessage       `json:"senderSigningPublicKeyJwk,omitempty"`
	Signature           string                `json:"signature,omitempty"`
	ContentType         string                `json:"contentType,omitempty"`
	SenderDeviceID      string                `json:"senderDeviceId,omitempty"`
	EncryptionScheme    string                `json:"encryptionScheme,omitempty"`
}

type WSIncoming struct {
	Type                  string                `json:"type"`
	Version               int                   `json:"version,omitempty"`
	Ciphertext            string                `json:"ciphertext,omitempty"`
	MessageIV             string                `json:"messageIv,omitempty"`
	WrappedKeys           map[string]WrappedKey `json:"wrappedKeys,omitempty"`
	SenderPublicJWK       json.RawMessage       `json:"senderPublicKeyJwk,omitempty"`
	SenderSigningPubJWK   json.RawMessage       `json:"senderSigningPublicKeyJwk,omitempty"`
	Signature             string                `json:"signature,omitempty"`
	AckSignature          string                `json:"ackSignature,omitempty"`
	MessageID             int64                 `json:"messageId,omitempty"`
	PublicKeyJWK          json.RawMessage       `json:"publicKeyJwk,omitempty"`
	SigningPublicKeyJWK   json.RawMessage       `json:"signingPublicKeyJwk,omitempty"`
	ContentType           string                `json:"contentType,omitempty"`
	SenderDeviceID        string                `json:"senderDeviceId,omitempty"`
	EncryptionScheme      string                `json:"encryptionScheme,omitempty"`
	ToUserID              int64                 `json:"toUserId,omitempty"`
	Step                  string                `json:"step,omitempty"`
	Action                string                `json:"action,omitempty"`
	Mode                  string                `json:"mode,omitempty"`
	IsTyping              bool                  `json:"isTyping,omitempty"`
	UpToMessageID         int64                 `json:"upToMessageId,omitempty"`
	SessionVersion        int                   `json:"sessionVersion,omitempty"`
	RatchetDHPublic       json.RawMessage       `json:"ratchetDhPublicKeyJwk,omitempty"`
	IdentityPublicJWK     json.RawMessage       `json:"identityPublicKeyJwk,omitempty"`
	IdentitySigningPubJWK json.RawMessage       `json:"identitySigningPublicKeyJwk,omitempty"`
}

type SignalSignedPreKey struct {
	KeyID        int64           `json:"keyId"`
	PublicKeyJWK json.RawMessage `json:"publicKeyJwk"`
	Signature    string          `json:"signature"`
	CreatedAt    string          `json:"createdAt,omitempty"`
}

type SignalOneTimePreKey struct {
	KeyID        int64           `json:"keyId"`
	PublicKeyJWK json.RawMessage `json:"publicKeyJwk"`
	CreatedAt    string          `json:"createdAt,omitempty"`
}

type SignalPreKeyBundleUpload struct {
	IdentityKeyJWK        json.RawMessage       `json:"identityKeyJwk"`
	IdentitySigningPubJWK json.RawMessage       `json:"identitySigningPublicKeyJwk"`
	SignedPreKey          SignalSignedPreKey    `json:"signedPreKey"`
	OneTimePreKeys        []SignalOneTimePreKey `json:"oneTimePreKeys"`
}

type SignalPreKeyBundleResponse struct {
	UserID                int64                `json:"userId"`
	Username              string               `json:"username"`
	IdentityKeyJWK        json.RawMessage      `json:"identityKeyJwk"`
	IdentitySigningPubJWK json.RawMessage      `json:"identitySigningPublicKeyJwk"`
	SignedPreKey          SignalSignedPreKey   `json:"signedPreKey"`
	OneTimePreKey         *SignalOneTimePreKey `json:"oneTimePreKey,omitempty"`
	UpdatedAt             string               `json:"updatedAt"`
}

type StoredMessage struct {
	ID             int64         `json:"id"`
	RoomID         int64         `json:"roomId"`
	SenderID       int64         `json:"senderId"`
	SenderUsername string        `json:"senderUsername"`
	CreatedAt      string        `json:"createdAt"`
	EditedAt       *string       `json:"editedAt,omitempty"`
	RevokedAt      *string       `json:"revokedAt,omitempty"`
	Payload        CipherPayload `json:"payload"`
}

var (
	errInvalidIdentity = errors.New("invalid identity")
)
