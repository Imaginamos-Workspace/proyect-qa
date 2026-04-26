import { Injectable, Inject, NotFoundException } from '@nestjs/common';
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
  AIGenerateRequest,
  AIGenerateResponse,
  AIRefineRequest,
  AIRefineResponse,
  AICompleteTestRequest,
  AICompleteTestResponse,
  AIGenerationJob,
  TestType,
} from '../../shared-types';

@Injectable()
export class AIService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly gemini: GeminiProvider,
    private readonly testSuitesService: TestSuitesService,
    private readonly testCasesService: TestCasesService,
  ) {}

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
    const test_case = await this.gemini.completeSingleTest(request);
    // Do NOT persist — the frontend saves it after the user confirms.
    return { test_case };
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
      const path = extractGotoPath(request.current_code);
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
