import { create } from 'zustand';
import { supabase } from '@/lib/supabase';
import type { User, Session } from '@supabase/supabase-js';

interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
  /** Código de error de acceso para que la UI lo traduzca (p.ej. 'not_allowed'). */
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
 * Gate de acceso. Las cuentas de email/contraseña son internas (creadas a mano
 * en Supabase) y se permiten. Las de GitHub deben estar en la lista blanca:
 * lo decide la función `is_current_user_allowed()` en Postgres, que lee el
 * username del propio JWT (no se puede falsear desde el cliente) y no expone la
 * lista completa.
 */
async function gateSession(
  session: Session,
): Promise<{ user: User | null; authError: string | null }> {
  if (!isGitHubSession(session)) {
    return { user: session.user, authError: null };
  }
  const { data, error } = await supabase.rpc('is_current_user_allowed');
  if (error || data !== true) {
    await supabase.auth.signOut();
    return { user: null, authError: 'not_allowed' };
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
      const { user, authError } = await gateSession(session);
      set({ session: user ? session : null, user, authError, loading: false });
    } else {
      set({ session: null, user: null, loading: false });
    }

    supabase.auth.onAuthStateChange(async (_event, nextSession) => {
      if (nextSession) {
        const { user, authError } = await gateSession(nextSession);
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
