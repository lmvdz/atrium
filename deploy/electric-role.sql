-- ═════════════════════════════════════════════════════════════════════════════
-- THE ELECTRIC REPLICATION ROLE (#201).
--
-- Run by the `electric-init` one-shot in docker-compose.yml, as the superuser
-- POSTGRES_USER, AFTER `migrate` has created the two ydoc tables and the
-- publication. It is idempotent: re-running it re-asserts the same grants and
-- rotates the password to whatever `:electric_password` currently is.
--
-- ## WHY THIS IS NOT A MIGRATION
--
-- Roles are cluster objects and passwords are secrets. A drizzle migration runs
-- as the application role, which in a hardened deployment holds neither
-- CREATEROLE nor superuser — so a `CREATE ROLE` in `packages/db/drizzle/` would
-- be a migration that works on a laptop and fails on the box that matters. The
-- schema half (tables, publication, REPLICA IDENTITY) is in migration 0053
-- where a migration belongs; the cluster half is here.
--
-- ## WHY NOT JUST POINT ELECTRIC AT POSTGRES_USER
--
-- Because then the ceiling on what the sync service can read is a config file.
-- With this role it is Postgres: `atrium_electric` owns nothing, holds SELECT on
-- exactly two tables, and cannot alter the publication — so an Electric asked
-- for `users` gets a refusal from the database rather than a filtered answer.
-- Measured against electricsql/electric 1.7.11:
--
--   503 {"message":"Database table \"public.secrets\" is missing from the
--        publication \"electric_publication_default\" and Electric lacks
--        privileges to add it"}
--
-- ## WHAT IT DELIBERATELY DOES NOT GET
--
-- No SELECT on `core_events` — which is also what keeps it OUT of the app-role
-- loop in migrations 0003/0004/0053. Those DO blocks identify an application
-- role as "a non-superuser login role holding SELECT on core_events" and hand it
-- EXECUTE on the append functions. This role holds no such SELECT, so it is
-- given no write door, and adding one here would quietly enrol the sync service
-- as a writer.
--
-- No INSERT, UPDATE or DELETE anywhere. Electric is a READ-path sync engine; a
-- write privilege here would be one nothing uses and everything inherits.
--
-- ## THE EXISTING-VOLUME CAVEAT, STATED RATHER THAN LEFT IMPLIED
--
-- This script is idempotent for the grants it MAKES — CONNECT, USAGE, SELECT on
-- the two ydoc tables — but it is not a full reconciler of the role's TOTAL
-- privilege set. On a clean install that is a distinction without a difference:
-- the role is created here and has nothing else. On a REUSED cluster where an
-- `atrium_electric` already existed, a SELECT it was granted on some other table
-- by an earlier version of this file — or by hand — is NOT revoked here, because
-- this script does not enumerate every object it might have touched. If the set
-- of tables Electric may read is ever narrowed, the removed table's grant has to
-- be revoked explicitly; re-running this file will not do it. What this file DOES
-- guarantee on any volume is the floor: the role holds SELECT on exactly the two
-- ydoc tables and no write anywhere on them, re-asserted every run. The security
-- ceiling those two facts give is real; the caveat is only that a stale grant on
-- a third table from a prior life is the operator's to remove, not this script's
-- to discover.
-- ═════════════════════════════════════════════════════════════════════════════

\set ON_ERROR_STOP on

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'atrium_electric') THEN
    CREATE ROLE "atrium_electric" LOGIN REPLICATION;
  ELSE
    -- LOGIN and REPLICATION re-asserted rather than assumed: a role that exists
    -- is not necessarily a role that still has the attributes it was made with.
    ALTER ROLE "atrium_electric" LOGIN REPLICATION;
  END IF;
END;
$role$;

-- The password is passed in by `electric-init` from ELECTRIC_DATABASE_PASSWORD
-- rather than written here. `:'electric_password'` is psql's quoted-literal
-- interpolation, so a password containing a quote is a password, not a syntax
-- error and not an injection.
ALTER ROLE "atrium_electric" PASSWORD :'electric_password';

GRANT CONNECT ON DATABASE :"database_name" TO "atrium_electric";
GRANT USAGE ON SCHEMA public TO "atrium_electric";

-- Exactly two tables, named one at a time. Not `GRANT SELECT ON ALL TABLES IN
-- SCHEMA public`, which would be a grant that silently widens every time
-- somebody adds a table — the allowlist has to be the compliant form, because a
-- denylist of tables Electric may not read fails open for the next one written.
GRANT SELECT ON TABLE "ydoc_updates" TO "atrium_electric";
GRANT SELECT ON TABLE "ydoc_awareness" TO "atrium_electric";

-- Said out loud rather than left to the absence of a GRANT, so that a future
-- `GRANT ALL ... TO PUBLIC` somewhere else cannot hand this role a write door
-- by accident.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "ydoc_updates" FROM "atrium_electric";
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE "ydoc_awareness" FROM "atrium_electric";
