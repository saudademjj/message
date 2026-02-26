#!/bin/bash
set -euo pipefail

cd ~/e2ee-chat

BACKEND_BIN="/home/saudade/e2ee-chat/bin/e2ee-chat-backend"
BACKEND_LOG="/home/saudade/e2ee-chat/backend.log"
CADDY_BIN="/usr/bin/caddy"
CADDY_CONFIG="/home/saudade/e2ee-chat/frontend/Caddyfile"
CADDY_LOG="/home/saudade/e2ee-chat/caddy.log"
CHAT_SITE_HOST_DEFAULT="47.100.248.114"
BACKEND_HEALTH_URL="http://127.0.0.1:8081/healthz"

wait_pids_gone() {
    local pattern="$1"
    local wait_label="$2"
    local loops=0
    local pids

    while true; do
        pids=$(pgrep -f "${pattern}" || true)
        if [ -z "${pids}" ]; then
            return 0
        fi

        if [ "${loops}" -ge 20 ]; then
            echo "${wait_label} still running after wait: ${pids}"
            return 1
        fi

        sleep 0.2
        loops=$((loops + 1))
    done
}

require_pid_alive() {
    local pid="$1"
    local proc_label="$2"
    local log_path="$3"

    sleep 0.2
    if ! kill -0 "${pid}" >/dev/null 2>&1; then
        echo "${proc_label} exited unexpectedly (pid ${pid})"
        if [ -f "${log_path}" ]; then
            echo "Last ${proc_label} log lines:"
            tail -n 60 "${log_path}" || true
        fi
        return 1
    fi

    return 0
}

load_env() {
    if [ ! -f ./.env ]; then
        return
    fi

    while IFS= read -r line || [ -n "${line}" ]; do
        case "${line}" in
            ""|\#*)
                continue
                ;;
        esac
        key="${line%%=*}"
        value="${line#*=}"
        export "${key}=${value}"
    done < ./.env
}

stop_backend() {
    local pattern="^${BACKEND_BIN}$"
    existing_backend_pids=$(pgrep -f "${pattern}" || true)
    if [ -n "${existing_backend_pids}" ]; then
        echo "Stopping backend: ${existing_backend_pids}"
        kill ${existing_backend_pids} || true
        wait_pids_gone "${pattern}" "Backend" || true
    fi

    remaining_backend_pids=$(pgrep -f "${pattern}" || true)
    if [ -n "${remaining_backend_pids}" ]; then
        echo "Force stopping backend: ${remaining_backend_pids}"
        kill -9 ${remaining_backend_pids} || true
        wait_pids_gone "${pattern}" "Backend" || true
    fi
}

stop_frontend_proxy() {
    local pattern="${CADDY_BIN} run --config ${CADDY_CONFIG} --adapter caddyfile"
    existing_caddy_pids=$(pgrep -f "${pattern}" || true)
    if [ -n "${existing_caddy_pids}" ]; then
        echo "Stopping frontend proxy: ${existing_caddy_pids}"
        kill ${existing_caddy_pids} || true
        wait_pids_gone "${pattern}" "Frontend proxy" || true
    fi

    remaining_caddy_pids=$(pgrep -f "${pattern}" || true)
    if [ -n "${remaining_caddy_pids}" ]; then
        echo "Force stopping frontend proxy: ${remaining_caddy_pids}"
        kill -9 ${remaining_caddy_pids} || true
        wait_pids_gone "${pattern}" "Frontend proxy" || true
    fi
}

start_backend() {
    nohup "${BACKEND_BIN}" > "${BACKEND_LOG}" 2>&1 &
    backend_pid=$!
    echo "Started backend PID: ${backend_pid}"
    require_pid_alive "${backend_pid}" "Backend" "${BACKEND_LOG}"
}

validate_frontend_proxy_config() {
    "${CADDY_BIN}" validate --config "${CADDY_CONFIG}" --adapter caddyfile >/dev/null
}

start_frontend_proxy() {
    validate_frontend_proxy_config
    nohup "${CADDY_BIN}" run --config "${CADDY_CONFIG}" --adapter caddyfile > "${CADDY_LOG}" 2>&1 &
    caddy_pid=$!
    echo "Started frontend proxy PID: ${caddy_pid}"
    require_pid_alive "${caddy_pid}" "Frontend proxy" "${CADDY_LOG}"
}

wait_backend_health() {
    for _ in {1..20}; do
        if curl -fsS "${BACKEND_HEALTH_URL}" >/dev/null 2>&1; then
            echo "Backend health check passed"
            return 0
        fi
        sleep 0.5
    done

    echo "Backend health check failed"
    return 1
}

wait_frontend_health() {
    chat_site_host="${CHAT_SITE_HOST:-${CHAT_SITE_HOST_DEFAULT}}"
    for _ in {1..20}; do
        if curl -kfsS --resolve "${chat_site_host}:8443:127.0.0.1" "https://${chat_site_host}:8443/" >/dev/null 2>&1; then
            echo "Frontend HTTPS health check passed"
            return 0
        fi
        sleep 0.5
    done

    echo "Frontend HTTPS health check failed"
    return 1
}

load_env
stop_backend
stop_frontend_proxy
start_backend
wait_backend_health
start_frontend_proxy
wait_frontend_health
