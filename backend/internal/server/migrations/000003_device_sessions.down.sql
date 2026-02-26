DROP TABLE IF EXISTS signal_device_one_time_prekeys;
DROP TABLE IF EXISTS signal_device_signed_prekeys;
DROP TABLE IF EXISTS signal_device_identity_key_history;
DROP TABLE IF EXISTS signal_device_identity_keys;

ALTER TABLE auth_refresh_tokens
    DROP CONSTRAINT IF EXISTS auth_refresh_tokens_user_device_fk;

DROP INDEX IF EXISTS idx_auth_refresh_tokens_user_device;

ALTER TABLE auth_refresh_tokens
    DROP COLUMN IF EXISTS device_session_version;

ALTER TABLE auth_refresh_tokens
    DROP COLUMN IF EXISTS device_id;

DROP TABLE IF EXISTS user_devices;

