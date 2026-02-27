package server

import (
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

const defaultRateLimitEntryTTL = 30 * time.Minute

type limiterEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

type keyedRateLimiter struct {
	mu              sync.Mutex
	entries         map[string]*limiterEntry
	limit           rate.Limit
	burst           int
	entryTTL        time.Duration
	cleanupInterval time.Duration
	lastCleanup     time.Time
	now             func() time.Time
}

func newKeyedRateLimiter(limit rate.Limit, burst int, entryTTL time.Duration) *keyedRateLimiter {
	if burst < 1 {
		burst = 1
	}
	if entryTTL <= 0 {
		entryTTL = defaultRateLimitEntryTTL
	}
	cleanupInterval := time.Minute
	if entryTTL < cleanupInterval {
		cleanupInterval = entryTTL
	}
	if cleanupInterval <= 0 {
		cleanupInterval = time.Second
	}
	return &keyedRateLimiter{
		entries:         make(map[string]*limiterEntry),
		limit:           limit,
		burst:           burst,
		entryTTL:        entryTTL,
		cleanupInterval: cleanupInterval,
		now:             time.Now,
	}
}

func perMinuteLimit(tokens int) rate.Limit {
	if tokens <= 0 {
		return 0
	}
	return rate.Limit(float64(tokens) / 60.0)
}

func (l *keyedRateLimiter) Allow(key string) bool {
	if l == nil {
		return true
	}
	now := l.now()
	return l.allowAt(key, now)
}

func (l *keyedRateLimiter) allowAt(key string, now time.Time) bool {
	normalized := strings.TrimSpace(key)
	if normalized == "" {
		normalized = "unknown"
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	if l.lastCleanup.IsZero() || now.Sub(l.lastCleanup) >= l.cleanupInterval {
		l.cleanupLocked(now)
		l.lastCleanup = now
	}

	entry, found := l.entries[normalized]
	if !found {
		entry = &limiterEntry{limiter: rate.NewLimiter(l.limit, l.burst)}
		l.entries[normalized] = entry
	}
	entry.lastSeen = now

	return entry.limiter.AllowN(now, 1)
}

func (l *keyedRateLimiter) cleanupLocked(now time.Time) {
	if l.entryTTL <= 0 {
		return
	}
	for key, entry := range l.entries {
		if now.Sub(entry.lastSeen) > l.entryTTL {
			delete(l.entries, key)
		}
	}
}

func clientKeyFromRequest(r *http.Request, trustProxyHeaders bool) string {
	if trustProxyHeaders {
		if ip := normalizeClientIPCandidate(r.Header.Get("CF-Connecting-IP")); ip != "" {
			return ip
		}
		if ip := extractForwardedFor(r.Header.Get("X-Forwarded-For")); ip != "" {
			return ip
		}
		if ip := normalizeClientIPCandidate(r.Header.Get("X-Real-IP")); ip != "" {
			return ip
		}
	}
	if ip := normalizeClientIPCandidate(r.RemoteAddr); ip != "" {
		return ip
	}
	return "unknown"
}

func extractForwardedFor(raw string) string {
	parts := strings.Split(raw, ",")
	for index := len(parts) - 1; index >= 0; index -= 1 {
		candidate := parts[index]
		if ip := normalizeClientIPCandidate(candidate); ip != "" {
			return ip
		}
	}
	return ""
}

func normalizeClientIPCandidate(raw string) string {
	candidate := strings.TrimSpace(raw)
	if candidate == "" {
		return ""
	}

	if host, _, err := net.SplitHostPort(candidate); err == nil {
		candidate = strings.TrimSpace(host)
	}

	candidate = strings.TrimPrefix(candidate, "[")
	candidate = strings.TrimSuffix(candidate, "]")

	if ip := net.ParseIP(candidate); ip != nil {
		return ip.String()
	}

	return candidate
}

func respondRateLimited(w http.ResponseWriter, message string) {
	trimmed := strings.TrimSpace(message)
	if trimmed == "" {
		trimmed = "too many requests"
	}
	w.Header().Set("Retry-After", "60")
	respondJSON(w, http.StatusTooManyRequests, map[string]any{"error": trimmed})
}
