-- 015_create_qa_portal.sql
-- Tablas del portal QA: ingesta de resúmenes de corridas del monorepo
-- (qa-automation-monorepo), cobertura, regresiones y actividad por persona.
-- Decopladas de auth.users a propósito: los QAs y diseñadores se identifican
-- por su login de GitHub, no por una cuenta Supabase.

create table if not exists public.qa_clients (
  slug text primary key,
  display_name text not null,
  reports_url text,
  designs_url text,
  enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create table if not exists public.qa_runs (
  id uuid primary key default gen_random_uuid(),
  client_slug text not null references public.qa_clients(slug) on delete cascade,
  suite text not null default 'e2e',
  commit_sha text,
  branch text,
  actor_login text,
  status text not null default 'completed',
  total int not null default 0,
  passed int not null default 0,
  failed int not null default 0,
  skipped int not null default 0,
  flaky int not null default 0,
  duration_ms bigint,
  -- { specs_total, specs_covered, modules: [{name,total,passed}] }
  coverage jsonb not null default '{}'::jsonb,
  -- Lista de identificadores de pruebas que fallaron en esta corrida.
  -- Se usa para diffear regresiones contra la corrida previa.
  failing_tests jsonb not null default '[]'::jsonb,
  report_url text,
  gh_run_url text,
  started_at timestamptz,
  created_at timestamptz not null default now(),
  -- Idempotencia / reproducibilidad: una corrida por (cliente, commit, suite).
  unique (client_slug, commit_sha, suite)
);
create index if not exists idx_qa_runs_client on public.qa_runs(client_slug, created_at desc);

create table if not exists public.qa_regressions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.qa_runs(id) on delete cascade,
  client_slug text not null references public.qa_clients(slug) on delete cascade,
  test_id text,
  title text not null,
  file text,
  kind text not null check (kind in ('new_fail', 'fixed', 'flaky')),
  created_at timestamptz not null default now()
);
create index if not exists idx_qa_regressions_run on public.qa_regressions(run_id);
create index if not exists idx_qa_regressions_client on public.qa_regressions(client_slug, created_at desc);

create table if not exists public.qa_activity (
  id uuid primary key default gen_random_uuid(),
  actor_login text not null,
  kind text not null check (kind in ('test', 'design', 'bug', 'commit', 'run')),
  client_slug text references public.qa_clients(slug) on delete set null,
  title text not null,
  url text,
  ts timestamptz not null default now(),
  meta jsonb not null default '{}'::jsonb
);
create index if not exists idx_qa_activity_ts on public.qa_activity(ts desc);
create index if not exists idx_qa_activity_actor on public.qa_activity(actor_login, ts desc);
create index if not exists idx_qa_activity_client on public.qa_activity(client_slug, ts desc);

-- RLS: cualquier miembro logueado (lista blanca de github) ve todo el panel.
-- Las escrituras las hace el backend con service_role, que ignora RLS.
alter table public.qa_clients enable row level security;
alter table public.qa_runs enable row level security;
alter table public.qa_regressions enable row level security;
alter table public.qa_activity enable row level security;

create policy "qa_clients read" on public.qa_clients for select to authenticated using (true);
create policy "qa_runs read" on public.qa_runs for select to authenticated using (true);
create policy "qa_regressions read" on public.qa_regressions for select to authenticated using (true);
create policy "qa_activity read" on public.qa_activity for select to authenticated using (true);
