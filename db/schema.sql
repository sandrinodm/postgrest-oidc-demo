-- Tables, row level security and helper functions for the time-off API.
--
--   public   exposed by PostgREST: the tables, the admin_rules view and whoami()
--   timeoff  not exposed: helpers that read the verified JWT claims PostgREST
--            puts in `request.jwt.claims`, and the admin rules. The name is
--            app-specific on purpose, so it can't collide with schemas such as
--            `auth` that an existing PostgREST setup (e.g. Supabase) may have.
--
-- Safe to run again: everything is created when missing and updated in place
-- otherwise (functions, views and policies are replaced, data is kept).
-- Applied by scripts/setup-database.sh.
--
-- psql variables:
--   anon_role           role PostgREST uses without a JWT (default anon)
--   authenticated_role  role for requests with a verified JWT (default authenticated)
-- Both roles must exist already (scripts/setup-postgrest.sh creates them).

\if :{?anon_role}
\else
  \set anon_role anon
\endif
\if :{?authenticated_role}
\else
  \set authenticated_role authenticated
\endif
create schema if not exists timeoff;

-- The anonymous role gets no access to the objects in public (see the end of
-- this file); it only needs `timeoff` to run the pre-request hook.
grant usage on schema public to :"authenticated_role";
grant usage on schema timeoff to :"anon_role", :"authenticated_role";

-- ---------------------------------------------------------------------------
-- Claim helpers
-- ---------------------------------------------------------------------------

create or replace function timeoff.claims() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

-- The subject of the token. Used as the owner of every record.
create or replace function timeoff.uid() returns text
language sql stable
as $$
  select nullif(timeoff.claims() ->> 'sub', '')
$$;

-- Rejects a request that has no verified identity (no JWT, or a JWT without a
-- `sub`) with HTTP 401: PostgREST turns SQLSTATE PT401 into that status. Used by
-- the restrictive policies and whoami(), so such a request gets an explicit
-- error instead of an empty result, even when the anonymous role is shared with
-- signed-in requests. Returns true otherwise, so it can sit in a policy.
create or replace function timeoff.require_identity() returns boolean
language plpgsql stable
as $$
begin
  if timeoff.uid() is null then
    raise exception 'Sign-in required'
      using errcode = 'PT401',
            detail = 'The request has no verified identity: no JWT, or a JWT without a sub claim.',
            hint = 'Send an access token in the Authorization header.';
  end if;
  return true;
end
$$;

-- Best-effort email: providers disagree on which claim carries it
-- (Entra ID, for instance, often only sends `preferred_username` or `upn`).
create or replace function timeoff.email() returns text
language sql stable
as $$
  select lower(coalesce(
    timeoff.claims() ->> 'email',
    timeoff.claims() ->> 'preferred_username',
    timeoff.claims() ->> 'upn'
  ))
$$;

-- All scalar values found at a JSON path in the claims. Arrays are unwrapped,
-- so `$.groups` on {"groups": ["a", "b"]} yields 'a' and 'b'.
create or replace function timeoff.claim_values(path jsonpath) returns setof text
language sql stable
as $$
  select case jsonb_typeof(e) when 'string' then e #>> '{}' else e::text end
  from jsonb_path_query(timeoff.claims(), path) as found(v),
       jsonb_array_elements(
         case jsonb_typeof(found.v) when 'array' then found.v else jsonb_build_array(found.v) end
       ) as e
  where jsonb_typeof(e) in ('string', 'number', 'boolean')
$$;

-- PostgREST switches to the role named in the JWT `role` claim, and falls
-- back to the anon role when there is none. Tokens from an OIDC provider
-- normally have no `role` claim, so any request carrying a verified token with
-- a subject is promoted to the authenticated role here. Wired up through
-- PGRST_DB_PRE_REQUEST=timeoff.pre_request; not needed when your tokens
-- already carry a `role` claim.
select format($fn$
create or replace function timeoff.pre_request() returns void
language plpgsql
as $body$
begin
  if current_user = %L and timeoff.uid() is not null then
    set local role %I;
  end if;
end
$body$
$fn$, :'anon_role', :'authenticated_role')
\gexec


-- ---------------------------------------------------------------------------
-- Admin rules
--
-- A user is an admin when their claims match at least one enabled rule.
-- Examples:
--   ('$.email',               'equals',    'boss@example.com')
--   ('$.email',               'ends_with', '@hr.example.com')
--   ('$.groups',              'equals',    'timeoff-admins')   -- "in group"
--   ('$.realm_access.roles',  'equals',    'admin')            -- Keycloak
--   ('$."https://example.com/roles"', 'equals', 'admin')       -- Auth0
-- Comparisons are case-insensitive. Rules with source = 'env' are managed by
-- scripts/setup-database.sh (the ADMIN_* settings) and rewritten on each run;
-- rules with source = 'manual' are left alone.
-- ---------------------------------------------------------------------------

