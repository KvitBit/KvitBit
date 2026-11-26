#!/bin/sh
set -eu

export KVITBIT_APP_ROLE="${POSTGRES_APP_USER:-kvitbit_app}"
export KVITBIT_APP_ROLE_PASSWORD="${POSTGRES_APP_PASSWORD:-kvitbit_app}"
export KVITBIT_OWNER_ROLE="${POSTGRES_USER:-kvitbit}"
export PGDATABASE="${POSTGRES_DB:-kvitbit}"

if [ "${1:-}" != "--init" ] && [ -n "${DATABASE_URL:-}${KVITBIT_RUNTIME_DATABASE_URL:-}" ]; then
  . "$(dirname "$0")/database-target.sh"
  target_status=0
  kvitbit_compare_database_target "" "${PGHOST:-postgres}" "${PGPORT:-5432}" "$PGDATABASE" ||
    target_status=$?
  case "$target_status" in
    0)
      ;;
    1|2)
      if [ "$target_status" -eq 2 ] &&
        [ -z "${DATABASE_MIGRATION_URL:-${DATABASE_URL_UNPOOLED:-}}" ]; then
        echo "kvitbit: DATABASE_URL names a different database on the bundled PostgreSQL server. Set DATABASE_MIGRATION_URL or DATABASE_URL_UNPOOLED for that database." >&2
        exit 64
      fi
      echo "kvitbit: DATABASE_URL targets an external database. Manage its runtime role separately." >&2
      exit 0
      ;;
    *)
      echo "kvitbit: DATABASE_URL must identify a PostgreSQL host, port and database for role reconciliation." >&2
      exit 64
      ;;
  esac
fi

if [ "$KVITBIT_APP_ROLE" = "$KVITBIT_OWNER_ROLE" ]; then
  echo "kvitbit: POSTGRES_APP_USER and POSTGRES_USER must name different roles for S5 separation." >&2
  exit 64
fi

psql -X -q --username "$KVITBIT_OWNER_ROLE" \
  -v ON_ERROR_STOP=1 -v VERBOSITY=terse -v SHOW_CONTEXT=never <<'SQL'
\getenv app_user KVITBIT_APP_ROLE
\getenv app_password KVITBIT_APP_ROLE_PASSWORD
\getenv owner_user KVITBIT_OWNER_ROLE
\getenv db_name PGDATABASE

BEGIN;
SET LOCAL search_path = pg_catalog;

SELECT set_config('kvitbit.app_user', :'app_user', true),
       set_config('kvitbit.app_password', :'app_password', true),
       set_config('kvitbit.owner_user', :'owner_user', true),
       set_config('kvitbit.db_name', :'db_name', true)
\g /dev/null

DO $$
DECLARE
  v_app_user text := current_setting('kvitbit.app_user');
  v_owner_user text := current_setting('kvitbit.owner_user');
  v_db pg_database%ROWTYPE;
  v_role pg_roles%ROWTYPE;
  v_schema text;
  v_ddl_role text;
  v_owned_object text;
BEGIN
  SELECT * INTO STRICT v_db FROM pg_database WHERE datname = current_database();
  IF v_db.datname <> current_setting('kvitbit.db_name') THEN
    RAISE EXCEPTION 'Connected database does not match POSTGRES_DB';
  END IF;

  SELECT * INTO v_role FROM pg_roles WHERE rolname = v_app_user;
  IF NOT FOUND THEN
    EXECUTE format(
      'CREATE ROLE %I NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS NOREPLICATION NOINHERIT',
      v_app_user
    );
    SELECT * INTO STRICT v_role FROM pg_roles WHERE rolname = v_app_user;
  END IF;

  IF v_role.rolsuper OR v_role.rolcreatedb OR v_role.rolcreaterole
     OR v_role.rolbypassrls OR v_role.rolreplication THEN
    RAISE EXCEPTION 'Refusing elevated runtime role %', v_app_user;
  END IF;

  IF EXISTS (
    SELECT FROM pg_roles r
    WHERE (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication
           OR r.rolname = v_owner_user OR r.oid = v_db.datdba)
      AND pg_has_role(v_role.oid, r.oid, 'MEMBER')
  ) THEN
    RAISE EXCEPTION 'Runtime role % owns the database or belongs to an owner or elevated role', v_app_user;
  END IF;

  -- Ownership grants DDL authority independently of the database and schema ACLs.
  SELECT pg_describe_object(d.classid, d.objid, d.objsubid)
    INTO v_owned_object
  FROM pg_shdepend d
  WHERE d.dbid = v_db.oid
    AND d.refclassid = 'pg_authid'::regclass
    AND d.deptype = 'o'
    AND pg_has_role(v_role.oid, d.refobjid, 'MEMBER')
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Runtime role % owns database object % directly or through role membership',
      v_app_user, v_owned_object;
  END IF;

  EXECUTE format('REVOKE CREATE ON DATABASE %I FROM %I', v_db.datname, v_app_user);
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', v_db.datname, v_app_user);

  FOREACH v_schema IN ARRAY ARRAY['public', 'auth'] LOOP
    IF EXISTS (SELECT FROM pg_namespace WHERE nspname = v_schema) THEN
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

  -- Membership options can expose CREATE through inheritance or SET ROLE.
  SELECT r.rolname INTO v_ddl_role
  FROM pg_roles r
  WHERE pg_has_role(v_role.oid, r.oid, 'SET')
    AND (
      has_database_privilege(r.oid, v_db.oid, 'CREATE')
      OR EXISTS (
        SELECT FROM pg_namespace n
        WHERE NOT pg_is_other_temp_schema(n.oid)
          AND has_schema_privilege(r.oid, n.oid, 'CREATE')
      )
    )
  LIMIT 1;
  IF FOUND THEN
    RAISE EXCEPTION 'Runtime role % has effective CREATE privileges as %', v_app_user, v_ddl_role;
  END IF;

  BEGIN
    EXECUTE format(
      'ALTER ROLE %I LOGIN NOINHERIT PASSWORD %L',
      v_app_user,
      current_setting('kvitbit.app_password')
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'Could not set the runtime role password' USING ERRCODE = SQLSTATE;
  END;
END
$$;

COMMIT;
SQL
