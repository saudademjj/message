package server

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/sha256"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"sort"
	"strings"
)

func verifyCipherSignature(payload CipherPayload) error {
	canonical, err := canonicalSignaturePayload(payload)
	if err != nil {
		return err
	}
	if err := verifyPayloadSignature(payload.SenderSigningPubJWK, canonical, payload.Signature); err != nil {
		return err
	}
	return nil
}

func verifyAckSignature(signingPublicJWK json.RawMessage, roomID, messageID, fromUserID int64, signatureB64 string) error {
	if len(signingPublicJWK) == 0 || !json.Valid(signingPublicJWK) {
		return errors.New("missing signing public key")
	}
	canonical, err := canonicalAckPayload(roomID, messageID, fromUserID)
	if err != nil {
		return err
	}
	if err := verifyPayloadSignature(signingPublicJWK, canonical, signatureB64); err != nil {
		return err
	}
	return nil
}

func canonicalSignaturePayload(payload CipherPayload) ([]byte, error) {
	if payload.Ciphertext == "" || payload.MessageIV == "" || len(payload.WrappedKeys) == 0 {
		return nil, errors.New("incomplete ciphertext payload")
	}
	if len(payload.SenderPublicJWK) == 0 || !json.Valid(payload.SenderPublicJWK) {
		return nil, errors.New("missing sender public key")
	}
	if len(payload.SenderSigningPubJWK) == 0 || !json.Valid(payload.SenderSigningPubJWK) {
		return nil, errors.New("missing sender signing key")
	}

	senderJWK, err := parseJWKMap(payload.SenderPublicJWK)
	if err != nil {
		return nil, fmt.Errorf("invalid sender public key: %w", err)
	}
	signingJWK, err := parseJWKMap(payload.SenderSigningPubJWK)
	if err != nil {
		return nil, fmt.Errorf("invalid sender signing key: %w", err)
	}

	keys := make([]string, 0, len(payload.WrappedKeys))
	for recipientID := range payload.WrappedKeys {
		keys = append(keys, recipientID)
	}
	sort.Strings(keys)

	wrapped := make([]map[string]any, 0, len(keys))
	for _, recipientID := range keys {
		entry := payload.WrappedKeys[recipientID]
		item := map[string]any{
			"recipientId":           recipientID,
			"iv":                    entry.IV,
			"wrappedKey":            entry.WrappedKey,
			"ratchetDhPublicKeyJwk": nil,
			"preKeyMessage":         nil,
			"messageNumber":         entry.MessageNumber,
			"previousChainLength":   entry.PreviousChainLength,
			"sessionVersion":        entry.SessionVersion,
		}
		if len(entry.RatchetDHPublicJWK) > 0 {
			parsed, err := parseJWKMap(entry.RatchetDHPublicJWK)
			if err != nil {
				return nil, fmt.Errorf("invalid ratchet key for recipient %s: %w", recipientID, err)
			}
			item["ratchetDhPublicKeyJwk"] = parsed
		}
		if entry.PreKeyMessage != nil {
			preKeyDoc := map[string]any{
				"identityKeyJwk":              nil,
				"identitySigningPublicKeyJwk": nil,
				"ephemeralKeyJwk":             nil,
				"signedPreKeyId":              entry.PreKeyMessage.SignedPreKeyID,
				"oneTimePreKeyId":             nil,
				"preKeyBundleUpdatedAt":       entry.PreKeyMessage.PreKeyBundleUpdatedAtISO,
			}
			if len(entry.PreKeyMessage.IdentityKeyJWK) > 0 {
				parsed, err := parseJWKMap(entry.PreKeyMessage.IdentityKeyJWK)
				if err != nil {
					return nil, fmt.Errorf("invalid prekey identity key for recipient %s: %w", recipientID, err)
				}
				preKeyDoc["identityKeyJwk"] = parsed
			}
			if len(entry.PreKeyMessage.IdentitySigningPubJWK) > 0 {
				parsed, err := parseJWKMap(entry.PreKeyMessage.IdentitySigningPubJWK)
				if err != nil {
					return nil, fmt.Errorf("invalid prekey identity signing key for recipient %s: %w", recipientID, err)
				}
				preKeyDoc["identitySigningPublicKeyJwk"] = parsed
			}
			if len(entry.PreKeyMessage.EphemeralKeyJWK) > 0 {
				parsed, err := parseJWKMap(entry.PreKeyMessage.EphemeralKeyJWK)
				if err != nil {
					return nil, fmt.Errorf("invalid prekey ephemeral key for recipient %s: %w", recipientID, err)
				}
				preKeyDoc["ephemeralKeyJwk"] = parsed
			}
			if entry.PreKeyMessage.OneTimePreKeyID != nil {
				preKeyDoc["oneTimePreKeyId"] = *entry.PreKeyMessage.OneTimePreKeyID
			}
			item["preKeyMessage"] = preKeyDoc
		}
		wrapped = append(wrapped, item)
	}

	doc := map[string]any{
		"version":                   payload.Version,
		"ciphertext":                payload.Ciphertext,
		"messageIv":                 payload.MessageIV,
		"wrappedKeys":               wrapped,
		"senderPublicKeyJwk":        senderJWK,
		"senderSigningPublicKeyJwk": signingJWK,
		"contentType":               payload.ContentType,
		"senderDeviceId":            payload.SenderDeviceID,
		"encryptionScheme":          payload.EncryptionScheme,
	}
	return json.Marshal(doc)
}

