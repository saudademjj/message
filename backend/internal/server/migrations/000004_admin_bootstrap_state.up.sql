-- Tracks per-admin-user bootstrap state so that the initial admin room is
-- only auto-created the first time a given admin identity boots, not on every
-- server restart. This lets administrators delete the system room and have
-- the deletion persist across reboots.
CREATE TABLE IF NOT EXISTS admin_bootstrap_state (
    admin_user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    initial_room_provisioned BOOLEAN NOT NULL DEFAULT FALSE,
    initial_room_provisioned_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill: any admin whose configured room currently exists has clearly
-- already been provisioned. Mark them as provisioned so we do not re-create
-- the room after an explicit deletion.
INSERT INTO admin_bootstrap_state(admin_user_id, initial_room_provisioned, initial_room_provisioned_at, updated_at)
SELECT u.id, TRUE, NOW(), NOW()
FROM users u
WHERE u.role = 'admin'
  AND EXISTS (
    SELECT 1 FROM rooms r
    WHERE r.created_by = u.id
      AND COALESCE(r.is_system, FALSE) = TRUE
  )
ON CONFLICT (admin_user_id) DO NOTHING;
