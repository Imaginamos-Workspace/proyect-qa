import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_CLIENT } from '../../config/supabase.module';
import { GeminiProvider } from './providers/gemini.provider';
import { TestSuitesService } from '../test-suites/test-suites.service';
import { TestCasesService } from '../test-cases/test-cases.service';
import {
  scanPage,
  buildScanUrl,
  summarizeSnapshotForPrompt,
} from './utils/page-scanner';
import { buildSuggestExplorationPrompt } from './prompts/test-generation.prompt';
import {
  AISuggestion,
  AISuggestExploreRequest,
  AISuggestExploreResponse,
  AIConvertSuggestionResponse,
  TestType,
  TestPriority,
} from '../../shared-types';

/**
 * Common paths we try scanning on every site. Enough to cover the typical
 * QA scope without blowing the 60s Vercel function budget. Each scan runs
 * in parallel via Promise.allSettled.
 */
const COMMON_PATHS: Array<{ section: string; path: string }> = [
  { section: 'Página de inicio', path: '/' },
  { section: 'Login', path: '/login' },
  { section: 'Registro', path: '/register' },
  { section: 'Productos', path: '/products' },
  { section: 'Tienda', path: '/shop' },
  { section: 'Carrito', path: '/cart' },
  { section: 'Checkout', path: '/checkout' },
  { section: 'Contacto', path: '/contact' },
];

@Injectable()
export class SuggestionsService {
  constructor(
    @Inject(SUPABASE_CLIENT) private readonly supabase: SupabaseClient,
    private readonly gemini: GeminiProvider,
    private readonly testSuitesService: TestSuitesService,
    private readonly testCasesService: TestCasesService,
  ) {}

  /** Fetch suggestions for a project. By default returns pending only. */
  async findByProject(
    projectId: string,
    opts: { includeAll?: boolean } = {},
  ): Promise<AISuggestion[]> {
    let query = this.supabase
      .from('test_suggestions')
      .select('*')
      .eq('project_id', projectId);
    if (!opts.includeAll) query = query.eq('status', 'pending');
    const { data, error } = await query.order('created_at', {
      ascending: false,
    });
    if (error) throw error;
    return (data || []) as AISuggestion[];
  }

  /**
   * Explore the configured site, ask Gemini to propose test scenarios
   * grouped by section, persist them as pending suggestions. Skips
   * scenarios overlapping with existing test case titles for the project.
   */
  async exploreAndSuggest(
    request: AISuggestExploreRequest,
  ): Promise<AISuggestExploreResponse> {
    if (!request.project_id) {
      throw new BadRequestException('project_id required');
    }

    // 1. Load project + base_url
    const { data: project, error: projErr } = await this.supabase
      .from('projects')
      .select('id, base_url')
      .eq('id', request.project_id)
      .single();
    if (projErr || !project) throw new NotFoundException('Project not found');
    const baseUrl: string | undefined = project.base_url;
    if (!baseUrl) {
      throw new BadRequestException(
        'Project has no base_url configured. Edit the project to add one.',
      );
    }

    // 2. Optionally clear pending suggestions before regenerating
    if (request.reset_pending) {
      await this.supabase
        .from('test_suggestions')
        .delete()
        .eq('project_id', request.project_id)
        .eq('status', 'pending');
    }

    // 3. Scan common paths in parallel. Each scan ~2-3s; allSettled bounds
    //    total time to the slowest one.
    const failedSections: string[] = [];
    const scanResults = await Promise.allSettled(
      COMMON_PATHS.map(async ({ section, path }) => {
        const fullUrl = buildScanUrl(baseUrl, path);
        if (!fullUrl) return null;
        const snap = await scanPage(fullUrl);
        if (!snap) return null;
        return {
          section,
          url: fullUrl,
          snapshot: summarizeSnapshotForPrompt(snap),
        };
      }),
    );
    const pages = scanResults
      .map((r, i) => {
        if (r.status === 'fulfilled' && r.value) return r.value;
        if (r.status === 'rejected' || (r.status === 'fulfilled' && !r.value)) {
          failedSections.push(COMMON_PATHS[i].section);
        }
        return null;
      })
      .filter((p): p is NonNullable<typeof p> => !!p);

    if (pages.length === 0) {
      throw new BadRequestException(
        'Could not scan any page on the configured site. Check that the base_url is reachable.',
      );
    }

    // 4. Gather existing test case titles to avoid duplicate proposals
    const { data: existingCases } = await this.supabase
      .from('test_cases')
      .select('title')
      .eq('project_id', request.project_id);
    const existingTitles = (existingCases || [])
      .map((c) => c.title as string)
      .filter(Boolean);

    // 5. Ask Gemini to propose scenarios
    const prompt = buildSuggestExplorationPrompt({
      baseUrl,
      pages,
      existingTestTitles: existingTitles,
    });

    // Exploration responses are large (8 pages × multiple suggestions each).
    // 4096 truncated mid-JSON in production — bump to 16384 (model max for
    // gemini-2.5-flash is 65535, plenty of headroom).
    const aiResult = await this.gemini.generateRaw({
      prompt,
      temperature: 0.3,
      maxOutputTokens: 16384,
      responseMimeType: 'application/json',
    });

    let parsed: { sections?: SectionFromAI[] };
    try {
      parsed = JSON.parse(aiResult);
    } catch {
      // Last-ditch: truncated JSON. Try to recover by closing brackets up
      // to the last well-formed entry. If that also fails, surface a
      // clear error to the UI.
      const recovered = tryRecoverTruncatedJson(aiResult);
      if (recovered) {
        parsed = recovered;
      } else {
        throw new Error(
          `AI returned invalid JSON (probably truncated). Re-explore en unos minutos.`,
        );
      }
    }

    const sectionsFromAI = parsed.sections || [];
    const sectionsOrder: string[] = [];

    // 6. Persist as pending suggestions, filtering out any whose title
    //    is too similar to an existing case (loose substring/prefix match).
    let skippedExisting = 0;
    const persisted: AISuggestion[] = [];

    for (const section of sectionsFromAI) {
      if (!section?.name || !Array.isArray(section.suggestions)) continue;
      sectionsOrder.push(section.name);

      for (const s of section.suggestions) {
        if (!s?.title || !s?.description) continue;
        if (titleOverlapsExisting(s.title, existingTitles)) {
          skippedExisting += 1;
          continue;
        }

        const row = {
          project_id: request.project_id,
          section: section.name,
          scan_url: section.scan_url || '/',
          title: s.title.slice(0, 200),
          description: (s.description || '').slice(0, 1000),
          what_to_test: (s.what_to_test || s.description || '').slice(0, 1000),
          how_to_test: (s.how_to_test || '').slice(0, 1000),
          test_type: validateTestType(s.test_type),
          priority: validatePriority(s.priority),
          status: 'pending',
          ai_metadata: s.ai_metadata || {},
        };

        const { data, error } = await this.supabase
          .from('test_suggestions')
          .insert(row)
          .select()
          .single();
        if (error) {
          console.warn(`[suggestions] insert failed:`, error.message);
          continue;
        }
        persisted.push(data as AISuggestion);
      }
    }

    return {
      suggestions: persisted,
      sections: dedupe(sectionsOrder),
      skipped_existing: skippedExisting,
      failed_sections: dedupe(failedSections),
    };
  }

