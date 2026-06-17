import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../config/supabase.module';
import { IngestRunDto, IngestActivityDto, IngestUniverseDto } from './dto/ingest-run.dto';

interface FailingTest {
  key: string;
  title: string;
  file?: string;
}

/** Identificador estable de una prueba para diffear entre corridas. */
function testKey(t: { test_id?: string; file?: string; title: string }): string {
  return t.test_id || `${t.file ?? ''}::${t.title}`;
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
  ) {}

  async ingestRun(dto: IngestRunDto) {
    const suite = dto.suite || 'e2e';

    // 1. Upsert del cliente (slug + links de reportes/diseños + inventario).
    // El inventario (pruebas ESCRITAS) se deriva de la corrida — specs del repo
    // y tests de la suite — así el "estado de construcción de la regresión" se
    // actualiza solo con cada corrida (qa:apply local o CI), sin cargas manuales.
    const inventory = {
      specs_total: dto.coverage?.specs_total ?? 0,
      tests_total: (dto.tests ?? []).length,
      modules: (dto.coverage?.modules ?? []).map((m) => ({ name: m.name, tests: m.total })),
      updated_at: new Date().toISOString(),
    };
    await this.supabase.from('qa_clients').upsert(
      {
        slug: dto.client_slug,
        display_name: dto.client_name || dto.client_slug,
        reports_url: dto.reports_url ?? null,
        designs_url: dto.designs_url ?? null,
        enabled: true,
        ...(inventory.tests_total || inventory.specs_total ? { inventory } : {}),
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'slug' },
    );

    // 2. Corrida previa (distinto commit) para diffear regresiones.
    const { data: prevRun } = await this.supabase
      .from('qa_runs')
      .select('failing_tests, commit_sha')
      .eq('client_slug', dto.client_slug)
      .eq('suite', suite)
      .neq('commit_sha', dto.commit_sha ?? '')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    // 3. Fallos de esta corrida.
    const tests = dto.tests ?? [];
    const currentFailing: FailingTest[] = tests
      .filter((t) => t.status === 'failed')
      .map((t) => ({ key: testKey(t), title: t.title, file: t.file }));

    // 4. Upsert de la corrida (idempotente por cliente+commit+suite).
    const { data: run, error: runError } = await this.supabase
      .from('qa_runs')
      .upsert(
        {
          client_slug: dto.client_slug,
          suite,
          commit_sha: dto.commit_sha ?? null,
          branch: dto.branch ?? null,
          actor_login: dto.actor_login ?? null,
          status: dto.status || 'completed',
          total: dto.total,
          passed: dto.passed,
          failed: dto.failed,
          skipped: dto.skipped,
          flaky: dto.flaky ?? 0,
          duration_ms: dto.duration_ms ?? null,
          coverage: dto.coverage ?? {},
          failing_tests: currentFailing,
          report_url: dto.report_url ?? null,
          gh_run_url: dto.gh_run_url ?? null,
          started_at: dto.started_at ?? null,
        },
        { onConflict: 'client_slug,commit_sha,suite' },
      )
      .select()
      .single();

    if (runError) throw runError;

    // 5. Recalcular regresiones (idempotente: borra y reinserta para este run).
    await this.supabase.from('qa_regressions').delete().eq('run_id', run.id);

    const prevFailing: FailingTest[] = Array.isArray(prevRun?.failing_tests)
      ? (prevRun!.failing_tests as FailingTest[])
      : [];
    const prevKeys = new Set(prevFailing.map((t) => t.key));
    const currKeys = new Set(currentFailing.map((t) => t.key));

    const rows: Array<{
      run_id: string;
      client_slug: string;
      test_id: string;
      title: string;
      file: string | null;
      kind: 'new_fail' | 'fixed' | 'flaky';
    }> = [];

    for (const t of currentFailing) {
      if (!prevKeys.has(t.key)) {
        rows.push({ run_id: run.id, client_slug: dto.client_slug, test_id: t.key, title: t.title, file: t.file ?? null, kind: 'new_fail' });
      }
    }
    for (const t of prevFailing) {
      if (!currKeys.has(t.key)) {
        rows.push({ run_id: run.id, client_slug: dto.client_slug, test_id: t.key, title: t.title, file: t.file ?? null, kind: 'fixed' });
      }
    }
    for (const t of tests) {
      if (t.status === 'flaky') {
        rows.push({ run_id: run.id, client_slug: dto.client_slug, test_id: testKey(t), title: t.title, file: t.file ?? null, kind: 'flaky' });
      }
    }

    if (rows.length > 0) {
      const { error: regErr } = await this.supabase.from('qa_regressions').insert(rows);
      if (regErr) throw regErr;
    }

    // 6. Actividad: registrar la corrida (para el feed por persona).
    if (dto.actor_login) {
      await this.supabase.from('qa_activity').insert({
        actor_login: dto.actor_login,
        kind: 'run',
        client_slug: dto.client_slug,
        title: `Corrió ${suite} de ${dto.client_name || dto.client_slug}: ${dto.passed}/${dto.total} OK`,
        url: dto.report_url ?? dto.gh_run_url ?? null,
        ts: dto.started_at ?? new Date().toISOString(),
        meta: { passed: dto.passed, failed: dto.failed, total: dto.total, suite },
      });
    }

    const newFails = rows.filter((r) => r.kind === 'new_fail').length;
    this.logger.log(
      `Ingest ${dto.client_slug}/${suite} @${dto.commit_sha ?? 'local'}: ${dto.passed}/${dto.total} OK, ${newFails} regresiones nuevas`,
    );

    return {
      run_id: run.id,
      regressions: { new_fail: newFails, fixed: rows.filter((r) => r.kind === 'fixed').length, flaky: rows.filter((r) => r.kind === 'flaky').length },
    };
  }

  async ingestActivity(dto: IngestActivityDto) {
    const { error } = await this.supabase.from('qa_activity').insert({
      actor_login: dto.actor_login,
      kind: dto.kind,
      client_slug: dto.client_slug ?? null,
      title: dto.title,
      url: dto.url ?? null,
      ts: dto.ts ?? new Date().toISOString(),
      meta: dto.meta ?? {},
    });
    if (error) throw error;
    return { ok: true };
  }

  /**
   * Universo de módulos + avance de regresión (lo empuja coverage:universe del
   * monorepo). Se guarda en qa_clients.inventory.universe SIN pisar el resto del
   * inventario ni el display_name. Permite que el widget muestre el estado aunque
   * todavía no haya corridas.
   */
  async ingestUniverse(dto: IngestUniverseDto) {
    const universe = {
      total_modules: dto.total_modules,
      covered_modules: dto.covered_modules,
      pct: dto.pct,
      total_stories: dto.total_stories,
      automated_stories: dto.automated_stories,
      modules: dto.modules,
      updated_at: new Date().toISOString(),
    };
    const { data: existing } = await this.supabase
      .from('qa_clients')
      .select('inventory')
      .eq('slug', dto.client_slug)
      .maybeSingle();

    if (existing) {
      const inventory = { ...(existing.inventory ?? {}), universe };
      const { error } = await this.supabase
        .from('qa_clients')
        .update({ inventory, updated_at: new Date().toISOString() })
        .eq('slug', dto.client_slug);
      if (error) throw error;
    } else {
      const { error } = await this.supabase.from('qa_clients').insert({
        slug: dto.client_slug,
        display_name: dto.client_name || dto.client_slug,
        enabled: true,
        inventory: { universe },
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
    }
    this.logger.log(`Universe ${dto.client_slug}: ${dto.covered_modules}/${dto.total_modules} módulos (${dto.pct}%)`);
    return { ok: true, pct: dto.pct, total_modules: dto.total_modules };
  }
}
