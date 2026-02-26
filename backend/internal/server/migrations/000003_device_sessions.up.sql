CREATE TABLE IF NOT EXISTS user_devices (
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL,
    device_name TEXT NOT NULL DEFAULT 'Unnamed device',
    session_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ NULL,
    PRIMARY KEY (user_id, device_id)
);

CREATE INDEX IF NOT EXISTS idx_user_devices_user_id_last_seen
    ON user_devices(user_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_devices_active
    ON user_devices(user_id, revoked_at)
    WHERE revoked_at IS NULL;

ALTER TABLE auth_refresh_tokens
    ADD COLUMN IF NOT EXISTS device_id TEXT;

ALTER TABLE auth_refresh_tokens
    ADD COLUMN IF NOT EXISTS device_session_version INTEGER NOT NULL DEFAULT 1;

UPDATE auth_refresh_tokens
SET device_id = CONCAT('legacy-', id)
WHERE COALESCE(TRIM(device_id), '') = '';

ALTER TABLE auth_refresh_tokens
    ALTER COLUMN device_id SET NOT NULL;

-- Force full login/session rebuild before adding device FK constraints.
TRUNCATE TABLE auth_refresh_tokens;

ALTER TABLE auth_refresh_tokens
    DROP CONSTRAINT IF EXISTS auth_refresh_tokens_user_device_fk;

ALTER TABLE auth_refresh_tokens
    ADD CONSTRAINT auth_refresh_tokens_user_device_fk
    FOREIGN KEY (user_id, device_id)
    REFERENCES user_devices(user_id, device_id)
    ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_user_device
    ON auth_refresh_tokens(user_id, device_id);

CREATE TABLE IF NOT EXISTS signal_device_identity_keys (
    user_id BIGINT NOT NULL,
    device_id TEXT NOT NULL,
    identity_key_jwk JSONB NOT NULL,
    identity_signing_public_key_jwk JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, device_id),
    FOREIGN KEY (user_id, device_id)
        REFERENCES user_devices(user_id, device_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS signal_device_identity_key_history (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    device_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    identity_key_jwk JSONB NOT NULL,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, device_id, fingerprint),
    FOREIGN KEY (user_id, device_id)
        REFERENCES user_devices(user_id, device_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS signal_device_signed_prekeys (
    user_id BIGINT NOT NULL,
    device_id TEXT NOT NULL,
    key_id BIGINT NOT NULL,
    public_key_jwk JSONB NOT NULL,
    signature TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, device_id),
    FOREIGN KEY (user_id, device_id)
        REFERENCES user_devices(user_id, device_id)
        ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS signal_device_one_time_prekeys (
    user_id BIGINT NOT NULL,
    device_id TEXT NOT NULL,
    key_id BIGINT NOT NULL,
    public_key_jwk JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consumed_at TIMESTAMPTZ NULL,
    PRIMARY KEY (user_id, device_id, key_id),
    FOREIGN KEY (user_id, device_id)
        REFERENCES user_devices(user_id, device_id)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_signal_device_one_time_prekeys_available
    ON signal_device_one_time_prekeys(user_id, device_id, consumed_at, key_id);

DELETE FROM signal_identity_key_history;
DELETE FROM signal_identity_keys;
DELETE FROM signal_signed_prekeys;
DELETE FROM signal_one_time_prekeys;
