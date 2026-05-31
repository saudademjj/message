DROP TABLE IF EXISTS chat_mailbox.device_secret_blobs;

ALTER TABLE public.user_devices
    DROP CONSTRAINT IF EXISTS user_devices_trust_status_check;

DROP INDEX IF EXISTS public.idx_user_devices_pending;

ALTER TABLE public.user_devices
    DROP COLUMN IF EXISTS approved_by_user_id,
    DROP COLUMN IF EXISTS approved_at,
    DROP COLUMN IF EXISTS pending_since,
    DROP COLUMN IF EXISTS trust_status;
