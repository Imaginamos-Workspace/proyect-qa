import { create } from 'zustand';
import { supabase, GITHUB_ORG } from '@/lib/supabase';
import type { User, Session } from '@supabase/supabase-js';

interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
  /** Código de error de acceso para que la UI lo traduzca (p.ej. 'not_org_member'). */
  authError: string | null;
  initialize: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signInWithGitHub: () => Promise<void>;
  signOut: () => Promise<void>;
  clearAuthError: () => void;
}

/** ¿La sesión proviene del proveedor GitHub? */
function isGitHubSession(session: Session): boolean {
  const meta = session.user.app_metadata ?? {};
  const providers = (meta.providers as string[] | undefined) ?? [];
  return meta.provider === 'github' || providers.includes('github');
}

/**
 * Verifica que el usuario pertenezca al org de GitHub usando el `provider_token`
 * de la sesión. Solo se puede comprobar justo después del OAuth, cuando el token
 * del proveedor está disponible (requiere el scope `read:org`).
 */
async function isGitHubOrgMember(providerToken: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://api.github.com/user/memberships/orgs/${GITHUB_ORG}`,
      {
        headers: {
          Authorization: `Bearer ${providerToken}`,
          Accept: 'application/vnd.github+json',
        },
      },
    );
    if (res.status === 200) {
      const data = (await res.json()) as { state?: string };
      return data.state === 'active';
    }
    // 404 = no es miembro · 403 = falta el scope read:org · otro = negar por seguridad.
    return false;
  } catch {
    return false;
  }
}

/**
 * Aplica el gate de org sobre una sesión de GitHub. Devuelve el usuario
 * autorizado o, si no pasa, cierra la sesión y reporta el motivo.
 *
 * El gate solo se ejecuta cuando hay `provider_token` (inmediatamente después
 * del OAuth). En recargas posteriores el token del proveedor ya no está, así
 * que se confía en la sesión que ya fue validada al iniciar sesión.
 */
async function gateGitHubSession(
  session: Session,
): Promise<{ user: User | null; authError: string | null }> {
  if (isGitHubSession(session) && session.provider_token) {
    const member = await isGitHubOrgMember(session.provider_token);
    if (!member) {
      await supabase.auth.signOut();
      return { user: null, authError: 'not_org_member' };
    }
  }
  return { user: session.user, authError: null };
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  session: null,
  loading: true,
  authError: null,

  initialize: async () => {
    const { data } = await supabase.auth.getSession();
    const session = data.session;

    if (session) {
      const { user, authError } = await gateGitHubSession(session);
      set({
        session: user ? session : null,
        user,
        authError,
        loading: false,
      });
    } else {
      set({ session: null, user: null, loading: false });
    }

    supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      if (nextSession) {
        const { user, authError } = await gateGitHubSession(nextSession);
        set({ session: user ? nextSession : null, user, authError });
      } else {
        // Al cerrar sesión, conserva un posible error de acceso ya fijado
        // (p.ej. el signOut que dispara el propio gate al rechazar a alguien).
        set((s) => ({ session: null, user: null, authError: s.authError }));
      }
    });
  },

  signIn: async (email, password) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  },

  signUp: async (email, password) => {
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
  },

  signInWithGitHub: async () => {
    set({ authError: null });
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'github',
      options: {
        // `read:org` permite verificar la membresía del org tras el login.
        scopes: 'read:org',
        // Vuelve a /login; initialize() corre el gate y redirige al dashboard.
        redirectTo: `${window.location.origin}/login`,
      },
    });
    if (error) throw error;
  },

  signOut: async () => {
    await supabase.auth.signOut();
    set({ user: null, session: null, authError: null });
  },

  clearAuthError: () => set({ authError: null }),
}));