do $$
begin
  create type timeoff.rule_operator as enum ('equals', 'ends_with', 'starts_with', 'contains', 'matches');
exception when duplicate_object then null;
end
$$;

create table if not exists timeoff.admin_rules (
  id                     int generated always as identity primary key,
  claim                  jsonpath not null,
  operator               timeoff.rule_operator not null default 'equals',
  value                  text not null,
  require_email_verified boolean not null default false,
  enabled                boolean not null default true,
  source                 text not null default 'manual' check (source in ('manual', 'env')),
  description            text,
  created_at             timestamptz not null default now()
);

create or replace function timeoff.rule_matches(r timeoff.admin_rules) returns boolean
language sql stable
as $$
  select r.enabled
    and (not r.require_email_verified or (timeoff.claims() -> 'email_verified') = 'true'::jsonb)
    and exists (
      select 1
      from timeoff.claim_values(r.claim) as v
      where case r.operator
        when 'equals'      then lower(v) = lower(r.value)
        when 'ends_with'   then right(lower(v), length(r.value)) = lower(r.value)
        when 'starts_with' then left(lower(v), length(r.value)) = lower(r.value)
        when 'contains'    then strpos(lower(v), lower(r.value)) > 0
        when 'matches'     then v ~* r.value
      end
    )
$$;

-- security definer: callers cannot read timeoff.admin_rules themselves.
create or replace function timeoff.is_admin() returns boolean
language sql stable security definer
set search_path = ''
as $$
  select timeoff.uid() is not null
    and exists (select 1 from timeoff.admin_rules r where timeoff.rule_matches(r))
$$;


-- Read-only view of the rules for admins. It runs as its owner (the user that
-- ran the setup), so it can read the private table; the WHERE clause hides it
-- from everyone else.
create or replace view public.admin_rules with (security_barrier) as
  select
    r.id,
    r.claim::text as claim,
    r.operator::text as operator,
    r.value,
    r.require_email_verified,
    r.enabled,
    r.source,
    r.description,
    timeoff.rule_matches(r) as matches_me
  from timeoff.admin_rules r
  where (select timeoff.require_identity()) and (select timeoff.is_admin());

-- Only signed-in requests may read it. The revoke undoes grants to the
-- anonymous role from earlier runs, when it could double as the signed-in role.
revoke all on public.admin_rules from :"anon_role";
grant select on public.admin_rules to :"authenticated_role";

-- ---------------------------------------------------------------------------
-- Time off
-- ---------------------------------------------------------------------------

do $$
begin
  create type public.time_off_status as enum ('pending', 'approved', 'rejected', 'cancelled');
exception when duplicate_object then null;
end
$$;

create table if not exists public.time_off_types (
  code              text primary key,
  label             text not null,
  color             text not null default '#64748b',
  requires_approval boolean not null default true
);

insert into public.time_off_types (code, label, color, requires_approval) values
  ('vacation', 'Vacation',       '#2563eb', true),
  ('sick',     'Sick leave',     '#dc2626', false),
  ('personal', 'Personal day',   '#7c3aed', true),
  ('parental', 'Parental leave', '#059669', true),
  ('unpaid',   'Unpaid leave',   '#64748b', true)
on conflict (code) do nothing;

-- Weekdays between two dates, inclusive.
create or replace function timeoff.business_days(from_date date, to_date date) returns int
language sql immutable
as $$
  select count(*)::int
  from generate_series(0, to_date - from_date) as i
  where extract(isodow from from_date + i) < 6
$$;

create table if not exists public.time_off_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     text not null default timeoff.uid(),
  user_email  text default timeoff.email(),
  user_name   text default timeoff.claims() ->> 'name',
  type_code   text not null references public.time_off_types (code),
  start_date  date not null,
  end_date    date not null,
  half_day    boolean not null default false,
  days        numeric(5, 1) generated always as (
                case when half_day then 0.5 else timeoff.business_days(start_date, end_date) end
              ) stored,
  reason      text,
  status      public.time_off_status not null default 'pending',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint end_after_start check (end_date >= start_date),
  constraint half_day_is_single_day check (not half_day or start_date = end_date)
);

create index if not exists time_off_requests_user_id_start_date_idx
  on public.time_off_requests (user_id, start_date desc);

