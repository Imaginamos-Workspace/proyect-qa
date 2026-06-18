import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';

export type RegressionSuite = 'e2e' | 'perf' | 'security' | 'mobile-android' | 'both';

export interface RegressionRun {
  id: number;
  status: string | null; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | null
  event: string;
  url: string;
  created_at: string;
  display_title: string;
}

export interface RunRegressionResult {
  ok: true;
  suite: RegressionSuite;
  actions_url: string;
}

/** Dispara la regresión de un cliente (workflow_dispatch en el monorepo). */
export function useRunRegression(slug: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (suite: RegressionSuite) =>
      api.post<RunRegressionResult>(`/regression/${slug}/run`, { suite }),
    onSuccess: () => {
      // Dale a Actions un momento para registrar la corrida, luego refrescá.
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['regression', 'runs'] });
      }, 2500);
    },
  });
}

/**
 * Dispara el escaneo del sitio del cliente para auto-generar el universo de módulos
 * (modules-scrape.yml). `url` opcional sobrescribe el BASE_URL del .env.
 */
export function useScrapeModules(slug: string) {
  return useMutation({
    mutationFn: (opts?: { url?: string; force?: boolean }) =>
      api.post<RunRegressionResult>(`/regression/${slug}/scrape-modules`, opts ?? {}),
  });
}

/**
 * Dispara la construcción del universo a partir de los repos del cliente
 * (modules-from-repos.yml): la IA infiere los módulos del backend/frontend.
 */
export function useBuildFromRepos(slug: string) {
  return useMutation({
    mutationFn: (repos: { backend_repo?: string; frontend_repo?: string }) =>
      api.post<RunRegressionResult>(`/regression/${slug}/build-from-repos`, repos),
  });
}

/** Últimas corridas del workflow, para mostrar estado/enlace en el widget. */
export function useRegressionRuns(enabled = true) {
  return useQuery({
    queryKey: ['regression', 'runs'],
    queryFn: () => api.get<RegressionRun[]>('/regression/runs?limit=5'),
    enabled,
    // Mientras haya una corrida en curso, refrescá cada 15s.
    refetchInterval: (query) => {
      const runs = query.state.data;
      const running = runs?.some((r) => r.status !== 'completed');
      return running ? 15_000 : false;
    },
  });
}
