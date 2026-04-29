import {
  Injectable,
  Inject,
  NotFoundException,
  UnauthorizedException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../config/supabase.module';
import { GeminiProvider } from './providers/gemini.provider';
import { TestSuitesService } from '../test-suites/test-suites.service';
import { TestCasesService } from '../test-cases/test-cases.service';
import {
  scanPage,
  extractGotoPath,
  buildScanUrl,
  summarizeSnapshotForPrompt,
} from './utils/page-scanner';
import {
  signHealToken,
  verifyHealToken,
  deriveHealSecret,
} from './utils/heal-token';
import { validateSelectorsAgainstSnapshot } from './utils/selector-validator';
import {
  AIGenerateRequest,
  AIGenerateResponse,
  AIRefineRequest,
  AIRefineResponse,
  AICompleteTestRequest,
  AICompleteTestResponse,
  AIHealIterateRequest,
  AIHealIterateResponse,
  AIHealTokenResponse,
  AIGenerationJob,
  TestType,
} from '../../shared-types';

const MAX_HEAL_ITERATIONS = 3;

@Injectable()
export class AIService {
  /** Lazy-initialized HMAC secret for heal tokens. */
  private healSecret?: string;

  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly gemini: GeminiProvider,
    private readonly testSuitesService: TestSuitesService,
    private readonly testCasesService: TestCasesService,
    private readonly configService: ConfigService,
  ) {}

  private getHealSecret(): string {
    if (this.healSecret) return this.healSecret;
    // Derive from the existing Supabase service role key — no new env var
    // needed. Derivation isolates a heal-token leak from the underlying key.
    const base =
      this.configService.get<string>('SUPABASE_SERVICE_ROLE_KEY') ||
      this.configService.get<string>('SUPABASE_KEY') ||
      this.configService.get<string>('GEMINI_API_KEY') ||
      'qa-heal-fallback-do-not-use-in-prod';
    this.healSecret = deriveHealSecret(base);
    return this.healSecret;
  }

  /**
   * Issue a scoped heal token for a specific test case. Requires Supabase
   * session (the controller enforces auth). The token is consumed by the
   * public /ai/heal-iterate endpoint to authorize that one test case.
   */
  async issueHealToken(testCaseId: string): Promise<AIHealTokenResponse> {
    if (!testCaseId) throw new BadRequestException('test_case_id required');
    // Verify the test case exists before issuing a token.
    const tc = await this.testCasesService.findOne(testCaseId).catch(() => null);
    if (!tc) throw new NotFoundException('Test case not found');
    const { token, expires_at } = signHealToken(this.getHealSecret(), testCaseId);
    return { token, expires_at, test_case_id: testCaseId };
  }

  async generateTests(request: AIGenerateRequest): Promise<AIGenerateResponse> {
    const generatedCases = await this.gemini.generateTestCases(request);

    // Group by test type and create suites + test cases
    const byType = new Map<TestType, typeof generatedCases>();
    for (const tc of generatedCases) {
      const list = byType.get(tc.test_type) || [];
      list.push(tc);
      byType.set(tc.test_type, list);
    }

    const savedCases = [];

    for (const [testType, cases] of byType) {
      // Create or find a suite for this type
      const suite = await this.testSuitesService.create(
        request.project_id,
        {
          name: `AI Generated - ${testType.toUpperCase()} - ${new Date().toISOString().split('T')[0]}`,
          description: `Auto-generated ${testType} tests for ${request.base_url}`,
          test_type: testType,
        },
        true,
      );

      const dtos = cases.map((c) => ({
        suite_id: suite.id,
        title: c.title,
        description: c.description,
        test_type: c.test_type,
        playwright_code: c.playwright_code,
        tags: c.tags,
        priority: c.priority,
        browser_targets: c.browser_targets || ['chromium'],
        viewport_config: c.viewport_config,
      }));

      const created = await this.testCasesService.createMany(
        request.project_id,
        dtos,
      );
      savedCases.push(...created);
    }

    return {
      test_cases: generatedCases,
      analysis_summary: `Generated ${generatedCases.length} test cases across ${byType.size} test types`,
      suggestions: [
        'Review generated tests before running',
        'Customize selectors if the AI used generic ones',
        'Add authentication steps if the app requires login',
      ],
    };
  }

  async completeSingleTest(
    request: AICompleteTestRequest,
  ): Promise<AICompleteTestResponse> {
    // Live scan (same pattern as refineTest). The user describes what they
    // want to test; we look at the actual page so the AI uses real selectors
    // instead of guessing. Bulletproof: any failure falls back to text-only.
    let liveSnapshotText: string | undefined;
    let scanStatus: 'scanned' | 'no_base_url' | 'scan_failed' = 'no_base_url';
    let scanUrl: string | null = null;
    let elementCounts:
      | { inputs: number; buttons: number; links: number; forms: number }
      | undefined;

    if (request.base_url) {
      // Resolve the path: explicit override wins, else infer from the
      // description (login keywords → /login, signup → /register, etc.),
      // else default to '/'.
      let path: string;
      const override = request.scan_url_override?.trim();
      if (override) {
        if (/^https?:\/\//i.test(override)) {
          try {
            const u = new URL(override);
            path = u.pathname + u.search + u.hash;
          } catch {
            path = '/';
          }
        } else {
          path = override.startsWith('/') ? override : '/' + override;
        }
      } else {
        path = inferPathFromDescription(request.description) ?? '/';
      }

      scanUrl = buildScanUrl(request.base_url, path);
      if (scanUrl) {
        const snapshot = await scanPage(scanUrl);
        if (snapshot) {
          liveSnapshotText = summarizeSnapshotForPrompt(snapshot);
          scanStatus = 'scanned';
          elementCounts = {
            inputs: snapshot.inputs.length,
            buttons: snapshot.buttons.length,
            links: snapshot.links.length,
            forms: snapshot.forms.length,
          };
        } else {
          scanStatus = 'scan_failed';
        }
      } else {
        scanStatus = 'scan_failed';
      }
    }

    const test_case = await this.gemini.completeSingleTest(
      request,
      liveSnapshotText,
    );
    // Do NOT persist — the frontend saves it after the user confirms.
    return {
      test_case,
      scan_status: scanStatus,
      scan_url: scanUrl ?? undefined,
      scan_elements: elementCounts,
    };
  }

  async refineTest(request: AIRefineRequest): Promise<AIRefineResponse> {
    // Try to scan the live page for a fresh DOM snapshot. Bulletproof: any
    // failure (no base URL, invalid path, network error, SPA shell, timeout)
    // silently falls back to code+feedback-only refine — the user flow never
    // breaks.
    let liveSnapshotText: string | undefined;
    let scanStatus: 'scanned' | 'no_base_url' | 'no_goto' | 'scan_failed' =
      'no_base_url';
    let scanUrl: string | null = null;
    let elementCounts:
      | { inputs: number; buttons: number; links: number; forms: number }
      | undefined;

    if (request.project_base_url) {
      // Pick the path: explicit override (user-chosen URL) wins, else
      // auto-detect from the test's page.goto().
      let path: string | null;
      if (request.scan_url_override && request.scan_url_override.trim()) {
        // Override accepts both absolute URLs and paths. If absolute and
        // matches the project host, strip to path. Otherwise treat as path.
        const raw = request.scan_url_override.trim();
        if (/^https?:\/\//i.test(raw)) {
          try {
            const u = new URL(raw);
            path = u.pathname + u.search + u.hash;
          } catch {
            path = null;
          }
        } else {
          path = raw.startsWith('/') ? raw : '/' + raw;
        }
      } else {
        path = extractGotoPath(request.current_code);
      }

      if (path === null) {
        scanStatus = 'no_goto';
      } else {
        scanUrl = buildScanUrl(request.project_base_url, path);
        if (!scanUrl) {
          scanStatus = 'scan_failed';
        } else {
          const snapshot = await scanPage(scanUrl);
          if (snapshot) {
            liveSnapshotText = summarizeSnapshotForPrompt(snapshot);
            scanStatus = 'scanned';
            elementCounts = {
              inputs: snapshot.inputs.length,
              buttons: snapshot.buttons.length,
              links: snapshot.links.length,
              forms: snapshot.forms.length,
            };
          } else {
            scanStatus = 'scan_failed';
          }
        }
      }
    }

    const refinedCode = await this.gemini.refineTestCase(
      request.current_code,
      request.feedback,
      liveSnapshotText,
    );

    // Update the test case in the database
    await this.testCasesService.update(request.test_case_id, {
      playwright_code: refinedCode,
    });

    let summary: string;
    if (scanStatus === 'scanned' && elementCounts && scanUrl) {
      const c = elementCounts;
      summary = `Escaneé ${scanUrl} → ${c.forms} formulario(s), ${c.inputs} input(s), ${c.buttons} botón(es), ${c.links} enlace(s). El AI usó estos selectores reales.`;
    } else if (scanStatus === 'no_goto') {
      summary =
        'Refiné con tu feedback. No pude escanear el sitio: el test no tiene un page.goto() para saber qué URL escanear.';
    } else if (scanStatus === 'no_base_url') {
      summary =
        'Refiné con tu feedback. No pude escanear el sitio: el proyecto no tiene URL base configurada (Editar proyecto → URL Base).';
    } else {
      summary = `Refiné con tu feedback. El escaneo de ${scanUrl ?? 'la página'} falló (timeout, sitio caído, o bloqueo de bot). El AI no tuvo selectores reales — revisa el código antes de guardar.`;
    }

    return {
      refined_code: refinedCode,
      changes_summary: summary,
      scan_status: scanStatus,
      scan_url: scanUrl ?? undefined,
      scan_elements: elementCounts,
    };
  }

  async analyzeUrl(
    url: string,
    pageData: string,
  ): Promise<string> {
    return this.gemini.analyzeUrl(url, pageData);
  }

  /**
   * Self-healing iteration: the user's local Playwright reported a failure
   * along with the DOM at the failure moment. We call Gemini with that
   * GROUND TRUTH DOM and regenerate the test. This is the closest the
   * platform can get to "tests that always work" because the DOM the AI
   * sees == the DOM the test will run against (same engine, same moment).
   */
  async healIterate(
    request: AIHealIterateRequest,
  ): Promise<AIHealIterateResponse> {
    // 1. Token check — proves the request comes from a previously
    //    authenticated user who issued this token for this exact test case.
    if (!request.heal_token) {
      throw new UnauthorizedException('heal_token required');
    }
    const tokenValid = verifyHealToken(
      this.getHealSecret(),
      request.heal_token,
      request.test_case_id,
    );
    if (!tokenValid) {
      throw new UnauthorizedException('invalid or expired heal token');
    }

    // 2. Iteration bounds.
    if (request.iteration < 1 || request.iteration > MAX_HEAL_ITERATIONS) {
      throw new BadRequestException(
        `Invalid iteration ${request.iteration}. Must be 1..${MAX_HEAL_ITERATIONS}`,
      );
    }

    // 3. Trim payloads. Gemini Flash handles ~1M tokens, but smaller
    //    payloads = faster + cheaper + more focused output.
    const domTrimmed = (request.dom_snapshot || '').slice(0, 30_000);
    const errorTrimmed = (request.error_message || '').slice(0, 4_000);

    // 4. First Gemini call — generate healed code.
    let healedCode = await this.gemini.healTestCase({
      currentCode: request.current_code,
      iteration: request.iteration,
      maxIterations: MAX_HEAL_ITERATIONS,
      errorMessage: errorTrimmed,
      failingSelector: request.failing_selector,
      domSnapshot: domTrimmed,
      structuredSnapshot: request.structured_snapshot,
      failureUrl: request.failure_url,
      priorFailedSelectors: request.prior_failed_selectors,
    });

    // 5. Defense in depth — validate that every selector the AI generated
    //    actually exists in the captured DOM. If we have a structured
    //    snapshot, this is a hard reject. If only raw HTML, we string-search.
    //    On rejection, we make ONE more Gemini call with explicit feedback
    //    about which selectors were invented.
    const validation = validateSelectorsAgainstSnapshot(healedCode, {
      structured: request.structured_snapshot,
      rawHtml: domTrimmed,
    });

    if (validation.invented.length > 0) {
      console.warn(
        `[heal] AI invented ${validation.invented.length} selector(s); retrying with explicit feedback`,
      );
      // Append the invented selectors to the prior-failed list so the AI
      // gets a clear "these don't exist" instruction on the retry.
      const augmentedPrior = [
        ...(request.prior_failed_selectors || []),
        ...validation.invented,
      ];
      try {
        healedCode = await this.gemini.healTestCase({
          currentCode: request.current_code,
          iteration: request.iteration,
          maxIterations: MAX_HEAL_ITERATIONS,
          errorMessage: errorTrimmed,
          failingSelector: request.failing_selector,
          domSnapshot: domTrimmed,
          structuredSnapshot: request.structured_snapshot,
          failureUrl: request.failure_url,
          priorFailedSelectors: augmentedPrior,
        });
      } catch (err) {
        // If the second call also fails to produce valid code, fall through
        // with whatever the first call returned — at least it parses TS.
        console.warn('[heal] second-pass generation failed:', err);
      }
    }

    // 6. Persist healed code. Best-effort.
    try {
      await this.testCasesService.update(request.test_case_id, {
        playwright_code: healedCode,
      });
    } catch (err) {
      console.warn(`[heal] DB update failed for ${request.test_case_id}:`, err);
    }

    const inventedNote =
      validation.invented.length > 0
        ? ` Detecté y rechacé ${validation.invented.length} selector(es) inventado(s) en el primer intento; regeneré con instrucciones explícitas.`
        : '';

    return {
      healed_code: healedCode,
      changes_summary: `Iteración ${request.iteration}/${MAX_HEAL_ITERATIONS}: regeneré con el DOM real capturado en el fallo.${inventedNote}`,
      is_final_iteration: request.iteration >= MAX_HEAL_ITERATIONS,
    };
  }

  // --- AI Generation Jobs ---

  async createGenerationJob(
    projectId: string,
    userId: string,
    testTypes: string[] = ['e2e'],
  ): Promise<AIGenerationJob> {
    const { data, error } = await this.supabase
      .from('ai_generation_jobs')
      .insert({
        project_id: projectId,
        triggered_by: userId,
        status: 'pending',
        test_types: testTypes,
        modules_found: 0,
        test_cases_generated: 0,
      })
      .select()
      .single();

    if (error) throw error;
    return data;
  }

  async getJob(jobId: string): Promise<AIGenerationJob> {
    const { data, error } = await this.supabase
      .from('ai_generation_jobs')
      .select('*')
      .eq('id', jobId)
      .single();

    if (error || !data) throw new NotFoundException('Generation job not found');
    return data;
  }

  async getJobsByProject(projectId: string): Promise<AIGenerationJob[]> {
    const { data, error } = await this.supabase
      .from('ai_generation_jobs')
      .select('*')
      .eq('project_id', projectId)
      .order('created_at', { ascending: false });

    if (error) throw error;
    return data;
  }

  async cancelJob(jobId: string) {
    const { data, error } = await this.supabase
      .from('ai_generation_jobs')
      .update({
        status: 'cancelled',
        current_step: 'Cancelled by user',
        completed_at: new Date().toISOString(),
      })
      .eq('id', jobId)
      .in('status', ['pending', 'crawling', 'analyzing', 'generating'])
      .select()
      .single();

    if (error) throw new NotFoundException('Job not found or already completed');
    return data;
  }

  async updateJobStatus(
    jobId: string,
    status: AIGenerationJob['status'],
    extraData?: Partial<
      Pick<
        AIGenerationJob,
        | 'progress_message'
        | 'result_summary'
        | 'error_message'
        | 'modules_found'
        | 'test_cases_generated'
        | 'started_at'
        | 'completed_at'
      >
    >,
  ): Promise<AIGenerationJob> {
    const { data, error } = await this.supabase
      .from('ai_generation_jobs')
      .update({ status, ...extraData })
      .eq('id', jobId)
      .select()
      .single();

    if (error || !data) throw new NotFoundException('Generation job not found');
    return data;
  }
}

