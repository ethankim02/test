-- Runs automatically on first container start via docker-entrypoint-initdb.d.
-- Creates the restricted runtime role separate from the migration owner role.
-- Table-level REVOKEs (no UPDATE/DELETE on ledger_entries, payment_state_transitions,
-- reconciliation_records) are applied by the Drizzle migrations themselves, once those
-- tables exist, so they take effect for both docker-compose and any other Postgres target.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'treasury_app') THEN
    CREATE ROLE treasury_app WITH LOGIN PASSWORD 'treasury';
  END IF;
END
$$;

GRANT CONNECT ON DATABASE treasury_dev TO treasury_app;