  async dismiss(suggestionId: string): Promise<AISuggestion> {
    const { data, error } = await this.supabase
      .from('test_suggestions')
      .update({
        status: 'dismissed',
        dismissed_at: new Date().toISOString(),
      })
      .eq('id', suggestionId)
      .select()
      .single();
    if (error || !data) throw new NotFoundException('Suggestion not found');
    return data as AISuggestion;
  }

  async hardDelete(suggestionId: string): Promise<void> {
    const { error } = await this.supabase
      .from('test_suggestions')
      .delete()
      .eq('id', suggestionId);
    if (error) throw new NotFoundException('Suggestion not found');
  }

  /**
   * Convert a suggestion into a real test case. Reuses the existing
   * completeSingleTest flow (live DOM scan + AI generation) using the
   * suggestion's stored metadata so we don't re-ask the user anything.
   */
  async convertToTestCase(
    suggestionId: string,
  ): Promise<AIConvertSuggestionResponse> {
    const { data: suggestion, error } = await this.supabase
      .from('test_suggestions')
      .select('*')
      .eq('id', suggestionId)
      .single();
    if (error || !suggestion) {
      throw new NotFoundException('Suggestion not found');
    }
    if (suggestion.status === 'converted') {
      throw new BadRequestException('Suggestion already converted');
    }

    // Resolve project base_url for the scan
    const { data: project } = await this.supabase
      .from('projects')
      .select('base_url')
      .eq('id', suggestion.project_id)
      .single();
    const baseUrl: string | undefined = project?.base_url;
    if (!baseUrl) {
      throw new BadRequestException('Project has no base_url configured');
    }

    // Find or create a default suite for this section
    const suiteName = `AI Suggestions - ${suggestion.section}`;
    const suite = await this.testSuitesService.create(
      suggestion.project_id,
      {
        name: suiteName,
        description: `Test cases generated from AI suggestions in section "${suggestion.section}"`,
        test_type: suggestion.test_type as TestType,
      },
      true,
    );

    // Build a description that combines the user-friendly fields the AI
    // produced — completeSingleTest will use this as the prompt input.
    const combinedDescription = [
      suggestion.description,
      `Qué probar: ${suggestion.what_to_test}`,
      `Cómo probarlo: ${suggestion.how_to_test}`,
    ]
      .filter(Boolean)
      .join('\n');

    // Live scan of the same path the AI proposed, then ask Gemini to write
    // the actual Playwright code. Goes through the existing completeSingleTest
    // path so all the prompt rules (no scope creep, no fake credentials,
    // no hidden interactions) apply automatically.
    const scanUrl = buildScanUrl(baseUrl, suggestion.scan_url || '/');
    let liveSnapshotText: string | undefined;
    if (scanUrl) {
      const snap = await scanPage(scanUrl);
      if (snap) liveSnapshotText = summarizeSnapshotForPrompt(snap);
    }

    const generated = await this.gemini.completeSingleTest(
      {
        project_id: suggestion.project_id,
        suite_id: suite.id,
        title: suggestion.title,
        description: combinedDescription,
        test_type: suggestion.test_type as TestType,
        priority: suggestion.priority as TestPriority,
        base_url: baseUrl,
        scan_url_override: suggestion.scan_url,
      },
      liveSnapshotText,
    );

    // Persist the generated test case
    const created = await this.testCasesService.createMany(
      suggestion.project_id,
      [
        {
          suite_id: suite.id,
          title: generated.title || suggestion.title,
          description: generated.description || suggestion.description,
          test_type: generated.test_type,
          playwright_code: generated.playwright_code,
          tags: generated.tags || [],
          priority: generated.priority,
          browser_targets: generated.browser_targets || ['chromium'],
          viewport_config: generated.viewport_config,
        },
      ],
    );
    const testCase = created[0];

    // Mark suggestion converted
    await this.supabase
      .from('test_suggestions')
      .update({
        status: 'converted',
        converted_test_case_id: testCase.id,
      })
      .eq('id', suggestionId);

    return {
      test_case_id: testCase.id,
      test_case: {
        id: testCase.id,
        title: testCase.title,
        description: testCase.description ?? undefined,
      },
    };
  }
}

