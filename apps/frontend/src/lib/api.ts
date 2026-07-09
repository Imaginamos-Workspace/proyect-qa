import { supabase } from './supabase';

// Trim whitespace/newlines and strip trailing slashes — env vars can have
// stray \n appended by Vercel when saved with quotes
const API_URL = (import.meta.env.VITE_API_URL || '/api').trim().replace(/\/+$/, '');

// getSession() puede COLGARSE: al volver del background con el token vencido
// el refresh se queda esperando (deadlock conocido), y con varias pestañas
// abiertas el navigator.lock de supabase-js deja a las demás en cola — con
// buena conexión igual (caso real: el panel quedaba en bucle con "No se pudo
// renovar la sesión"). Tope corto + FALLBACK al token cacheado en
// localStorage, que no necesita el candado: si aún no venció, se usa directo.
const SESSION_READ_TIMEOUT_MS = 4_000;

/** Token de acceso cacheado por supabase-js (sb-<ref>-auth-token). Se usa tal
 *  cual si le quedan >30s de vida — el backend lo valida igual. */
function cachedAccessToken(): string | null {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key || !/^sb-.*-auth-token$/.test(key)) continue;
      const raw = localStorage.getItem(key);
      if (!raw) continue;
      const parsed = JSON.parse(raw) as { access_token?: string; expires_at?: number };
      if (parsed.access_token && (!parsed.expires_at || parsed.expires_at * 1000 - Date.now() > 30_000)) {
        return parsed.access_token;
      }
    }
  } catch {
    // localStorage inaccesible o shape inesperado → sin fallback
  }
  return null;
}

async function getAuthHeaders(): Promise<Record<string, string>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sessionTimeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), SESSION_READ_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([supabase.auth.getSession(), sessionTimeout]);
    const token = result?.data.session?.access_token ?? cachedAccessToken();
    if (!token && result === null) {
      // Ni getSession respondió ni hay token vigente en caché → la sesión
      // murió de verdad; reintentarlo no la revive.
      throw new Error('Tu sesión expiró. Recarga la página y, si sigue igual, cierra sesión y vuelve a entrar.');
    }
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function request<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const headers = await getAuthHeaders();
  // Timeout duro: sin esto un fetch colgado deja la UI en "cargando" infinito
  // (skeletons eternos). 20s cubre cold-starts de Vercel.
  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      ...options,
      headers: { ...headers, ...options.headers },
      signal: options.signal ?? AbortSignal.timeout(20_000),
    });
  } catch (err) {
    // El abort del timeout llega como DOMException "signal timed out" — eso no
    // le dice nada al usuario. Mensaje accionable; el flujo de "Reintentar" del
    // chat ya guarda el texto para reenviar.
    const name = (err as Error).name;
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new Error('La solicitud tardó demasiado y se canceló. Intenta de nuevo en un momento.');
    }
    throw err;
  }

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: response.statusText }));
    throw new Error(error.message || `Request failed: ${response.status}`);
  }

  // Handle empty-body success responses (204, or 200 with no body — common for DELETE)
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined as T;
  }
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  // `timeoutMs` opcional — por defecto 20s, pero llamadas que disparan una
  // cascada de LLM (Gemini flash→pro→Groq→DeepSeek, cada uno con reintentos
  // y backoff) pueden legítimamente tardar más que eso sin estar colgadas.
  // El backend ya permite hasta 60s (vercel.json maxDuration) — sin esto, el
  // cliente aborta antes de que el backend siquiera termine de intentar.
  post: <T>(path: string, body?: unknown, timeoutMs?: number) =>
    request<T>(path, {
      method: 'POST',
      body: body ? JSON.stringify(body) : undefined,
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined }),
  delete: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};
