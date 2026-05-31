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

func TestAllowResyncRouting(t *testing.T) {
	t.Parallel()

	cases := []struct {
		name            string
		requesterUserID int64
		requesterDevice string
		targetUserID    int64
		targetDevice    string
		want            bool
	}{
		{
			name:            "different users with target device allowed",
			requesterUserID: 1,
			requesterDevice: "device-A",
			targetUserID:    2,
			targetDevice:    "device-B",
			want:            true,
		},
		{
			name:            "different users without target device allowed",
			requesterUserID: 1,
			requesterDevice: "device-A",
			targetUserID:    2,
			targetDevice:    "",
			want:            true,
		},
		{
			name:            "same user different device allowed",
			requesterUserID: 1,
			requesterDevice: "device-A",
			targetUserID:    1,
			targetDevice:    "device-B",
			want:            true,
		},
		{
			name:            "same user same device rejected",
			requesterUserID: 1,
			requesterDevice: "device-A",
			targetUserID:    1,
			targetDevice:    "device-A",
			want:            false,
		},
		{
			name:            "same user without target device rejected",
			requesterUserID: 1,
			requesterDevice: "device-A",
			targetUserID:    1,
			targetDevice:    "",
			want:            false,
		},
		{
			name:            "invalid requester user id rejected",
			requesterUserID: 0,
			requesterDevice: "device-A",
			targetUserID:    2,
			targetDevice:    "device-B",
			want:            false,
		},
		{
			name:            "invalid target user id rejected",
			requesterUserID: 1,
			requesterDevice: "device-A",
			targetUserID:    0,
			targetDevice:    "device-B",
			want:            false,
		},
		{
			name:            "empty requester device rejected for self-user routing",
			requesterUserID: 1,
			requesterDevice: "",
			targetUserID:    1,
			targetDevice:    "device-B",
			want:            false,
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			t.Parallel()
			got := allowResyncRouting(tc.requesterUserID, tc.requesterDevice, tc.targetUserID, tc.targetDevice)
			if got != tc.want {
				t.Fatalf("allowResyncRouting(%d,%q,%d,%q) = %v, want %v",
					tc.requesterUserID, tc.requesterDevice, tc.targetUserID, tc.targetDevice, got, tc.want)
			}
		})
	}
}