func canonicalAckPayload(roomID, messageID, fromUserID int64) ([]byte, error) {
	if roomID <= 0 || messageID <= 0 || fromUserID <= 0 {
		return nil, errors.New("invalid ack payload")
	}
	doc := map[string]any{
		"type":       "decrypt_ack",
		"roomId":     roomID,
		"messageId":  messageID,
		"fromUserId": fromUserID,
	}
	return json.Marshal(doc)
}

func parseJWKMap(raw json.RawMessage) (map[string]any, error) {
	var parsed map[string]any
	if err := json.Unmarshal(raw, &parsed); err != nil {
		return nil, err
	}
	if len(parsed) == 0 {
		return nil, errors.New("empty jwk")
	}
	return parsed, nil
}

func verifyPayloadSignature(signingPublicJWK json.RawMessage, canonical []byte, signatureB64 string) error {
	signature, err := decodeSignature(signatureB64)
	if err != nil {
		return fmt.Errorf("invalid signature encoding: %w", err)
	}

	if ecdsaPublicKey, err := ecdsaPublicKeyFromJWK(signingPublicJWK); err == nil {
		if err := verifyECDSAP256Signature(ecdsaPublicKey, canonical, signature); err != nil {
			return err
		}
		return nil
	}

	ed25519PublicKey, err := ed25519PublicKeyFromJWK(signingPublicJWK)
	if err != nil {
		return fmt.Errorf("invalid signing public key: expected EC P-256 JWK or Ed25519 OKP JWK")
	}
	if len(signature) != ed25519.SignatureSize {
		return errors.New("invalid Ed25519 signature length")
	}
	if !ed25519.Verify(ed25519PublicKey, canonical, signature) {
		return errors.New("signature verification failed")
	}
	return nil
}

func verifyECDSAP256Signature(publicKey *ecdsa.PublicKey, canonical []byte, signature []byte) error {
	r, s, err := parseECDSAP256Signature(signature)
	if err != nil {
		return err
	}
	hash := sha256.Sum256(canonical)
	if !ecdsa.Verify(publicKey, hash[:], r, s) {
		return errors.New("signature verification failed")
	}
	return nil
}

