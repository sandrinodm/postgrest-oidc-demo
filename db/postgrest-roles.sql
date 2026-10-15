-- Roles PostgREST needs. Safe to run again, and safe on a database that already
-- has PostgREST (such as a managed PostgREST service): existing roles are kept as they are,
-- only missing ones are created.
--
--   authenticator_role  the login role PostgREST connects as (no privileges itself)
--   anon_role           used for requests without a JWT; gets no table access
--   authenticated_role  used for requests with a verified JWT, either named in
--                       the token's `role` claim or set by timeoff.pre_request
--
-- psql variables (set by scripts/setup-postgrest.sh):
--   authenticator_role, anon_role, authenticated_role  role names (defaults:
--                           authenticator, anon, authenticated)
--   authenticator_password  optional; sets the password when given

\if :{?authenticator_role}
\else
  \set authenticator_role authenticator
\endif
\if :{?anon_role}
\else
  \set anon_role anon
\endif
\if :{?authenticated_role}
\else
  \set authenticated_role authenticated
\endif

select not exists (select 1 from pg_roles where rolname = :'authenticator_role') as missing_authenticator,
       not exists (select 1 from pg_roles where rolname = :'anon_role') as missing_anon,
       not exists (select 1 from pg_roles where rolname = :'authenticated_role') as missing_authenticated
\gset

-- noinherit: PostgREST switches roles explicitly; the login role itself can't
-- read anything. Only set on roles created here, so a managed PostgREST's own
-- login role is left exactly as its provider configured it.
\if :missing_authenticator
create role :"authenticator_role" login noinherit;
\endif
\if :missing_anon
create role :"anon_role" nologin;
\endif
\if :missing_authenticated
create role :"authenticated_role" nologin;
\endif

\if :{?authenticator_password}
alter role :"authenticator_role" with password :'authenticator_password';
\endif

-- PostgREST can only switch to roles granted to its login role. Only missing
-- grants are made: re-granting an existing one would need ADMIN on a role that a
-- managed PostgREST created, which the user running this may not have.
select not pg_has_role(:'authenticator_role', :'anon_role', 'MEMBER') as needs_anon_grant,
       not pg_has_role(:'authenticator_role', :'authenticated_role', 'MEMBER') as needs_authenticated_grant
\gset

\if :needs_anon_grant
grant :"anon_role" to :"authenticator_role";
\endif
\if :needs_authenticated_grant
grant :"authenticated_role" to :"authenticator_role";
\endif
