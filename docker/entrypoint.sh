#!/bin/sh
set -eu

export HOST="${HOST:-0.0.0.0}"
export PORT="${PORT:-8080}"
export KVITBIT_RUNNER_MODE="${KVITBIT_RUNNER_MODE:-single}"
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
    if [ -n "${DATABASE_MIGRATION_URL:-}" ]; then
      export DATABASE_URL_UNPOOLED="$DATABASE_MIGRATION_URL"
    elif [ -z "${DATABASE_URL_UNPOOLED:-}" ]; then
      if [ -n "${KVITBIT_BUNDLED_MIGRATION_URL:-}${KVITBIT_RUNTIME_DATABASE_URL:-}${KVITBIT_BUNDLED_DATABASE_NAME:-}" ]; then
        . "$(dirname "$0")/database-target.sh"
        if [ -z "${KVITBIT_BUNDLED_MIGRATION_URL:-}" ] ||
          ! kvitbit_compare_database_target "$KVITBIT_BUNDLED_MIGRATION_URL" postgres 5432 "${KVITBIT_BUNDLED_DATABASE_NAME:-}"; then
          echo "kvitbit: DATABASE_URL must point to the bundled PostgreSQL host, port and database to use bundled migration credentials. Set DATABASE_MIGRATION_URL or DATABASE_URL_UNPOOLED for an external database or a different database on the same server." >&2
          exit 64
        fi
      fi
      if [ -n "${KVITBIT_BUNDLED_MIGRATION_URL:-}" ]; then
        export DATABASE_URL_UNPOOLED="${KVITBIT_BUNDLED_MIGRATION_URL}"
      fi
    fi
    if [ -z "${DATABASE_URL_UNPOOLED:-}" ]; then
      echo "kvitbit: migrate requires DATABASE_MIGRATION_URL or DATABASE_URL_UNPOOLED for the direct owner connection" >&2
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
