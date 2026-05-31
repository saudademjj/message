-- Revert the device_envelopes primary key back to (message_id, recipient_device_id).
-- Note: if cross-user device_id collisions exist this revert may fail on the
-- narrower key; that is expected since the wider key was added to allow them.
ALTER TABLE chat_mailbox.device_envelopes
    DROP CONSTRAINT IF EXISTS device_envelopes_recipient_user_id_recipient_device_id_fkey;

ALTER TABLE chat_mailbox.device_envelopes
    DROP CONSTRAINT IF EXISTS device_envelopes_pkey;

ALTER TABLE chat_mailbox.device_envelopes
    ADD CONSTRAINT device_envelopes_pkey
    PRIMARY KEY (message_id, recipient_device_id);

ALTER TABLE chat_mailbox.device_envelopes
    ADD CONSTRAINT device_envelopes_recipient_user_id_recipient_device_id_fkey
    FOREIGN KEY (recipient_user_id, recipient_device_id)
        REFERENCES public.user_devices(user_id, device_id)
        ON DELETE CASCADE;
