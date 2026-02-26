package server

import (
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"math/big"
	"testing"
)

func mustJSONRaw(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatalf("marshal json: %v", err)
	}
	return encoded
}

func makeECDSAP256JWK(t *testing.T) (*ecdsa.PrivateKey, json.RawMessage) {
	t.Helper()
	privateKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate ecdsa key: %v", err)
	}
	jwk := mustJSONRaw(t, map[string]any{
		"kty": "EC",
		"crv": "P-256",
		"x":   base64.RawURLEncoding.EncodeToString(privateKey.X.Bytes()),
		"y":   base64.RawURLEncoding.EncodeToString(privateKey.Y.Bytes()),
	})
	return privateKey, jwk
}

func makeEd25519JWK(t *testing.T) (ed25519.PrivateKey, json.RawMessage) {
	t.Helper()
	publicKey, privateKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatalf("generate ed25519 key: %v", err)
	}
	jwk := mustJSONRaw(t, map[string]any{
		"kty": "OKP",
		"crv": "Ed25519",
		"x":   base64.RawURLEncoding.EncodeToString(publicKey),
	})
	return privateKey, jwk
}

func signWithECDSA(t *testing.T, privateKey *ecdsa.PrivateKey, canonical []byte) string {
	t.Helper()
	hash := sha256.Sum256(canonical)
	r, s, err := ecdsa.Sign(rand.Reader, privateKey, hash[:])
	if err != nil {
		t.Fatalf("sign ecdsa: %v", err)
	}

	// Pad r and s to 32 bytes each
	rBytes := r.Bytes()
	sBytes := s.Bytes()

	rPadded := make([]byte, 32)
	copy(rPadded[32-len(rBytes):], rBytes)

	sPadded := make([]byte, 32)
	copy(sPadded[32-len(sBytes):], sBytes)

	sigBytes := append(rPadded, sPadded...)
	return base64.StdEncoding.EncodeToString(sigBytes)
}

func signWithECDSADER(t *testing.T, privateKey *ecdsa.PrivateKey, canonical []byte) string {
	t.Helper()
	hash := sha256.Sum256(canonical)
	sig, err := ecdsa.SignASN1(rand.Reader, privateKey, hash[:])
	if err != nil {
		t.Fatalf("sign ecdsa asn1: %v", err)
	}
	// sanity check we are exercising DER path
	var parsed struct {
		R *big.Int
		S *big.Int
	}
	if _, err := asn1.Unmarshal(sig, &parsed); err != nil {
		t.Fatalf("invalid der signature in test: %v", err)
	}
	return base64.StdEncoding.EncodeToString(sig)
}

func signWithEd25519(privateKey ed25519.PrivateKey, canonical []byte) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(privateKey, canonical))
}

func TestVerifyAckSignature(t *testing.T) {
	privateKey, signingJWK := makeECDSAP256JWK(t)

	canonical, err := canonicalAckPayload(11, 22, 33)
	if err != nil {
		t.Fatalf("canonical ack payload: %v", err)
	}
	signature := signWithECDSA(t, privateKey, canonical)

	if err := verifyAckSignature(signingJWK, 11, 22, 33, signature); err != nil {
		t.Fatalf("verify ack signature failed: %v", err)
	}

	if err := verifyAckSignature(signingJWK, 11, 22, 34, signature); err == nil {
		t.Fatalf("expected verifyAckSignature to fail for mismatched payload")
	}
}

func TestVerifyAckSignatureECDSADER(t *testing.T) {
	privateKey, signingJWK := makeECDSAP256JWK(t)
	canonical, err := canonicalAckPayload(21, 22, 23)
	if err != nil {
		t.Fatalf("canonical ack payload: %v", err)
	}
	signature := signWithECDSADER(t, privateKey, canonical)
	if err := verifyAckSignature(signingJWK, 21, 22, 23, signature); err != nil {
		t.Fatalf("verify ack signature (der) failed: %v", err)
	}
}

func TestVerifyAckSignatureEd25519(t *testing.T) {
	privateKey, signingJWK := makeEd25519JWK(t)
	canonical, err := canonicalAckPayload(31, 32, 33)
	if err != nil {
		t.Fatalf("canonical ack payload: %v", err)
	}
	signature := signWithEd25519(privateKey, canonical)
	if err := verifyAckSignature(signingJWK, 31, 32, 33, signature); err != nil {
		t.Fatalf("verify ack signature (ed25519) failed: %v", err)
	}
}

func TestVerifyCipherSignature(t *testing.T) {
	privateKey, signingJWK := makeECDSAP256JWK(t)
	payload := CipherPayload{
		Version:    2,
		Ciphertext: "ciphertext-value",
		MessageIV:  "iv-value",
		WrappedKeys: map[string]WrappedKey{
			"7": {
				IV:                  "wrap-iv",
				WrappedKey:          "wrap-key",
				MessageNumber:       1,
				PreviousChainLength: 0,
				SessionVersion:      1,
			},
		},
		SenderPublicJWK: mustJSONRaw(t, map[string]any{
			"kty": "EC",
			"crv": "P-256",
			"x":   "sender-x",
			"y":   "sender-y",
		}),
		SenderSigningPubJWK: signingJWK,
		ContentType:         "text/plain",
		SenderDeviceID:      "device-1",
		EncryptionScheme:    "DOUBLE_RATCHET_V1",
	}

	canonical, err := canonicalSignaturePayload(payload)
	if err != nil {
		t.Fatalf("canonical signature payload: %v", err)
	}
	payload.Signature = signWithECDSA(t, privateKey, canonical)

	if err := verifyCipherSignature(payload); err != nil {
		t.Fatalf("verify cipher signature failed: %v", err)
	}

	tampered := payload
	tampered.Ciphertext = "tampered"
	if err := verifyCipherSignature(tampered); err == nil {
		t.Fatalf("expected verifyCipherSignature to fail for tampered payload")
	}
}

func TestVerifyCipherSignatureEd25519(t *testing.T) {
	privateKey, signingJWK := makeEd25519JWK(t)
	payload := CipherPayload{
		Version:    2,
		Ciphertext: "ciphertext-value",
		MessageIV:  "iv-value",
		WrappedKeys: map[string]WrappedKey{
			"7": {
				IV:                  "wrap-iv",
				WrappedKey:          "wrap-key",
				MessageNumber:       1,
				PreviousChainLength: 0,
				SessionVersion:      1,
			},
		},
		SenderPublicJWK: mustJSONRaw(t, map[string]any{
			"kty": "EC",
			"crv": "P-256",
			"x":   "sender-x",
			"y":   "sender-y",
		}),
		SenderSigningPubJWK: signingJWK,
		ContentType:         "text/plain",
		SenderDeviceID:      "device-1",
		EncryptionScheme:    "DOUBLE_RATCHET_V1",
	}

	canonical, err := canonicalSignaturePayload(payload)
	if err != nil {
		t.Fatalf("canonical signature payload: %v", err)
	}
	payload.Signature = signWithEd25519(privateKey, canonical)
	if err := verifyCipherSignature(payload); err != nil {
		t.Fatalf("verify cipher signature (ed25519) failed: %v", err)
	}
}
