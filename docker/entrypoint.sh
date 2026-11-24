#!/bin/sh
set -eu

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8080}"
export KVITBIT_RUNNER_MODE="${KVITBIT_RUNNER_MODE:-single}"
export KVITBIT_BLOB_DRIVER="${KVITBIT_BLOB_DRIVER:-local}"
export KVITBIT_BLOB_DIR="${KVITBIT_BLOB_DIR:-/var/lib/kvitbit/blobs}"
export KVITBIT_WEB_DIR="${KVITBIT_WEB_DIR:-/app/public/web}"
export KVITBIT_PWA_DIR="${KVITBIT_PWA_DIR:-/app/public/app}"
export KVITBIT_CHROMIUM_PATH="${KVITBIT_CHROMIUM_PATH:-/usr/bin/chromium}"
export CHROMIUM_PATH="${CHROMIUM_PATH:-$KVITBIT_CHROMIUM_PATH}"
export KVITBIT_SHARE_KEY_VERSION="${KVITBIT_SHARE_KEY_VERSION:-1}"
export KVITBIT_MOBILE_STORAGE_DIR="${KVITBIT_MOBILE_STORAGE_DIR:-/var/lib/kvitbit/mobile}"

APP_ROOT="${KVITBIT_APP_ROOT:-/app}"
BUN_BIN="${KVITBIT_BUN_BIN:-bun}"

cmd="${1:-server}"
if [ "$#" -gt 0 ]; then
  shift
fi

case "$cmd" in
  server)
    entry="${APP_ROOT}/apps/server/src/main.ts"
    if [ ! -f "$entry" ]; then
      echo "kvitbit: server entrypoint not found at ${entry} (apps/server is not present in this image)" >&2
      exit 69
    fi
    exec "$BUN_BIN" "$entry" "$@"
    ;;

  worker)
    entry="${APP_ROOT}/apps/server/src/worker.ts"
    if [ ! -f "$entry" ]; then
      echo "kvitbit: worker entrypoint not found at ${entry} (apps/server is not present in this image)" >&2
      exit 69
    fi
    exec "$BUN_BIN" "$entry" "$@"
    ;;

  migrate)
    if [ -z "${DATABASE_URL_UNPOOLED:-}" ] && [ -z "${DATABASE_URL:-}" ]; then
      echo "kvitbit: migrate requires DATABASE_URL_UNPOOLED (preferred, owner role) or DATABASE_URL" >&2
      exit 64
    fi
    entry="${APP_ROOT}/apps/server/src/migrate.ts"
    if [ -f "$entry" ]; then
      exec "$BUN_BIN" "$entry" "$@"
    fi
    db_dir="${APP_ROOT}/packages/db"
    if [ -d "${db_dir}/drizzle" ]; then
      echo "kvitbit: ${entry} not found; falling back to packages/db Drizzle migrations" >&2
      cd "$db_dir"
      exec "$BUN_BIN" x drizzle-kit migrate "$@"
    fi
    echo "kvitbit: neither ${entry} nor ${db_dir}/drizzle exists" >&2
    exit 69
    ;;

  healthcheck)
    exec "$BUN_BIN" -e '
      const port = process.env.PORT ?? "8080";
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 3000);
      try {
        const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: controller.signal });
        if (!res.ok) process.exit(1);
      } catch {
        process.exit(1);
      } finally {
        clearTimeout(timer);
      }
    '
    ;;

  *)
    exec "$cmd" "$@"
    ;;
esac
