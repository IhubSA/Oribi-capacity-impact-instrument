-- ============================================================
-- CSO Capacity & Impact Instrument — schema
-- Applied to Supabase project: ziladpnlfajtiboavwvn ("IhubSA's Project")
-- Namespaced with cso_ prefix to avoid clashing with other apps
-- already living in that project.
-- ============================================================

create table if not exists public.cso_organisations (
  id text primary key,
  name text not null,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.cso_organisations is
  'One row per CSO. data holds the full assessment state (basic info, capacity domains, M&E entries) as JSON.';

alter table public.cso_organisations enable row level security;

-- Simple trust model for now (mirrors the previous shared-storage behaviour):
-- anyone holding the public anon key can read/write organisation records.
-- This is intentionally permissive to keep the app simple; tighten with real
-- per-user auth later if/when needed.
drop policy if exists "cso_organisations_select_all" on public.cso_organisations;
create policy "cso_organisations_select_all" on public.cso_organisations
  for select to anon, authenticated using (true);

drop policy if exists "cso_organisations_insert_all" on public.cso_organisations;
create policy "cso_organisations_insert_all" on public.cso_organisations
  for insert to anon, authenticated with check (true);

drop policy if exists "cso_organisations_update_all" on public.cso_organisations;
create policy "cso_organisations_update_all" on public.cso_organisations
  for update to anon, authenticated using (true) with check (true);

drop policy if exists "cso_organisations_delete_all" on public.cso_organisations;
create policy "cso_organisations_delete_all" on public.cso_organisations
  for delete to anon, authenticated using (true);

-- Keep updated_at fresh on every write, server-side.
create or replace function public.cso_touch_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists cso_organisations_touch on public.cso_organisations;
create trigger cso_organisations_touch
  before update on public.cso_organisations
  for each row execute function public.cso_touch_updated_at();

-- ------------------------------------------------------------
-- Admin password, kept server-side. The client calls the RPC
-- below instead of ever reading the password value directly.
-- ------------------------------------------------------------
create table if not exists public.cso_admin_config (
  id int primary key default 1,
  password text not null,
  constraint cso_admin_config_singleton check (id = 1)
);

alter table public.cso_admin_config enable row level security;
-- No policies granted to anon/authenticated: the table itself is unreadable
-- from the client. Only the SECURITY DEFINER function below can see it.

insert into public.cso_admin_config (id, password)
values (1, 'reach-admin-2026')
on conflict (id) do nothing;

create or replace function public.cso_verify_admin_password(pw text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists(select 1 from public.cso_admin_config where password = pw);
$$;

revoke all on function public.cso_verify_admin_password(text) from public;
grant execute on function public.cso_verify_admin_password(text) to anon, authenticated;

-- ------------------------------------------------------------
-- To change the admin password later, run:
--   update public.cso_admin_config set password = 'your-new-password' where id = 1;
-- ------------------------------------------------------------
