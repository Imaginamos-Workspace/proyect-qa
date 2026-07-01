-- Suma a saraalvarez-byte (PM) a la whitelist de login por GitHub.
-- Ya insertado a mano en producción (2026-07-01) vía REST con service_role;
-- esta migración deja el alta versionada y reproducible en otros entornos.
insert into public.allowed_github_users (github_username, note) values
  ('saraalvarez-byte', 'pm')
on conflict (github_username) do nothing;