comment on table public.time_off_requests is
  'Time-off bookings. Users see and manage their own; admins see everything.';

create or replace function timeoff.touch_updated_at() returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end
$$;

create or replace trigger time_off_requests_touch
  before update on public.time_off_requests
  for each row execute function timeoff.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row level security
--
-- The (select ...) wrappers let Postgres evaluate the helpers once per
-- statement instead of once per row.
-- ---------------------------------------------------------------------------

alter table public.time_off_types enable row level security;
alter table public.time_off_requests enable row level security;

-- Anonymous requests get no table access; only the signed-in role does. The
-- revoke undoes grants to the anonymous role from earlier runs.
revoke all on public.time_off_types, public.time_off_requests from :"anon_role";
grant select, insert, update, delete on public.time_off_types to :"authenticated_role";
grant select, insert, update, delete on public.time_off_requests to :"authenticated_role";

drop policy if exists types_read on public.time_off_types;
create policy types_read on public.time_off_types
  for select to :"authenticated_role"
  using ((select timeoff.uid()) is not null);

drop policy if exists types_admin_write on public.time_off_types;
create policy types_admin_write on public.time_off_types
  for all to :"authenticated_role"
  using ((select timeoff.is_admin()))
  with check ((select timeoff.is_admin()));

drop policy if exists requests_select on public.time_off_requests;
create policy requests_select on public.time_off_requests
  for select to :"authenticated_role"
  using (user_id = (select timeoff.uid()) or (select timeoff.is_admin()));

-- Users book for themselves, and only as 'pending'. Admins can do anything.
drop policy if exists requests_insert on public.time_off_requests;
create policy requests_insert on public.time_off_requests
  for insert to :"authenticated_role"
  with check (
    (select timeoff.is_admin())
    or (user_id = (select timeoff.uid()) and status = 'pending')
  );

-- Users may edit their own requests and cancel them, but not approve them.
drop policy if exists requests_update on public.time_off_requests;
create policy requests_update on public.time_off_requests
  for update to :"authenticated_role"
  using (user_id = (select timeoff.uid()) or (select timeoff.is_admin()))
  with check (
    (select timeoff.is_admin())
    or (user_id = (select timeoff.uid()) and status in ('pending', 'cancelled'))
  );

drop policy if exists requests_delete on public.time_off_requests;
create policy requests_delete on public.time_off_requests
  for delete to :"authenticated_role"
  using (user_id = (select timeoff.uid()) or (select timeoff.is_admin()));

-- A second, independent check on both tables: whatever the permissive
-- policies above say, a request without a verified subject is rejected with
-- 401. It keeps the tables closed even if a too-broad policy is added later.
-- The (select ...) form makes Postgres run the check once per statement, before
-- reading any rows, so an empty table rejects the request too.
drop policy if exists types_require_identity on public.time_off_types;
create policy types_require_identity on public.time_off_types
  as restrictive for all to :"authenticated_role"
  using ((select timeoff.require_identity()))
  with check ((select timeoff.require_identity()));

drop policy if exists requests_require_identity on public.time_off_requests;
create policy requests_require_identity on public.time_off_requests
  as restrictive for all to :"authenticated_role"
  using ((select timeoff.require_identity()))
  with check ((select timeoff.require_identity()));

-- ---------------------------------------------------------------------------
-- RPC: what does the database see for the current request?
-- ---------------------------------------------------------------------------

create or replace function public.whoami() returns jsonb
language sql stable
as $$
  select jsonb_build_object(
    'role',     current_user,
    'uid',      timeoff.uid(),
    'email',    timeoff.email(),
    'is_admin', timeoff.is_admin(),
    'claims',   timeoff.claims()
  )
  where timeoff.require_identity()
$$;

-- ---------------------------------------------------------------------------
-- Function privileges
--
-- Postgres lets everyone (PUBLIC) execute a new function. Take that away and
-- grant explicitly: the signed-in role may call everything; the anonymous role
-- only the pre-request hook and the two claim readers it uses. They return
-- nothing but the caller's own token claims. The revokes also undo grants from
-- earlier runs.
-- ---------------------------------------------------------------------------

revoke execute on all functions in schema timeoff from PUBLIC, :"anon_role";
revoke execute on function public.whoami() from PUBLIC, :"anon_role";

grant execute on all functions in schema timeoff to :"authenticated_role";
grant execute on function public.whoami() to :"authenticated_role";
grant execute on function timeoff.pre_request(), timeoff.uid(), timeoff.claims() to :"anon_role";