// ─── helpers ─────────────────────────────────────────────────────────

interface SectionFromAI {
  name: string;
  scan_url?: string;
  suggestions: SuggestionFromAI[];
}

interface SuggestionFromAI {
  title: string;
  description: string;
  what_to_test?: string;
  how_to_test?: string;
  test_type?: string;
  priority?: string;
  ai_metadata?: Record<string, unknown>;
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr.filter(Boolean)));
}

/**
 * Best-effort recovery of a JSON response that got truncated mid-output
 * (Gemini hit maxOutputTokens). We trim to the last complete suggestion
 * we can identify and close brackets. Returns null if nothing salvageable.
 */
function tryRecoverTruncatedJson(
  raw: string,
): { sections: SectionFromAI[] } | null {
  if (!raw || !raw.includes('"sections"')) return null;
  // Find the last complete "}" inside a suggestion that's followed by a
  // comma or array close — that's our last clean cut point.
  let cut = raw.lastIndexOf('}');
  while (cut > 0) {
    const tail = raw.slice(0, cut + 1);
    // Try to close any open structures
    const opens = (tail.match(/[\[{]/g) || []).length;
    const closes = (tail.match(/[\]}]/g) || []).length;
    const missing = opens - closes;
    if (missing >= 0) {
      const closing = ']}'.repeat(missing).split('').slice(0, missing).join('');
      // Build closing from outside-in: usually need one of each
      const repaired = tail + (missing === 1 ? '}' : closing.length > 0 ? ']'.repeat(Math.floor(missing / 2)) + '}'.repeat(Math.ceil(missing / 2)) : '');
      try {
        const parsed = JSON.parse(repaired);
        if (parsed && Array.isArray(parsed.sections)) return parsed;
      } catch {
        /* keep trying */
      }
    }
    cut = raw.lastIndexOf('}', cut - 1);
  }
  return null;
}

function titleOverlapsExisting(
  proposed: string,
  existing: string[],
): boolean {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z0-9 ]/g, '')
      .trim();
  const p = norm(proposed);
  if (!p) return false;
  for (const e of existing) {
    const en = norm(e);
    if (!en) continue;
    if (en === p) return true;
    if (en.includes(p) || p.includes(en)) return true;
    // Simple word-overlap heuristic: if 60%+ of proposed words appear in
    // existing, consider it a duplicate proposal.
    const pw = new Set(p.split(/\s+/));
    const ew = new Set(en.split(/\s+/));
    let common = 0;
    for (const w of pw) if (ew.has(w)) common += 1;
    if (pw.size > 0 && common / pw.size >= 0.6) return true;
  }
  return false;
}

const VALID_TEST_TYPES: TestType[] = [
  'e2e',
  'regression',
  'visual',
  'accessibility',
  'performance',
  'api',
  'cross_browser',
  'responsive',
];
const VALID_PRIORITIES: TestPriority[] = [
  'low',
  'medium',
  'high',
  'critical',
];

function validateTestType(v: unknown): TestType {
  return VALID_TEST_TYPES.includes(v as TestType) ? (v as TestType) : 'e2e';
}
function validatePriority(v: unknown): TestPriority {
  return VALID_PRIORITIES.includes(v as TestPriority)
    ? (v as TestPriority)
    : 'medium';
}
