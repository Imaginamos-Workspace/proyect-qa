-- 014_create_allowed_github_users.sql
-- Lista blanca de usernames de GitHub autorizados a entrar a la plataforma.
-- El gate del frontend (auth.store) llama a is_current_user_allowed() tras el
-- login con GitHub. Las cuentas de email/contraseña (internas) no se filtran.

create table if not exists public.allowed_github_users (
  github_username text primary key,
  note text,
  created_at timestamptz not null default now()
);

alter table public.allowed_github_users enable row level security;
-- Sin policies a propósito: solo el service_role accede directo a la tabla.
-- Los clientes consultan únicamente vía la función de abajo (SECURITY DEFINER),
-- que NO expone la lista completa, solo responde sí/no para el usuario actual.

create or replace function public.is_current_user_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select
    -- Cuentas de email/contraseña (internas) siempre permitidas.
    coalesce(auth.jwt() -> 'app_metadata' ->> 'provider', '') <> 'github'
    or exists (
      select 1
      from public.allowed_github_users a
      where lower(a.github_username) = lower(auth.jwt() -> 'user_metadata' ->> 'user_name')
    );
$$;

grant execute on function public.is_current_user_allowed() to authenticated;

-- Semilla: equipo actual (colaboradores del monorepo qa-automation-monorepo).
insert into public.allowed_github_users (github_username, note) values
  ('fridaKhalo', 'owner'),
  ('Juan06209', 'qa'),
  ('AbyteQuantic', 'tl'),
  ('AndresPuyol', 'qa'),
  ('JohanaMallama2', 'qa'),
  ('brayan-murcia-imaginamos', 'qa')
on conflict (github_username) do nothing;
