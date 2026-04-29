import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AIProvider } from './ai-provider.interface';
import {
  AIGenerateRequest,
  AIGeneratedTestCase,
  AICompleteTestRequest,
  HealDomSnapshot,
} from '../../../shared-types';
import {
  buildTestGenerationPrompt,
  buildRefinePrompt,
  buildAnalyzePrompt,
  buildHealPrompt,
} from '../prompts/test-generation.prompt';
import { validateAndFixTestCode } from '../utils/test-validator';

@Injectable()
export class GeminiProvider implements AIProvider {
  private readonly model;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.getOrThrow('GEMINI_API_KEY');
    const genAI = new GoogleGenerativeAI(apiKey);
    // gemini-2.5-flash — full flash model, much better code quality than
    // flash-lite and still on the free tier. Upgrade path: gemini-2.5-pro
    // (lower quota) or Claude Haiku via Anthropic API (paid, best quality).
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  }

  /**
   * Wraps model.generateContent() with retry on transient errors:
   * - 503 Service Unavailable (Gemini overloaded — common at peak hours)
   * - 429 Too Many Requests (rate limit)
   * - network errors (5xx-class fetch failures)
   *
   * Exponential backoff: 1s, 2s, 4s. Total max wait ~7s before failing.
   * If still failing, surface a friendly error so heal-loop can decide
   * whether to retry locally.
   */
  private async generateContentWithRetry(
    request: Parameters<typeof this.model.generateContent>[0],
  ): Promise<Awaited<ReturnType<typeof this.model.generateContent>>> {
    // 5 attempts with 1s, 2s, 4s, 8s = up to ~15s total wait before failing.
    // Gemini Flash 503s during peak hours are real and can last >10s.
    const MAX_ATTEMPTS = 5;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.model.generateContent(request);
      } catch (err) {
        lastErr = err;
        const status = (err as { status?: number })?.status;
        const isRetryable =
          status === 503 || status === 429 || status === 500 || status === 502;
        if (!isRetryable || attempt === MAX_ATTEMPTS) break;
        const delayMs = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s, 8s
        console.warn(
          `[gemini] ${status} on attempt ${attempt}/${MAX_ATTEMPTS}, retrying in ${delayMs}ms`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    const status = (lastErr as { status?: number })?.status;
    if (status === 503) {
      throw new Error(
        'Gemini está sobrecargado en este momento (503). Intenta de nuevo en 1-2 minutos.',
      );
    }
    if (status === 429) {
      throw new Error(
        'Cuota de Gemini agotada (429). Revisa los límites del API key.',
      );
    }
    throw lastErr;
  }

  async generateTestCases(
    request: AIGenerateRequest,
  ): Promise<AIGeneratedTestCase[]> {
    const prompt = buildTestGenerationPrompt(request);

    const result = await this.generateContentWithRetry({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    });

    const responseText = result.response.text();

    try {
      const parsed = JSON.parse(responseText);
      const testCases: AIGeneratedTestCase[] = Array.isArray(parsed)
        ? parsed
        : parsed.test_cases || [];

      // Validate + auto-fix every generated snippet. Drop any that still
      // don't compile after sanitization so the user never downloads a
      // spec that will throw SyntaxError.
      const validated: AIGeneratedTestCase[] = [];
      for (const tc of testCases) {
        const result = validateAndFixTestCode(tc.playwright_code || '');
        if (result.valid && result.fixed) {
          validated.push({ ...tc, playwright_code: result.fixed });
        } else {
          console.warn(
            `[AI] Dropping invalid test "${tc.title}": ${result.errors.join('; ')}`,
          );
        }
      }
      return validated;
    } catch {
      throw new Error(
        `Failed to parse AI response as JSON: ${responseText.substring(0, 200)}`,
      );
    }
  }

  async refineTestCase(
    currentCode: string,
    feedback: string,
    liveDomSnapshot?: string,
  ): Promise<string> {
    const prompt = buildRefinePrompt(currentCode, feedback, liveDomSnapshot);

    const result = await this.generateContentWithRetry({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    });

    const raw = result.response.text();
    // Validate with the TS compiler — a refined test with syntax errors
    // is worse than no refinement. If invalid, keep the original code.
    const validation = validateAndFixTestCode(raw);
    if (!validation.valid) {
      throw new Error(
        `Refined test has syntax errors: ${validation.errors.join('; ')}`,
      );
    }
    return validation.fixed!;
  }

  async completeSingleTest(
    request: AICompleteTestRequest,
    liveDomSnapshot?: string,
  ): Promise<AIGeneratedTestCase> {
    const domSection = liveDomSnapshot
      ? `

========================================
LIVE DOM SNAPSHOT — GROUND TRUTH
========================================
This snapshot was fetched LIVE from the target page seconds ago. Every
input, button, link, label, placeholder and id below is REAL. Copy the
attributes VERBATIM.

${liveDomSnapshot}
========================================

CRITICAL — SELECTOR RULES:
1. PROHIBITED: inventing placeholders, labels, button text, CSS classes,
   data-test attributes that DO NOT appear above.
2. SELECTOR PREFERENCE:
   a. data-testid="X" → page.getByTestId('X')
   b. input name="X"  → page.locator('input[name="X"]')
   c. element id="X"  → page.locator('#X')
   d. placeholder="X" → page.getByPlaceholder('X') VERBATIM
   e. button text "X" → page.getByRole('button', { name: 'X' }) VERBATIM
   f. label "X"       → page.getByLabel('X') VERBATIM
3. POST-SUBMIT ERROR / VALIDATION MESSAGES that may NOT be in the snapshot:
   use a wide text regex, NEVER invent CSS classes:
     page.locator('text=/correo|email|inv[aá]lid|invalid|incorrecto|incorrect/i').first()
4. URL ASSERTIONS: regex on path ONLY, no absolute strings.
   WRONG: expect(page).toHaveURL('https://example.com/x/')
   RIGHT: expect(page).toHaveURL(/\\/x\\/?$/)
`
      : '';

    const prompt = `You are an expert QA automation engineer. Generate ONE complete Playwright TypeScript test case.

USER REQUEST:
- Description: ${request.description}
- Test type: ${request.test_type}
- Priority: ${request.priority || 'medium'}
${request.title ? `- Suggested title: ${request.title}` : ''}
${request.base_url ? `- Base URL: ${request.base_url}` : ''}
${domSection}
SYNTAX RULES (MUST FOLLOW — parsed by TypeScript compiler; invalid tests are DROPPED):
- Regex literals: ONLY valid JavaScript regex. NEVER put characters after the closing /. WRONG: /.*foo/.*/  CORRECT: /.*foo.*/
- Escape forward slashes inside regex patterns. WRONG: /path/to/ CORRECT: /path\\/to/
- Balance every quote, backtick, paren, brace, bracket. Never leave \${ unclosed.
- No markdown fences, no triple-backtick blocks in playwright_code.
- No export statements. No imports other than @playwright/test.
- The playwright_code MUST contain at least one test(...) call.
- NAVIGATION: Always use RELATIVE paths in page.goto() calls. NEVER hardcode absolute URLs. The baseURL is set in playwright.config.ts and prepended automatically.

OUTPUT FORMAT:
Return a single JSON object (NOT an array) with this exact shape:
{
  "title": "concise test title",
  "description": "what this test verifies",
  "test_type": "${request.test_type}",
  "priority": "${request.priority || 'medium'}",
  "tags": ["tag1", "tag2"],
  "playwright_code": "import { test, expect } from '@playwright/test';\\n\\ntest('...', async ({ page }) => {\\n  // ...\\n});",
  "browser_targets": ["chromium"]
}`;

    const result = await this.generateContentWithRetry({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    });

    const responseText = result.response.text();
    let parsed: AIGeneratedTestCase;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      throw new Error(
        `AI returned invalid JSON: ${responseText.substring(0, 200)}`,
      );
    }

    const validation = validateAndFixTestCode(parsed.playwright_code || '');
    if (!validation.valid) {
      throw new Error(
        `Generated test has syntax errors: ${validation.errors.join('; ')}`,
      );
    }

    return { ...parsed, playwright_code: validation.fixed! };
  }

  /**
   * Heal a test that just failed at runtime. Receives the real DOM captured
   * by Playwright at the failure moment and the error message; returns
   * regenerated code that uses selectors confirmed to exist in that DOM.
   */
  async healTestCase(args: {
    currentCode: string;
    iteration: number;
    maxIterations: number;
    errorMessage: string;
    failingSelector?: string;
    domSnapshot: string;
    structuredSnapshot?: HealDomSnapshot;
    failureUrl?: string;
    priorFailedSelectors?: string[];
  }): Promise<string> {
    const basePrompt = buildHealPrompt(args);

    // Retry loop for syntax errors: Gemini sometimes emits invalid regex
    // (unterminated literals, escaped slashes wrong, etc.). When the TS
    // compiler validator rejects, ask again with explicit feedback citing
    // the exact error message so the model can self-correct.
    const MAX_SYNTAX_RETRIES = 2;
    let lastErrors: string[] = [];

    for (let attempt = 0; attempt <= MAX_SYNTAX_RETRIES; attempt++) {
      const prompt =
        attempt === 0
          ? basePrompt
          : `${basePrompt}\n\n========================================\nPREVIOUS ATTEMPT WAS SYNTACTICALLY INVALID — DO NOT REPEAT\n========================================\nThe TypeScript compiler rejected your last output with these errors:\n${lastErrors.map((e) => `  - ${e}`).join('\n')}\n\nCheck especially:\n- Regex literals: never put characters after the closing /. e.g. WRONG: /foo/.*/  CORRECT: /foo.*/\n- Escape forward slashes inside regex patterns: WRONG /path/to/  CORRECT /path\\/to/\n- Balance every quote, backtick, paren, brace, bracket\n- No markdown fences\nReturn ONLY the corrected TypeScript code.`;

      const result = await this.generateContentWithRetry({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          // Slightly higher temperature on retry so we don't get the same
          // bad output. Initial pass stays low (0.15) for fidelity to DOM.
          temperature: attempt === 0 ? 0.15 : 0.25,
          maxOutputTokens: 4096,
        },
      });

      const raw = result.response.text();
      const validation = validateAndFixTestCode(raw);
      if (validation.valid) {
        // The validator strips the @playwright/test import as part of
        // sanitization (older callers re-add it). The heal flow ships
        // the code straight to disk on the user's machine, so we must
        // ensure the import is present before returning. Without it the
        // user sees `ReferenceError: test is not defined` on retry.
        return ensurePlaywrightImport(validation.fixed!);
      }

      lastErrors = validation.errors;
      console.warn(
        `[heal] syntax retry ${attempt + 1}/${MAX_SYNTAX_RETRIES + 1}: ${lastErrors.join('; ')}`,
      );
    }

    throw new Error(
      `Healed test still has syntax errors after ${MAX_SYNTAX_RETRIES + 1} attempts: ${lastErrors.join('; ')}`,
    );
  }

  async analyzeUrl(url: string, pageData: string): Promise<string> {
    const prompt = buildAnalyzePrompt(url, pageData);

    const result = await this.generateContentWithRetry({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
    });

    return result.response.text();
  }
}

/**
 * Ensure the snippet starts with `import { test, expect } from '@playwright/test';`.
 * The validator strips this import during sanitization; for heal output we
 * need it to be present so the file can run as-is on the user's machine.
 */
function ensurePlaywrightImport(code: string): string {
  if (/from\s+['"]@playwright\/test['"]/.test(code)) return code;
  return `import { test, expect } from '@playwright/test';\n${code}`;
}
