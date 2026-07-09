import { supabase } from './supabase';

// Trim whitespace/newlines and strip trailing slashes — env vars can have
// stray \n appended by Vercel when saved with quotes
const API_URL = (import.meta.env.VITE_API_URL || '/api').trim().replace(/\/+$/, '');

// getSession() puede COLGARSE en móvil: al volver del background con el token
// vencido, el refresh de supabase-js se queda esperando indefinidamente
// (deadlock conocido). Como este await corre ANTES del fetch, el AbortSignal
// del request nunca llegaba a existir y la UI quedaba en "Pensando…" infinito
// (caso real: 121s y contando). Tope propio → error legible y reintentable.
const SESSION_READ_TIMEOUT_MS = 8_000;

async function getAuthHeaders(): Promise<Record<string, string>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const sessionTimeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error('No se pudo renovar la sesión (conexión inestable). Intenta de nuevo o recarga la página.')),
      SESSION_READ_TIMEOUT_MS,
    );
  });
  try {
    const { data } = await Promise.race([supabase.auth.getSession(), sessionTimeout]);
    const token = data.session?.access_token;
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
