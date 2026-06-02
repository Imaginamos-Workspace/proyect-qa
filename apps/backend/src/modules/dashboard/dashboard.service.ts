import { Inject, Injectable } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../config/supabase.module';

interface ActivityFilters {
  actor?: string;
  client?: string;
  limit?: number;
}

function passRate(run: { passed?: number; total?: number } | null): number {
  if (!run || !run.total) return 0;
  return Math.round(((run.passed ?? 0) / run.total) * 100);
}

function coveragePct(run: { coverage?: any } | null): number {
  const c = run?.coverage;
  if (!c || !c.specs_total) return 0;
  return Math.round(((c.specs_covered ?? 0) / c.specs_total) * 100);
}

@Injectable()
export class DashboardService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  /** Resumen por cliente: última corrida, pass-rate, cobertura, regresiones abiertas. */
  async getClients() {
    const { data: clients, error } = await this.supabase
      .from('qa_clients')
      .select('*')
      .eq('enabled', true)
      .order('display_name');
    if (error) throw error;

    const result = [];
    for (const client of clients ?? []) {
      const { data: latest } = await this.supabase
        .from('qa_runs')
        .select('*')
        .eq('client_slug', client.slug)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      let openRegressions = 0;
      if (latest) {
        const { count } = await this.supabase
          .from('qa_regressions')
          .select('id', { count: 'exact', head: true })
          .eq('run_id', latest.id)
          .eq('kind', 'new_fail');
        openRegressions = count ?? 0;
      }

      result.push({
        ...client,
        latest_run: latest ?? null,
        pass_rate: passRate(latest),
        coverage_pct: coveragePct(latest),
        open_regressions: openRegressions,
      });
    }
    return result;
  }

  /** Detalle de un cliente: serie de corridas + regresiones de la última. */
  async getClient(slug: string) {
    const { data: client, error } = await this.supabase
      .from('qa_clients')
      .select('*')
      .eq('slug', slug)
      .maybeSingle();
    if (error) throw error;
    if (!client) return null;

    const { data: runs } = await this.supabase
      .from('qa_runs')
      .select('*')
      .eq('client_slug', slug)
      .order('created_at', { ascending: false })
      .limit(30);

    const latest = runs?.[0] ?? null;
    let regressions: any[] = [];
    if (latest) {
      const { data } = await this.supabase
        .from('qa_regressions')
        .select('*')
        .eq('run_id', latest.id)
        .order('kind');
      regressions = data ?? [];
    }

    return {
      ...client,
      runs: (runs ?? []).slice().reverse(), // ascendente para el gráfico
      latest_run: latest,
      pass_rate: passRate(latest),
      coverage_pct: coveragePct(latest),
      regressions,
    };
  }

  /** Feed de actividad (QAs + diseñadores), opcionalmente filtrado. */
  async getActivity(filters: ActivityFilters) {
    let query = this.supabase
      .from('qa_activity')
      .select('*')
      .order('ts', { ascending: false })
      .limit(Math.min(filters.limit ?? 50, 200));
    if (filters.actor) query = query.eq('actor_login', filters.actor);
    if (filters.client) query = query.eq('client_slug', filters.client);
    const { data, error } = await query;
    if (error) throw error;
    return data ?? [];
  }

  /** Rollup por persona (actor_login): conteo por tipo de actividad. */
  async getPeople() {
    const { data, error } = await this.supabase
      .from('qa_activity')
      .select('actor_login, kind, ts')
      .order('ts', { ascending: false })
      .limit(2000);
    if (error) throw error;

    type PersonRollup = {
      actor_login: string;
      total: number;
      by_kind: Record<string, number>;
      last_active: string;
    };
    const map = new Map<string, PersonRollup>();
    for (const row of data ?? []) {
      const entry: PersonRollup =
        map.get(row.actor_login) ??
        { actor_login: row.actor_login, total: 0, by_kind: {}, last_active: row.ts };
      entry.total += 1;
      entry.by_kind[row.kind] = (entry.by_kind[row.kind] ?? 0) + 1;
      if (row.ts > entry.last_active) entry.last_active = row.ts;
      map.set(row.actor_login, entry);
    }
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }
}
