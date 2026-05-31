CREATE SCHEMA IF NOT EXISTS chat_mailbox;

CREATE TABLE IF NOT EXISTS chat_mailbox.device_envelopes (
    message_id BIGINT NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
    room_id BIGINT NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    recipient_user_id BIGINT NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    recipient_device_id TEXT NOT NULL,
    wrapped_key JSONB NOT NULL,
    sender_device_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ NULL,
    read_at TIMESTAMPTZ NULL,
    PRIMARY KEY (message_id, recipient_device_id),
    FOREIGN KEY (recipient_user_id, recipient_device_id)
        REFERENCES public.user_devices(user_id, device_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_device_envelopes_recipient_created
    ON chat_mailbox.device_envelopes(recipient_user_id, recipient_device_id, created_at DESC, message_id DESC);

CREATE INDEX IF NOT EXISTS idx_device_envelopes_room_recipient_message
    ON chat_mailbox.device_envelopes(room_id, recipient_user_id, recipient_device_id, message_id);

CREATE INDEX IF NOT EXISTS idx_device_envelopes_pending_delivery
    ON chat_mailbox.device_envelopes(recipient_user_id, recipient_device_id, delivered_at, message_id)
    WHERE delivered_at IS NULL;

CREATE TABLE IF NOT EXISTS chat_mailbox.device_inbox_cursors (
    user_id BIGINT NOT NULL,
    device_id TEXT NOT NULL,
    room_id BIGINT NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    last_envelope_message_id BIGINT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, device_id, room_id),
    FOREIGN KEY (user_id, device_id)
        REFERENCES public.user_devices(user_id, device_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS chat_mailbox.message_attachments (
    id BIGSERIAL PRIMARY KEY,
    message_id BIGINT NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
    room_id BIGINT NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
    object_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_message_attachments_message
    ON chat_mailbox.message_attachments(message_id);
