import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface CoverageModule {
  name: string;
  total: number;
  passed: number;
}

export interface QaRun {
  id: string;
  client_slug: string;
  suite: string;
  commit_sha: string | null;
  branch: string | null;
  actor_login: string | null;
  status: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  duration_ms: number | null;
  coverage: { specs_total?: number; specs_covered?: number; modules?: CoverageModule[] };
  report_url: string | null;
  gh_run_url: string | null;
  started_at: string | null;
  created_at: string;
}

export interface Regression {
  id: string;
  run_id: string;
  client_slug: string;
  test_id: string | null;
  title: string;
  file: string | null;
  kind: 'new_fail' | 'fixed' | 'flaky';
  created_at: string;
}

export interface UniverseModule {
  name: string;
  epics?: string[];
  stories_total: number;
  automated: number;
  status: 'pending' | 'partial' | 'covered';
}

export interface Universe {
  total_modules: number;
  covered_modules: number;
  pct: number;
  total_stories: number;
  automated_stories: number;
  modules: UniverseModule[];
  updated_at?: string;
}

export interface Inventory {
  specs_total?: number;
  tests_total?: number;
  modules?: { name: string; tests: number }[];
  universe?: Universe;
  updated_at?: string;
}

export interface ClientSummary {
  slug: string;
  display_name: string;
  reports_url: string | null;
  designs_url: string | null;
  enabled: boolean;
  inventory: Inventory;
  latest_run: QaRun | null;
  pass_rate: number;
  coverage_pct: number;
  open_regressions: number;
}

export interface ClientDetail extends ClientSummary {
  runs: QaRun[];
  regressions: Regression[];
}

export interface Activity {
  id: string;
  actor_login: string;
  kind: 'test' | 'design' | 'bug' | 'commit' | 'run';
  client_slug: string | null;
  title: string;
  url: string | null;
  ts: string;
  meta: Record<string, unknown>;
}

export interface Person {
  actor_login: string;
  total: number;
  by_kind: Record<string, number>;
  last_active: string;
}

export function useClients() {
  return useQuery({
    queryKey: ['dashboard', 'clients'],
    queryFn: () => api.get<ClientSummary[]>('/dashboard/clients'),
  });
}

export function useClient(slug: string) {
  return useQuery({
    queryKey: ['dashboard', 'clients', slug],
    queryFn: () => api.get<ClientDetail>(`/dashboard/clients/${slug}`),
    enabled: !!slug,
  });
}

export function useActivity(filters: { actor?: string; client?: string; limit?: number } = {}) {
  const params = new URLSearchParams();
  if (filters.actor) params.set('actor', filters.actor);
  if (filters.client) params.set('client', filters.client);
  if (filters.limit) params.set('limit', String(filters.limit));
  const qs = params.toString();
  return useQuery({
    queryKey: ['dashboard', 'activity', filters],
    queryFn: () => api.get<Activity[]>(`/dashboard/activity${qs ? `?${qs}` : ''}`),
  });
}

export function usePeople() {
  return useQuery({
    queryKey: ['dashboard', 'people'],
    queryFn: () => api.get<Person[]>('/dashboard/people'),
  });
}
