#!/bin/sh
set -eu

# Provision a dedicated DML-only Postgres role for the self-hosted Kvitbit
# runtime server (core-ports.md S5). Schema migrations run separately with the
# owner role (POSTGRES_USER); the runtime server only receives POSTGRES_APP_USER.

APP_USER="${POSTGRES_APP_USER:-kvitbit_app}"
APP_PASSWORD="${POSTGRES_APP_PASSWORD:-kvitbit_app}"
OWNER_USER="${POSTGRES_USER:-kvitbit}"
DB_NAME="${POSTGRES_DB:-kvitbit}"

psql -v ON_ERROR_STOP=1 \
  --username "$OWNER_USER" \
  --dbname "$DB_NAME" \
  --set="app_user=${APP_USER}" \
  --set="app_password=${APP_PASSWORD}" \
  --set="owner_user=${OWNER_USER}" \
  --set="db_name=${DB_NAME}" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'app_user')
\gexec

SELECT format('GRANT CONNECT ON DATABASE %I TO %I', :'db_name', :'app_user')
\gexec

SELECT format('GRANT USAGE ON SCHEMA public TO %I', :'app_user')
\gexec

SELECT format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I', :'app_user')
\gexec

SELECT format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I', :'app_user')
\gexec

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', :'owner_user', :'app_user')
\gexec

SELECT format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I', :'owner_user', :'app_user')
\gexec
SQL
