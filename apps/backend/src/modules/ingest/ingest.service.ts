import { Inject, Injectable, Logger } from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../config/supabase.module';
import { IngestRunDto, IngestActivityDto, IngestUniverseDto, IngestCredentialsDto, IngestUniverseMapDto, IngestExtractModulesDto, IngestProposalViewDto } from './dto/ingest-run.dto';
import { AIService } from '../ai/ai.service';

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
    private readonly aiService: AIService,
  ) {}

  async ingestRun(dto: IngestRunDto) {
    const suite = dto.suite || 'e2e';

    // 1. Upsert del cliente (slug + links de reportes/diseños + inventario).
    // El inventario (pruebas ESCRITAS) se deriva de la corrida — specs del repo
    // y tests de la suite — así el "estado de construcción de la regresión" se
    // actualiza solo con cada corrida (qa:apply local o CI), sin cargas manuales.
    // El universo (denominador del % de regresión) NO debe perderse al sobrescribir
    // el inventario: si la corrida trae uno fresco (coverage.universe) lo guardamos,
    // si no, conservamos el que ya estaba (lo sembró qa:universe-sync). Antes, este
    // upsert pisaba inventory y borraba universe en cada corrida.
    const { data: existingClient } = await this.supabase
      .from('qa_clients')
      .select('inventory')
      .eq('slug', dto.client_slug)
      .maybeSingle();
    const existingUniverse = (existingClient?.inventory as { universe?: unknown } | null)?.universe;
    let universe = dto.coverage?.universe
      ? { ...dto.coverage.universe, updated_at: new Date().toISOString() }
      : existingUniverse;

    // Numerador IA DINÁMICO: en cada corrida re-mapea la automatización (los tests
    // que corrieron) a los módulos del universo con Gemini (backend). Así el % se
    // actualiza solo en cada run, sin correr qa:universe-ai a mano. Best-effort.
    universe = await this.aiMapUniverse(universe, dto.tests ?? []);

    const inventory = {
      specs_total: dto.coverage?.specs_total ?? 0,
      tests_total: (dto.tests ?? []).length,
      modules: (dto.coverage?.modules ?? []).map((m) => ({ name: m.name, tests: m.total })),
      updated_at: new Date().toISOString(),
      ...(universe ? { universe } : {}),
    };
    // Escribir inventory si hay specs/tests O si hay universo que preservar/refrescar.
    const writeInventory =
      inventory.tests_total || inventory.specs_total || universe;
    await this.supabase.from('qa_clients').upsert(
      {
        slug: dto.client_slug,
        display_name: dto.client_name || dto.client_slug,
        reports_url: dto.reports_url ?? null,
        designs_url: dto.designs_url ?? null,
        enabled: true,
        ...(writeInventory ? { inventory } : {}),
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
    await this.storeUniverse(dto.client_slug, dto.client_name, universe);
    this.logger.log(`Universe ${dto.client_slug}: ${dto.covered_modules}/${dto.total_modules} módulos (${dto.pct}%)`);
    return { ok: true, pct: dto.pct, total_modules: dto.total_modules };
  }

  /**
   * Re-mapea con IA la automatización (tests de la corrida) a los módulos del
   * universo y recalcula covered/pct. Numerador = automatización QA, dinámico por
   * corrida. Best-effort: ante cualquier fallo devuelve el universo sin tocar.
   */
  private async aiMapUniverse(
    universe: unknown,
    tests: { title: string; file?: string }[],
  ): Promise<unknown> {
    const u = universe as
      | { modules?: { name: string; epics?: string[]; stories_total?: number }[] }
      | undefined;
    if (!u?.modules?.length || !tests.length) return universe;
    try {
      const grouped = Object.values(
        tests.reduce<Record<string, { file: string; titles: string[] }>>((acc, t) => {
          const f = t.file ?? '';
          (acc[f] ??= { file: f, titles: [] }).titles.push(t.title);
          return acc;
        }, {}),
      );
      const mapped = await this.aiService.mapModuleCoverage(
        u.modules.map((m) => m.name),
        grouped,
      );
      const byName = new Map(mapped.map((m) => [m.name.toLowerCase(), m]));
      const modules = u.modules.map((m) => {
        const hit = byName.get(m.name.toLowerCase());
        return { ...m, status: hit?.status ?? 'pending', automated: hit?.automated ?? 0 };
      });
      const covered = modules.filter((m) => m.status === 'covered').length;
      return {
        ...u,
        modules,
        covered_modules: covered,
        pct: modules.length ? Math.round((covered / modules.length) * 100) : 0,
        automated_stories: modules.reduce((n, m) => n + (m.automated || 0), 0),
        updated_at: new Date().toISOString(),
      };
    } catch (e) {
      this.logger.warn(`aiMapUniverse falló (${String(e)}) — conservo el universo previo.`);
      return universe;
    }
  }

  /** Guarda el universo en qa_clients.inventory.universe sin pisar el resto. */
  private async storeUniverse(
    slug: string,
    clientName: string | undefined,
    universe: Record<string, unknown>,
  ): Promise<void> {
    const { data: existing } = await this.supabase
      .from('qa_clients')
      .select('inventory')
      .eq('slug', slug)
      .maybeSingle();

    if (existing) {
      const inventory = { ...(existing.inventory ?? {}), universe };
      const { error } = await this.supabase
        .from('qa_clients')
        .update({ inventory, updated_at: new Date().toISOString() })
        .eq('slug', slug);
      if (error) throw error;
    } else {
      const { error } = await this.supabase.from('qa_clients').insert({
        slug,
        display_name: clientName || slug,
        enabled: true,
        inventory: { universe },
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
    }
  }

  /**
   * Mapea la automatización del QA a los módulos del universo CON IA (Gemini, en el
   * backend) y guarda la cobertura. El monorepo manda solo los nombres de módulo y los
   * títulos de los tests (no necesita la key). Numerador = automatización QA.
   */
  async ingestUniverseMap(dto: IngestUniverseMapDto) {
    const moduleNames = dto.modules.map((m) => m.trim()).filter(Boolean);
    const mapped = await this.aiService.mapModuleCoverage(moduleNames, dto.tests ?? []);
    const covered = mapped.filter((m) => m.status === 'covered').length;
    const pct = mapped.length ? Math.round((covered / mapped.length) * 100) : 0;
    const universe = {
      total_modules: mapped.length,
      covered_modules: covered,
      pct,
      total_stories: 0,
      automated_stories: mapped.reduce((n, m) => n + m.automated, 0),
      modules: mapped.map((m) => ({ name: m.name, epics: [], stories_total: 0, automated: m.automated, status: m.status })),
      updated_at: new Date().toISOString(),
    };
    await this.storeUniverse(dto.client_slug, dto.client_name, universe);
    this.logger.log(`UniverseMap ${dto.client_slug}: ${covered}/${mapped.length} módulos covered (${pct}%)`);
    return { ok: true, pct, covered_modules: covered, total_modules: mapped.length };
  }

  /**
   * Extrae los módulos del universo con IA (Gemini, backend) a partir de señales
   * del sitio o los repos, guarda un universo BASELINE (todos pending, 0%) y
   * devuelve la lista de módulos (el monorepo la escribe en modules.md).
   */
  async extractModules(dto: IngestExtractModulesDto) {
    const kind = dto.kind === 'repos' ? 'repos' : 'site';
    const modules = await this.aiService.extractModules(dto.signals ?? [], kind);
    if (!modules.length) return { ok: true, modules: [], total_modules: 0 };
    const universe = {
      total_modules: modules.length,
      covered_modules: 0,
      pct: 0,
      total_stories: 0,
      automated_stories: 0,
      modules: modules.map((name) => ({ name, epics: [], stories_total: 0, automated: 0, status: 'pending' })),
      updated_at: new Date().toISOString(),
    };
    await this.storeUniverse(dto.client_slug, dto.client_name, universe);
    this.logger.log(`ExtractModules ${dto.client_slug} (${kind}): ${modules.length} módulos`);
    return { ok: true, modules, total_modules: modules.length };
  }

  /**
   * Credenciales + entornos del cliente (panel del dashboard). Lo empuja el
   * monorepo (qa:creds-sync) desde projects/<c>/.env + project.meta.json. Se
   * guarda en qa_clients.inventory.credentials SIN pisar universe ni el resto
   * del inventario. En claro (portal tras login de lista blanca).
   */
  async ingestCredentials(dto: IngestCredentialsDto) {
    const credentials = {
      base_url: dto.base_url ?? null,
      api_url: dto.api_url ?? null,
      environments: dto.environments ?? {},
      qa_users: dto.qa_users ?? [],
      updated_at: new Date().toISOString(),
    };
    const { data: existing } = await this.supabase
      .from('qa_clients')
      .select('inventory')
      .eq('slug', dto.client_slug)
      .maybeSingle();

    if (existing) {
      const inventory = { ...(existing.inventory ?? {}), credentials };
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
        inventory: { credentials },
        updated_at: new Date().toISOString(),
      });
      if (error) throw error;
    }
    this.logger.log(`Credentials ${dto.client_slug}: ${credentials.qa_users.length} usuarios, ${Object.keys(credentials.environments).length} entornos`);
    return { ok: true, qa_users: credentials.qa_users.length, environments: Object.keys(credentials.environments).length };
  }

  /** El worker de qa-proposals llama esto (fire-and-forget) cada vez que un
   *  visitante pasa el gate de contraseña — métricas de apertura del módulo Ventas. */
  async ingestProposalView(dto: IngestProposalViewDto) {
    const { error } = await this.supabase.from('sales_proposal_views').insert({
      cliente: dto.cliente,
      oportunidad: dto.oportunidad,
    });
    if (error) throw error;
    return { ok: true };
  }
}
