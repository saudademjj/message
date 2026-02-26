package server

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"time"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/postgres"
	"github.com/golang-migrate/migrate/v4/source/iofs"
)

//go:embed migrations/*.sql
var migrationsFS embed.FS

func runMigrations(db *sql.DB) error {
	driver, err := postgres.WithInstance(db, &postgres.Config{MigrationsTable: "schema_migrations"})
	if err != nil {
		return fmt.Errorf("initialize migration driver: %w", err)
	}

	sourceDriver, err := iofs.New(migrationsFS, "migrations")
	if err != nil {
		return fmt.Errorf("initialize migration source: %w", err)
	}

	migrator, err := migrate.NewWithInstance("iofs", sourceDriver, "postgres", driver)
	if err != nil {
		return fmt.Errorf("create migrator: %w", err)
	}

	if err := migrator.Up(); err != nil && !errors.Is(err, migrate.ErrNoChange) {
		return fmt.Errorf("apply migrations: %w", err)
	}
	return nil
}

func bootstrapAdminSecurity(db *sql.DB, adminUsername, adminPasswordHash, adminRoomName string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx,
		`UPDATE users SET role = 'user' WHERE username <> $1`,
		adminUsername,
	); err != nil {
		return err
	}

	var adminID int64
	err = tx.QueryRowContext(ctx, `
INSERT INTO users(username, password_hash, role)
VALUES ($1, $2, 'admin')
ON CONFLICT (username) DO UPDATE
SET password_hash = EXCLUDED.password_hash,
    role = 'admin'
RETURNING id
`, adminUsername, adminPasswordHash).Scan(&adminID)
	if err != nil {
		return err
	}

	var roomID int64
	err = tx.QueryRowContext(ctx, `
INSERT INTO rooms(name, created_by, is_system)
VALUES ($1, $2, TRUE)
ON CONFLICT (name) DO UPDATE
SET created_by = EXCLUDED.created_by,
    is_system = TRUE
RETURNING id
`, adminRoomName, adminID).Scan(&roomID)
	if err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO room_members(room_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
		roomID, adminID,
	); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx,
		`DELETE FROM room_members WHERE room_id = $1 AND user_id <> $2`,
		roomID, adminID,
	); err != nil {
		return err
	}

	if _, err := tx.ExecContext(ctx,
		`DELETE FROM rooms WHERE name = 'general' AND COALESCE(is_system, FALSE) = FALSE`,
	); err != nil {
		return err
	}

	return tx.Commit()
}
