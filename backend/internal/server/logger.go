package server

import (
	"log/slog"
	"os"
)

var logger = slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{
	Level: slog.LevelInfo,
}))

func fatalLog(message string, args ...any) {
	logger.Error(message, args...)
	os.Exit(1)
}
