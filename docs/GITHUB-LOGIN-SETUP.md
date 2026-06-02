# Login con GitHub — configuración

El frontend soporta **"Continuar con GitHub"** (Supabase OAuth) y restringe el
acceso con una **lista blanca de usernames de GitHub** (tabla en Supabase). El
login por email/contraseña sigue disponible para cuentas internas.

> Se usa lista blanca y no "membresía de org" porque `fridaKhalo` es una cuenta
> personal de GitHub, no una organización.

## Estado (lo ya hecho automáticamente)

- ✅ Tabla `public.allowed_github_users` + función `is_current_user_allowed()`
  (migración `014`). La función lee el username del JWT y responde sí/no sin
  exponer la lista.
- ✅ Sembrada con el equipo: `fridaKhalo`, `Juan06209`, `AbyteQuantic`,
  `AndresPuyol`, `JohanaMallama2`, `brayan-murcia-imaginamos`.
- ✅ Redirect URLs de desarrollo en Supabase (`localhost:5173`, `localhost:3000`).
- ✅ Código del frontend (botón GitHub + gate por lista blanca).

## Falta (necesita el OAuth App de GitHub)

### 1. Crear el OAuth App

En **https://github.com/settings/developers → OAuth Apps → New OAuth App**
(NO en `/settings/installations`, esa es otra cosa):

- **Application name:** `QA Platform`
- **Homepage URL:** la URL del frontend en Vercel
- **Authorization callback URL** (la de Supabase):
  ```
  https://tsnqqmsrydsfuaezkfkr.supabase.co/auth/v1/callback
  ```
- "Generate a new client secret" → guarda **Client ID** y **Client Secret**.

### 2. Habilitar el provider en Supabase

Con el Client ID/Secret, vía Management API:

```bash
curl -X PATCH "https://api.supabase.com/v1/projects/tsnqqmsrydsfuaezkfkr/config/auth" \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "external_github_enabled": true,
    "external_github_client_id": "<CLIENT_ID>",
    "external_github_secret": "<CLIENT_SECRET>"
  }'
```

(O en el dashboard: Authentication → Providers → GitHub.)

### 3. Site URL / Redirect de producción

Cuando exista el dominio de Vercel, agregarlo:

```bash
curl -X PATCH ".../config/auth" -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"site_url":"https://<dominio-vercel>","uri_allow_list":"http://localhost:5173/**,https://<dominio-vercel>/**"}'
```

## Gestionar la lista blanca

```sql
-- agregar
insert into public.allowed_github_users (github_username, note)
values ('nuevo-username', 'qa') on conflict do nothing;
-- quitar
delete from public.allowed_github_users where github_username = 'username';
```

## Cómo funciona el gate

- `signInWithGitHub()` redirige a GitHub; al volver, Supabase crea la sesión.
- `auth.store` llama a `is_current_user_allowed()`. Si el username del JWT está
  en la lista → entra; si no → cierra sesión y muestra "no autorizada".
- Email/contraseña: pasa directo (cuentas internas).

## Endurecimiento futuro

El gate corre en el cliente (primera línea + UX); el acceso real a datos lo
protege la API NestJS + RLS de Supabase. Para forzarlo del lado servidor:
validar `is_current_user_allowed()` también en el backend al recibir el JWT.
