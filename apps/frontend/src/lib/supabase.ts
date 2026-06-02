import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

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
