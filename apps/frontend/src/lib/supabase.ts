import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/**
 * Org de GitHub cuyos miembros pueden entrar a las partes privadas.
 * Configurable con VITE_GITHUB_ORG; por defecto el org de la agencia.
 */
export const GITHUB_ORG = import.meta.env.VITE_GITHUB_ORG ?? 'fridaKhalo';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // PKCE: flujo recomendado para SPAs en el OAuth de GitHub.
    flowType: 'pkce',
    persistSession: true,
    autoRefreshToken: true,
    // Procesa el ?code=... del redirect de OAuth automáticamente.
    detectSessionInUrl: true,
  },
});
