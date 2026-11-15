-- Database roles for production. Run once as a superuser, after creating the database:
--
--   psql "$SUPERUSER_URL" -v owner_password="'...'" -v app_password="'...'" -f deploy/db-roles.sql
--
-- politicando_owner owns the tables and runs migrations (DATABASE_URL for db/migrate.js).
-- politicando_app is what the API and jobs use: it can read and write rows, never change
-- the schema, and it can only add to the audit log, never edit or delete it.

create role politicando_owner login password :owner_password;
create role politicando_app login password :app_password;

alter database politicando owner to politicando_owner;
alter schema public owner to politicando_owner;
revoke create on schema public from public;
grant usage on schema public to politicando_app;

-- Tables and sequences that exist now...
grant select, insert, update, delete on all tables in schema public to politicando_app;
grant usage, select on all sequences in schema public to politicando_app;
-- ...and those future migrations create.
alter default privileges for role politicando_owner in schema public
  grant select, insert, update, delete on tables to politicando_app;
alter default privileges for role politicando_owner in schema public
  grant usage, select on sequences to politicando_app;

-- The audit log is append-only for the app. (Re-run this line if a migration recreates the table.)
revoke update, delete, truncate on audit_log from politicando_app;