func parseECDSAP256Signature(signature []byte) (*big.Int, *big.Int, error) {
	if len(signature) == 64 {
		r := new(big.Int).SetBytes(signature[:32])
		s := new(big.Int).SetBytes(signature[32:])
		return r, s, nil
	}

	var der struct {
		R *big.Int
		S *big.Int
	}
	rest, err := asn1.Unmarshal(signature, &der)
	if err != nil || len(rest) != 0 || der.R == nil || der.S == nil {
		return nil, nil, errors.New("invalid ECDSA P-256 signature format")
	}
	return der.R, der.S, nil
}

func ecdsaPublicKeyFromJWK(raw json.RawMessage) (*ecdsa.PublicKey, error) {
	var jwk struct {
		Kty string `json:"kty"`
		Crv string `json:"crv"`
		X   string `json:"x"`
		Y   string `json:"y"`
	}
	if err := json.Unmarshal(raw, &jwk); err != nil {
		return nil, err
	}
	if jwk.Kty != "EC" || jwk.Crv != "P-256" || strings.TrimSpace(jwk.X) == "" || strings.TrimSpace(jwk.Y) == "" {
		return nil, errors.New("expected EC P-256 JWK with x and y coordinates")
	}
	xBytes, err := base64.RawURLEncoding.DecodeString(jwk.X)
	if err != nil {
		xBytes, err = base64.URLEncoding.DecodeString(jwk.X)
		if err != nil {
			return nil, fmt.Errorf("invalid x coordinate: %w", err)
		}
	}
	yBytes, err := base64.RawURLEncoding.DecodeString(jwk.Y)
	if err != nil {
		yBytes, err = base64.URLEncoding.DecodeString(jwk.Y)
		if err != nil {
			return nil, fmt.Errorf("invalid y coordinate: %w", err)
		}
	}
	curve := elliptic.P256()
	x := new(big.Int).SetBytes(xBytes)
	y := new(big.Int).SetBytes(yBytes)
	if !curve.IsOnCurve(x, y) {
		return nil, errors.New("point is not on P-256 curve")
	}
	return &ecdsa.PublicKey{Curve: curve, X: x, Y: y}, nil
}

func ed25519PublicKeyFromJWK(raw json.RawMessage) (ed25519.PublicKey, error) {
	var jwk struct {
		Kty string `json:"kty"`
		Crv string `json:"crv"`
		X   string `json:"x"`
	}
	if err := json.Unmarshal(raw, &jwk); err != nil {
		return nil, err
	}
	if jwk.Kty != "OKP" || jwk.Crv != "Ed25519" || strings.TrimSpace(jwk.X) == "" {
		return nil, errors.New("expected Ed25519 OKP JWK")
	}
	keyBytes, err := base64.RawURLEncoding.DecodeString(jwk.X)
	if err != nil {
		keyBytes, err = base64.URLEncoding.DecodeString(jwk.X)
		if err != nil {
			return nil, err
		}
	}
	if len(keyBytes) != ed25519.PublicKeySize {
		return nil, errors.New("unexpected key size")
	}
	return ed25519.PublicKey(keyBytes), nil
}

func decodeSignature(signature string) ([]byte, error) {
	trimmed := strings.TrimSpace(signature)
	if trimmed == "" {
		return nil, errors.New("missing signature")
	}
	decoded, err := base64.StdEncoding.DecodeString(trimmed)
	if err == nil {
		return decoded, nil
	}
	return base64.RawStdEncoding.DecodeString(trimmed)
}

func jsonEqualCanonical(a, b json.RawMessage) bool {
	var left any
	var right any
	if err := json.Unmarshal(a, &left); err != nil {
		return false
	}
	if err := json.Unmarshal(b, &right); err != nil {
		return false
	}
	leftJSON, err := json.Marshal(left)
	if err != nil {
		return false
	}
	rightJSON, err := json.Marshal(right)
	if err != nil {
		return false
	}
	return bytes.Equal(leftJSON, rightJSON)
}
