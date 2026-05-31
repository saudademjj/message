package server

import (
	"testing"
)

func TestSenderEchoPayload(t *testing.T) {
	t.Parallel()

	senderUserID := int64(7)
	senderDeviceID := "sender-device-1"
	senderAddress := "7:sender-device-1"
	otherAddressA := "9:other-device-a"
	otherAddressB := "9:other-device-b"

	payload := CipherPayload{
		Version: 4,
		WrappedKeys: map[string]WrappedKey{
			senderAddress: {IV: "sender-iv", WrappedKey: "sender-key", MessageNumber: 3},
			otherAddressA: {IV: "other-iv-a", WrappedKey: "other-key-a"},
			otherAddressB: {IV: "other-iv-b", WrappedKey: "other-key-b"},
		},
	}

	echoed := senderEchoPayload(payload, senderUserID, senderDeviceID)

	if len(echoed.WrappedKeys) != 3 {
		t.Fatalf("expected 3 wrapped key entries, got %d", len(echoed.WrappedKeys))
	}

	senderEntry, ok := echoed.WrappedKeys[senderAddress]
	if !ok {
		t.Fatalf("sender address %q missing from echo payload", senderAddress)
	}
	if senderEntry.WrappedKey != "sender-key" || senderEntry.IV != "sender-iv" || senderEntry.MessageNumber != 3 {
		t.Fatalf("sender wrapped key should be preserved, got %#v", senderEntry)
	}

	for _, address := range []string{otherAddressA, otherAddressB} {
		entry, ok := echoed.WrappedKeys[address]
		if !ok {
			t.Fatalf("expected address %q present in echo payload", address)
		}
		if entry.IV != "" || entry.WrappedKey != "" || entry.MessageNumber != 0 || entry.RatchetDHPublicJWK != nil || entry.PreKeyMessage != nil {
			t.Fatalf("expected empty wrapped key placeholder for %q, got %#v", address, entry)
		}
	}
}

// TestSenderEchoPayloadSiblingDeviceKeepsItsKey verifies the multi-device fix:
// when the echo is built for a sibling device of the same account (a legitimate
// recipient), that sibling device's own wrapped key must be preserved so it can
// decrypt the live message, while the originating device's key is reduced to a
// placeholder.
func TestSenderEchoPayloadSiblingDeviceKeepsItsKey(t *testing.T) {
	t.Parallel()

	senderUserID := int64(7)
	originatingAddress := "7:origin-device"
	siblingAddress := "7:sibling-device"
	peerAddress := "9:peer-device"

	payload := CipherPayload{
		Version: 4,
		WrappedKeys: map[string]WrappedKey{
			originatingAddress: {IV: "origin-iv", WrappedKey: "origin-key"},
			siblingAddress:     {IV: "sibling-iv", WrappedKey: "sibling-key"},
			peerAddress:        {IV: "peer-iv", WrappedKey: "peer-key"},
		},
	}

	// Build the copy destined for the sibling device.
	echoed := senderEchoPayload(payload, senderUserID, "sibling-device")

	siblingEntry, ok := echoed.WrappedKeys[siblingAddress]
	if !ok || siblingEntry.WrappedKey != "sibling-key" || siblingEntry.IV != "sibling-iv" {
		t.Fatalf("sibling device must keep its real wrapped key, got %#v", siblingEntry)
	}
	if entry := echoed.WrappedKeys[originatingAddress]; entry.WrappedKey != "" || entry.IV != "" {
		t.Fatalf("originating device key should be a placeholder for the sibling copy, got %#v", entry)
	}
	if entry := echoed.WrappedKeys[peerAddress]; entry.WrappedKey != "" || entry.IV != "" {
		t.Fatalf("peer key should be a placeholder, got %#v", entry)
	}
}

func TestSenderEchoPayloadDoesNotMutateInput(t *testing.T) {
	t.Parallel()

	senderAddress := "1:device-1"
	otherAddress := "2:device-2"
	original := CipherPayload{
		Version: 4,
		WrappedKeys: map[string]WrappedKey{
			senderAddress: {WrappedKey: "real"},
			otherAddress:  {WrappedKey: "secret"},
		},
	}

	_ = senderEchoPayload(original, 1, "device-1")

	if original.WrappedKeys[otherAddress].WrappedKey != "secret" {
		t.Fatalf("senderEchoPayload should not mutate the input map, got %#v", original.WrappedKeys[otherAddress])
	}
}
