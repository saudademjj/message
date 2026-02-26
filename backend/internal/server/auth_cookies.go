package server

import (
	"net/http"
	"strings"
	"time"
)

func isSecureRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	forwardedProto := strings.TrimSpace(strings.ToLower(r.Header.Get("X-Forwarded-Proto")))
	if forwardedProto == "" {
		return false
	}
	if comma := strings.IndexByte(forwardedProto, ','); comma >= 0 {
		forwardedProto = strings.TrimSpace(forwardedProto[:comma])
	}
	return forwardedProto == "https" || forwardedProto == "wss"
}

func setSessionCookies(
	w http.ResponseWriter,
	accessToken string,
	refreshToken string,
	csrfToken string,
	secure bool,
	accessTTL time.Duration,
	refreshTTL time.Duration,
) {
	accessMaxAge := int(accessTTL.Seconds())
	refreshMaxAge := int(refreshTTL.Seconds())
	if accessMaxAge < 1 {
		accessMaxAge = int((time.Duration(defaultAccessTokenMins) * time.Minute).Seconds())
	}
	if refreshMaxAge < 1 {
		refreshMaxAge = int((time.Duration(defaultRefreshTokenHrs) * time.Hour).Seconds())
	}

	http.SetCookie(w, &http.Cookie{
		Name:     authCookieName,
		Value:    accessToken,
		Path:     "/",
		MaxAge:   accessMaxAge,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    refreshToken,
		Path:     "/",
		MaxAge:   refreshMaxAge,
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     csrfCookieName,
		Value:    csrfToken,
		Path:     "/",
		MaxAge:   refreshMaxAge,
		HttpOnly: false,
		Secure:   secure,
		SameSite: http.SameSiteStrictMode,
	})
}

func clearSessionCookies(w http.ResponseWriter, secure bool) {
	for _, cookieName := range []string{authCookieName, refreshCookieName, csrfCookieName} {
		http.SetCookie(w, &http.Cookie{
			Name:     cookieName,
			Value:    "",
			Path:     "/",
			MaxAge:   -1,
			HttpOnly: cookieName == authCookieName,
			Secure:   secure,
			SameSite: http.SameSiteStrictMode,
		})
	}
}

func authTokenFromRequest(r *http.Request) (token string, source string) {
	authHeader := strings.TrimSpace(r.Header.Get("Authorization"))
	if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
		tokenValue := strings.TrimSpace(authHeader[7:])
		if tokenValue != "" {
			return tokenValue, "bearer"
		}
	}
	cookie, err := r.Cookie(authCookieName)
	if err != nil {
		return "", ""
	}
	cookieToken := strings.TrimSpace(cookie.Value)
	if cookieToken == "" {
		return "", ""
	}
	return cookieToken, "cookie"
}

func refreshTokenFromRequest(r *http.Request) string {
	cookie, err := r.Cookie(refreshCookieName)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(cookie.Value)
}
