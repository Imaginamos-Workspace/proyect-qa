-- Suma a los vendedores Dianny González y Janier Muñoz a la whitelist de login
-- por GitHub. Ya están en la org GitHub imaginamos (equipo vendedor); su rol
-- (solo Ventas) sale de team.json del monorepo. Esta migración deja el alta
-- versionada y reproducible; en producción se inserta también vía service_role.
insert into public.allowed_github_users (github_username, note) values
  ('diannygonzalez-sdr', 'vendedor'),
  ('janiermunoz-cyber', 'vendedor')
on conflict (github_username) do nothing;