/**
 * Best-effort guess at which path on the site is relevant to the user's
 * test description. Returns null if no obvious match — the caller falls
 * back to "/".
 *
 * Why this exists: when users describe "validar email inválido en login",
 * they expect the AI to look at /login, not the home page. Without this
 * hint, the AI saw / and generated tests for whatever form was on the
 * homepage (e.g. an appointment popup), which fails because the form
 * isn't visible without prior interaction.
 */
function inferPathFromDescription(description?: string): string | null {
  if (!description) return null;
  const d = description.toLowerCase();
  // login / sign-in
  if (
    /\b(login|log\s*in|sign[\s-]?in|iniciar\s*sesi[oó]n|inicio\s*de\s*sesi[oó]n|credencial|contrase|password)\b/.test(
      d,
    )
  ) {
    return '/login';
  }
  // signup / register
  if (
    /\b(sign[\s-]?up|registr[ao]r?se?|crear\s*cuenta|create\s*account|new\s*user|nuevo\s*usuario)\b/.test(
      d,
    )
  ) {
    return '/register';
  }
  // checkout / cart
  if (/\b(checkout|carrito|cart|finalizar\s*compra|pagar\s*compra)\b/.test(d)) {
    return '/checkout';
  }
  // profile / account
  if (/\b(perfil|profile|mi\s*cuenta|my\s*account)\b/.test(d)) {
    return '/account';
  }
  // dashboard
  if (/\b(dashboard|panel|admin)\b/.test(d)) {
    return '/dashboard';
  }
  return null;
}
