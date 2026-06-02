// Tipos del portal QA: ingesta de corridas desde el monorepo + lecturas de dashboard.

export type RegressionKind = 'new_fail' | 'fixed' | 'flaky';
export type ActivityKind = 'test' | 'design' | 'bug' | 'commit' | 'run';

export interface CoverageModule {
  name: string;
  total: number;
  passed: number;
}

export interface RunCoverage {
  specs_total: number;
  specs_covered: number;
  modules: CoverageModule[];
}

/** Una prueba individual reportada por el CI (para diffear regresiones). */
export interface IngestTest {
  test_id?: string;
  title: string;
  file?: string;
  status: 'passed' | 'failed' | 'skipped' | 'flaky';
}

/** Payload que el CI del monorepo envía a POST /api/ingest/runs. */
export interface IngestRunPayload {
  client_slug: string;
  client_name?: string;
  reports_url?: string;
  designs_url?: string;
  suite?: string;
  commit_sha?: string;
  branch?: string;
  actor_login?: string;
  status?: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky?: number;
  duration_ms?: number;
  coverage?: RunCoverage;
  report_url?: string;
  gh_run_url?: string;
  started_at?: string;
  tests?: IngestTest[];
}

/** Payload para POST /api/ingest/activity (p.ej. actividad de diseñadores). */
export interface IngestActivityPayload {
  actor_login: string;
  kind: ActivityKind;
  client_slug?: string;
  title: string;
  url?: string;
  ts?: string;
  meta?: Record<string, unknown>;
}
