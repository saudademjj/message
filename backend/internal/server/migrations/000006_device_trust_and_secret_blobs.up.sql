ALTER TABLE public.user_devices
    ADD COLUMN IF NOT EXISTS trust_status TEXT NOT NULL DEFAULT 'approved';

ALTER TABLE public.user_devices
    ADD COLUMN IF NOT EXISTS pending_since TIMESTAMPTZ NULL;

ALTER TABLE public.user_devices
    ADD COLUMN IF NOT EXISTS approved_at TIMESTAMPTZ NULL;

ALTER TABLE public.user_devices
    ADD COLUMN IF NOT EXISTS approved_by_user_id BIGINT NULL REFERENCES public.users(id) ON DELETE SET NULL;

UPDATE public.user_devices
SET trust_status = 'approved',
    approved_at = COALESCE(approved_at, created_at, NOW())
WHERE trust_status NOT IN ('approved', 'pending')
   OR COALESCE(TRIM(trust_status), '') = '';

UPDATE public.user_devices
SET pending_since = COALESCE(pending_since, created_at, NOW())
WHERE trust_status = 'pending'
  AND pending_since IS NULL;

UPDATE public.user_devices
SET approved_at = COALESCE(approved_at, created_at, NOW())
WHERE trust_status = 'approved'
  AND approved_at IS NULL;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'user_devices_trust_status_check'
    ) THEN
        ALTER TABLE public.user_devices
            ADD CONSTRAINT user_devices_trust_status_check
            CHECK (trust_status IN ('approved', 'pending'));
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_user_devices_pending
    ON public.user_devices(user_id, trust_status, pending_since)
    WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS chat_mailbox.device_secret_blobs (
    user_id BIGINT NOT NULL,
    device_id TEXT NOT NULL,
    blob_version INTEGER NOT NULL DEFAULT 1,
    kdf_salt TEXT NOT NULL,
    recovery_hint TEXT NOT NULL DEFAULT '',
    encrypted_blob JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, device_id),
    FOREIGN KEY (user_id, device_id)
        REFERENCES public.user_devices(user_id, device_id)
        ON DELETE CASCADE
);
