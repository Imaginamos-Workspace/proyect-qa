/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_SUPABASE_URL: string;
  readonly VITE_SUPABASE_ANON_KEY: string;
  /** Org de GitHub cuyos miembros pueden acceder. Default: fridaKhalo. */
  readonly VITE_GITHUB_ORG?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
