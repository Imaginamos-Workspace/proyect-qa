# Login con GitHub — guía de configuración

El código del frontend ya soporta **"Continuar con GitHub"** (Supabase OAuth) y
restringe el acceso a los **miembros del org `fridaKhalo`**. Falta la
configuración con secretos, que se hace una sola vez. Pasos:

## 1. Crear el OAuth App en GitHub

1. Ir a **GitHub → Settings del org `fridaKhalo` → Developer settings →
   OAuth Apps → New OAuth App**
   (o a https://github.com/organizations/fridaKhalo/settings/applications).
2. Rellenar:
   - **Application name:** `QA Platform`
   - **Homepage URL:** la URL del frontend en Vercel
     (p. ej. `https://qa-frontend-xxxx.vercel.app`).
   - **Authorization callback URL:** la **callback de Supabase**, no la del front:
     ```
     https://tsnqqmsrydsfuaezkfkr.supabase.co/auth/v1/callback
     ```
3. **Generate a new client secret.** Anota **Client ID** y **Client Secret**.

> El `tsnqqmsrydsfuaezkfkr` es el ref del proyecto Supabase (ver `CLAUDE.md`).

## 2. Habilitar el provider GitHub en Supabase

**Dashboard → Authentication → Providers → GitHub:**

1. Activar **Enable Sign in with GitHub**.
2. Pegar **Client ID** y **Client Secret** del paso 1.
3. Guardar.

**Authentication → URL Configuration:**

- **Site URL:** la URL del frontend en producción.
- **Redirect URLs:** agregar (uno por línea):
  ```
  http://localhost:5173/login
  https://<tu-dominio-vercel>/login
  ```
  (el código redirige a `/login` tras el OAuth; el gate de org corre ahí y
  manda al dashboard.)

### Alternativa por API (sin dashboard)

Si tienes un **Personal Access Token** de Supabase (`sbp_...`):

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

## 3. Variables de entorno del frontend

En Vercel (proyecto `qa-frontend`) y en tu `.env` local:

```
VITE_SUPABASE_URL=https://tsnqqmsrydsfuaezkfkr.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
VITE_GITHUB_ORG=fridaKhalo
```

## 4. Que los QA sean miembros del org

El gate solo deja entrar a miembros **activos** del org `fridaKhalo`. Asegúrate
de que cada QA esté invitado y haya **aceptado** la invitación al org. Si su
membresía es privada, igual funciona porque pedimos el scope `read:org`.

## Cómo funciona el gate (resumen técnico)

- `signInWithGitHub()` pide el scope `read:org` y redirige a GitHub.
- Al volver, Supabase crea la sesión con un `provider_token` (token de GitHub).
- `auth.store` llama a `GET https://api.github.com/user/memberships/orgs/fridaKhalo`
  con ese token. Si el estado es `active` → entra; si no → se cierra la sesión
  y se muestra "tu cuenta no pertenece al equipo".
- El login por **email/contraseña** sigue disponible para cuentas internas.

## Endurecimiento futuro (recomendado)

El gate actual es del lado del cliente (buena primera línea + UX). El acceso
real a datos lo protege la API NestJS + RLS de Supabase. Para forzar la regla
del lado del servidor: un **Auth Hook** de Supabase (`before user created` /
custom claims) o validar la membresía del org en el backend al emitir el JWT.
