#!/bin/sh
set -eu

# Provision a dedicated DML-only Postgres role for the self-hosted Kvitbit
# runtime server during fresh database initialization (core-ports.md S5).
# Schema migrations run separately with the owner role (POSTGRES_USER), followed
# by docker/reconcile-app-role.sh so both fresh and existing volumes receive
# grants on migrated schemas (public and auth).

APP_USER="${POSTGRES_APP_USER:-kvitbit_app}"
APP_PASSWORD="${POSTGRES_APP_PASSWORD:-kvitbit_app}"
OWNER_USER="${POSTGRES_USER:-kvitbit}"
DB_NAME="${POSTGRES_DB:-kvitbit}"

if [ -z "$APP_USER" ] || [ -z "$OWNER_USER" ] || [ -z "$DB_NAME" ]; then
  echo "kvitbit: POSTGRES_USER, POSTGRES_APP_USER, and POSTGRES_DB must be non-empty" >&2
  exit 64
fi

if [ "$APP_USER" = "$OWNER_USER" ]; then
  echo "kvitbit: refusing initdb role setup: POSTGRES_APP_USER ('${APP_USER}') must not equal owner role POSTGRES_USER ('${OWNER_USER}') (S5 DML-only separation)" >&2
  exit 64
fi

psql -v ON_ERROR_STOP=1 \
  --username "$OWNER_USER" \
  --dbname "$DB_NAME" \
  --set="app_user=${APP_USER}" \
  --set="app_password=${APP_PASSWORD}" \
  --set="owner_user=${OWNER_USER}" \
  --set="db_name=${DB_NAME}" <<'SQL'
SELECT set_config('kvitbit.app_user', :'app_user', false),
       set_config('kvitbit.app_password', :'app_password', false),
       set_config('kvitbit.owner_user', :'owner_user', false),
       set_config('kvitbit.db_name', :'db_name', false);

DO $$
DECLARE
  v_app_user text := current_setting('kvitbit.app_user');
  v_app_password text := current_setting('kvitbit.app_password');
  v_owner_user text := current_setting('kvitbit.owner_user');
  v_db_name text := current_setting('kvitbit.db_name');
  v_role record;
  v_schema text;
BEGIN
  IF v_app_user = v_owner_user THEN
    RAISE EXCEPTION 'POSTGRES_APP_USER (%) must not equal owner role POSTGRES_USER (%)', v_app_user, v_owner_user;
  END IF;

  SELECT rolsuper, rolcreatedb, rolcreaterole
    INTO v_role
    FROM pg_roles
   WHERE rolname = v_app_user;

  IF FOUND THEN
    IF v_role.rolsuper OR v_role.rolcreatedb OR v_role.rolcreaterole THEN
      RAISE EXCEPTION 'Refusing elevated runtime role % (rolsuper=%, rolcreatedb=%, rolcreaterole=%)',
        v_app_user, v_role.rolsuper, v_role.rolcreatedb, v_role.rolcreaterole;
    END IF;
    EXECUTE format(
      'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
      v_app_user,
      v_app_password
    );
  ELSE
    EXECUTE format(
      'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
      v_app_user,
      v_app_password
    );
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', v_db_name, v_app_user);

  FOREACH v_schema IN ARRAY ARRAY['public', 'auth'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.schemata WHERE schema_name = v_schema) THEN
      EXECUTE format('REVOKE CREATE ON SCHEMA %I FROM %I', v_schema, v_app_user);
      EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', v_schema, v_app_user);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', v_schema, v_app_user);
      EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', v_schema, v_app_user);
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
        v_owner_user,
        v_schema,
        v_app_user
      );
      EXECUTE format(
        'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I',
        v_owner_user,
        v_schema,
        v_app_user
      );
    END IF;
  END LOOP;
END
$$;
SQL
