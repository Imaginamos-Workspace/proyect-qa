// Identidad de GitHub del usuario autenticado, a prueba de suplantación.
//
// CRÍTICO: NO leer el login de `user_metadata` — ese campo lo puede editar el
// PROPIO usuario desde el cliente (`supabase.auth.updateUser({ data: {...} })`),
// así que un autenticado cualquiera podía ponerse `user_name: '<vendedor>'` y
// heredar su rol + la propiedad de sus oportunidades/prospectos/notificaciones.
// `identities[].identity_data` lo llena GoTrue en el login OAuth y NO es
// mutable desde el cliente — es la fuente correcta para autorización.

interface SupabaseIdentity {
  provider?: string;
  identity_data?: Record<string, unknown> | null;
}

export interface AuthedUser {
  email?: string | null;
  identities?: SupabaseIdentity[] | null;
  // Fallback SOLO para cuentas legacy sin `identities` poblado (no GitHub).
  user_metadata?: Record<string, unknown> | null;
}

/** Login de GitHub del solicitante, o null. Lee de la identidad OAuth
 *  (no falsificable); cae a user_metadata solo si no hay identidad GitHub. */
export function githubLoginOf(user: AuthedUser | undefined | null): string | null {
  const gh = (user?.identities ?? []).find((i) => i.provider === 'github')?.identity_data ?? null;
  const pick = (src: Record<string, unknown> | null | undefined) =>
    (src?.user_name as string) || (src?.preferred_username as string) || (src?.nickname as string) || null;
  return pick(gh) ?? (gh ? null : pick(user?.user_metadata));
}

export function emailOf(user: AuthedUser | undefined | null): string | null {
  return user?.email ?? null;
}
