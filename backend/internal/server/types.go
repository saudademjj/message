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
	defaultDeviceName      = "Browser Device"
	defaultTrustProxy      = false
	defaultLoginIPPerMin   = 30
	defaultLoginIPBurst    = 10
	defaultLoginUserPerMin = 12
	defaultLoginUserBurst  = 6
	defaultWSConnPerMin    = 60
	defaultWSConnBurst     = 20
	defaultCipherPerMin    = 120
	defaultCipherBurst     = 30
	defaultShutdownSecs    = 20
	defaultAccessTokenMins = 15
	defaultRefreshTokenHrs = 24 * 14
	authCookieName         = "e2ee-chat.auth"
	refreshCookieName      = "e2ee-chat.refresh"
	csrfCookieName         = "e2ee-chat.csrf"
	deviceCookieName       = "e2ee-chat.device"
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
	ciphertextLimiter *keyedRateLimiter
	trustProxyHeaders bool
	accessTokenTTL    time.Duration
	refreshTokenTTL   time.Duration
	upgrader          websocket.Upgrader
}

type Claims struct {
	UserID               int64  `json:"uid"`
	Username             string `json:"uname"`
	Role                 string `json:"role"`
	DeviceID             string `json:"did"`
	DeviceSessionVersion int    `json:"dsv"`
	jwt.RegisteredClaims
}

type AuthContext struct {
	UserID               int64
	Username             string
	Role                 string
	DeviceID             string
	DeviceName           string
	DeviceSessionVersion int
	DeviceLastSeenAt     time.Time
	TokenExpiresAt       time.Time
}

type Hub struct {
	mu           sync.RWMutex
	rooms        map[int64]map[*Client]struct{}
	summaryUsers map[int64]map[*SummaryClient]struct{}
}

type Broadcaster interface {
	AddClient(client *Client) []PeerSnapshot
	RemoveClient(client *Client)
	Broadcast(roomID int64, payload []byte)
	BroadcastToRoomClients(roomID int64, build func(*Client) ([]byte, bool))
	Unicast(roomID int64, userID int64, payload []byte)
	UnicastToDevice(roomID int64, userID int64, deviceID string, payload []byte)
	BroadcastToRooms(roomIDs []int64, payload []byte)
	AddSummaryClient(client *SummaryClient)
	RemoveSummaryClient(client *SummaryClient)
	UnicastSummary(userID int64, payload []byte)
	UnicastSummaryToDevice(userID int64, deviceID string, payload []byte)
	KickUserDevice(userID int64, deviceID string, code int, reason string)
	Shutdown()
}

type Client struct {
	app        *App
	conn       *websocket.Conn
	send       chan []byte
	userID     int64
	username   string
	deviceID   string
	deviceName string
	roomID     int64
	sessionVer int
	tokenExp   time.Time

	mu               sync.RWMutex
	publicKey        json.RawMessage
	signingPublicKey json.RawMessage
}

type SummaryClient struct {
	app        *App
	conn       *websocket.Conn
	send       chan []byte
	userID     int64
	username   string
	deviceID   string
	deviceName string
	sessionVer int
	tokenExp   time.Time
}

type PeerSnapshot struct {
	UserID              int64           `json:"userId"`
	Username            string          `json:"username"`
	DeviceID            string          `json:"deviceId"`
	DeviceName          string          `json:"deviceName,omitempty"`
	PublicKeyJWK        json.RawMessage `json:"publicKeyJwk"`
	SigningPublicKeyJWK json.RawMessage `json:"signingPublicKeyJwk,omitempty"`
}

type WrappedKey struct {
	IV                  string          `json:"iv"`
	WrappedKey          string          `json:"wrappedKey"`
	RecipientAAD        string          `json:"recipientAad,omitempty"`
	RatchetDHPublicJWK  json.RawMessage `json:"ratchetDhPublicKeyJwk,omitempty"`
	MessageNumber       int             `json:"messageNumber"`
	PreviousChainLength int             `json:"previousChainLength"`
	SessionVersion      int             `json:"sessionVersion"`
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
	FromDeviceID          string                `json:"fromDeviceId,omitempty"`
	ToUserID              int64                 `json:"toUserId,omitempty"`
	ToDeviceID            string                `json:"toDeviceId,omitempty"`
	MessageIDs            []int64               `json:"messageIds,omitempty"`
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

type DeviceEnvelopeRefillEntry struct {
	MessageID  int64      `json:"messageId"`
	WrappedKey WrappedKey `json:"wrappedKey"`
}

type ProtocolErrorFrame struct {
	Type    string `json:"type"`
	RoomID  int64  `json:"roomId"`
	Code    string `json:"code"`
	Message string `json:"message"`
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

type SignalDevicePreKeyBundle struct {
	DeviceID              string               `json:"deviceId"`
	IdentityKeyJWK        json.RawMessage      `json:"identityKeyJwk"`
	IdentitySigningPubJWK json.RawMessage      `json:"identitySigningPublicKeyJwk"`
	SignedPreKey          SignalSignedPreKey   `json:"signedPreKey"`
	OneTimePreKey         *SignalOneTimePreKey `json:"oneTimePreKey,omitempty"`
	UpdatedAt             string               `json:"updatedAt"`
	OneTimePreKeyConsumed bool                 `json:"oneTimePreKeyConsumed"`
	OneTimePreKeyLow      bool                 `json:"oneTimePreKeyLow"`
	OneTimePreKeysLeft    int64                `json:"oneTimePreKeysLeft"`
}

type SignalPreKeyBundleResponse struct {
	UserID             int64                      `json:"userId"`
	Username           string                     `json:"username"`
	Devices            []SignalDevicePreKeyBundle `json:"devices"`
	ActiveDeviceCount  int64                      `json:"activeDeviceCount"`
	ReadyDeviceCount   int64                      `json:"readyDeviceCount"`
	MissingDeviceCount int64                      `json:"missingDeviceCount"`
	UpdatedAt          string                     `json:"updatedAt"`
}

type DeviceSnapshot struct {
	DeviceID       string  `json:"deviceId"`
	DeviceName     string  `json:"deviceName"`
	SessionVersion int     `json:"sessionVersion"`
	CreatedAt      string  `json:"createdAt"`
	LastSeenAt     string  `json:"lastSeenAt"`
	TrustStatus    string  `json:"trustStatus"`
	PendingSince   *string `json:"pendingSince,omitempty"`
	ApprovedAt     *string `json:"approvedAt,omitempty"`
	RevokedAt      *string `json:"revokedAt,omitempty"`
	Current        bool    `json:"current"`
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

type DeviceSecretBlob struct {
	BlobVersion   int             `json:"blobVersion"`
	KDFSalt       string          `json:"kdfSalt"`
	RecoveryHint  string          `json:"recoveryHint"`
	EncryptedBlob json.RawMessage `json:"encryptedBlob"`
	UpdatedAt     string          `json:"updatedAt,omitempty"`
}

type RoomSummary struct {
	ID             int64  `json:"id"`
	Name           string `json:"name"`
	CreatedAt      string `json:"createdAt"`
	LastMessageID  *int64 `json:"lastMessageId"`
	LastActivityAt string `json:"lastActivityAt"`
	UnreadCount    int64  `json:"unreadCount"`
}

var (
	errInvalidIdentity = errors.New("invalid identity")
)
