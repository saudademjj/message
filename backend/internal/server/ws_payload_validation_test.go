package server

import (
	"errors"
	"testing"
)

func TestValidateV3CipherPayload(t *testing.T) {
	valid := CipherPayload{
		Version:          3,
		EncryptionScheme: "DOUBLE_RATCHET_V1",
		WrappedKeys: map[string]WrappedKey{
			"12:device_1234": {
				IV:         "iv",
				WrappedKey: "wrapped",
			},
		},
	}

	if err := validateV3CipherPayload(valid); err != nil {
		t.Fatalf("expected valid payload, got error: %v", err)
	}

	legacy := valid
	legacy.Version = 2
	err := validateV3CipherPayload(legacy)
	if !errors.Is(err, errLegacyPayloadVersion) {
		t.Fatalf("expected errLegacyPayloadVersion, got: %v", err)
	}

	invalidScheme := valid
	invalidScheme.EncryptionScheme = "LEGACY"
	err = validateV3CipherPayload(invalidScheme)
	if !errors.Is(err, errInvalidPayloadFormat) {
		t.Fatalf("expected errInvalidPayloadFormat for invalid scheme, got: %v", err)
	}

	invalidWrappedKey := valid
	invalidWrappedKey.WrappedKeys = map[string]WrappedKey{
		"12": {
			IV:         "iv",
			WrappedKey: "wrapped",
		},
	}
	err = validateV3CipherPayload(invalidWrappedKey)
	if !errors.Is(err, errInvalidPayloadFormat) {
		t.Fatalf("expected errInvalidPayloadFormat for wrapped key format, got: %v", err)
	}
}
