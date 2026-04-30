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
  private readonly fallbackModel;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.getOrThrow('GEMINI_API_KEY');
    const genAI = new GoogleGenerativeAI(apiKey);
    // Primary: gemini-2.5-flash — full flash model, much better code quality
    // than flash-lite and still on the free tier.
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    // Fallback: gemini-2.5-pro — separate quota pool, used when -flash is
    // overloaded (503 spikes during peak hours). Slower + more expensive but
    // capacity is independent. Auto-engaged after retries on -flash exhaust.
    this.fallbackModel = genAI.getGenerativeModel({ model: 'gemini-2.5-pro' });
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
    // Cascade:
    //   1. gemini-2.5-flash, 4 attempts with 1s/2s/4s/8s backoff
    //   2. gemini-2.5-pro,  2 attempts with 2s/4s backoff (separate quota)
    //   3. Groq Llama 3.3 70B (free tier, separate quota, OpenAI-compat)  ← if GROQ_API_KEY
    //   4. DeepSeek-V3 (free tier, top-tier code quality)                 ← if DEEPSEEK_API_KEY
    // Only fall through to the next provider on 503/429/502/500.
    const PRIMARY_ATTEMPTS = 4;
    const FALLBACK_ATTEMPTS = 2;
    let lastErr: unknown;

    for (let attempt = 1; attempt <= PRIMARY_ATTEMPTS; attempt++) {
      try {
        return await this.model.generateContent(request);
      } catch (err) {
        lastErr = err;
        const status = (err as { status?: number })?.status;
        const isRetryable =
          status === 503 || status === 429 || status === 500 || status === 502;
        if (!isRetryable || attempt === PRIMARY_ATTEMPTS) break;
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        console.warn(
          `[gemini-flash] ${status} on attempt ${attempt}/${PRIMARY_ATTEMPTS}, retrying in ${delayMs}ms`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    let lastStatus = (lastErr as { status?: number })?.status;
    const shouldFallback = (s: number | undefined) =>
      s === 503 || s === 429 || s === 502 || s === 500;

    // Step 2 — gemini-pro (separate quota)
    if (shouldFallback(lastStatus)) {
      console.warn(
        `[gemini] -flash exhausted (last ${lastStatus}), falling back to -pro`,
      );
      for (let attempt = 1; attempt <= FALLBACK_ATTEMPTS; attempt++) {
        try {
          return await this.fallbackModel.generateContent(request);
        } catch (err) {
          lastErr = err;
          const status = (err as { status?: number })?.status;
          if (!shouldFallback(status) || attempt === FALLBACK_ATTEMPTS) break;
          const delayMs = 2000 * attempt;
          console.warn(
            `[gemini-pro] ${status} on attempt ${attempt}/${FALLBACK_ATTEMPTS}, retrying in ${delayMs}ms`,
          );
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }

    lastStatus = (lastErr as { status?: number })?.status;

    // Step 3 — Groq (Llama 3.3 70B, free, OpenAI-compatible)
    if (shouldFallback(lastStatus)) {
      const groqKey = this.configService.get<string>('GROQ_API_KEY');
      if (groqKey) {
        console.warn('[gemini] all gemini exhausted, trying Groq');
        const groqResp = await callOpenAICompatible({
          baseUrl: 'https://api.groq.com/openai/v1',
          apiKey: groqKey,
          model: 'llama-3.3-70b-versatile',
          request: request as OpenAICompatCall['request'],
        });
        if (groqResp.ok && groqResp.value) {
          return groqResp.value as Awaited<ReturnType<typeof this.model.generateContent>>;
        }
        lastErr = groqResp.error;
        console.warn(`[groq] failed: ${groqResp.error?.message}`);
      }
    }

    lastStatus = (lastErr as { status?: number })?.status;

    // Step 4 — DeepSeek (DeepSeek-V3, top-tier code, free tier)
    if (shouldFallback(lastStatus) || !lastStatus) {
      const dsKey = this.configService.get<string>('DEEPSEEK_API_KEY');
      if (dsKey) {
        console.warn('[gemini] trying DeepSeek as final fallback');
        const dsResp = await callOpenAICompatible({
          baseUrl: 'https://api.deepseek.com',
          apiKey: dsKey,
          model: 'deepseek-chat',
          request: request as OpenAICompatCall['request'],
        });
        if (dsResp.ok && dsResp.value) {
          return dsResp.value as Awaited<ReturnType<typeof this.model.generateContent>>;
        }
        lastErr = dsResp.error;
        console.warn(`[deepseek] failed: ${dsResp.error?.message}`);
      }
    }

    const finalStatus = (lastErr as { status?: number })?.status;
    if (finalStatus === 503) {
      throw new Error(
        'Todos los proveedores AI están sobrecargados en este momento (503). Intenta de nuevo en 5-10 minutos.',
      );
    }
    if (finalStatus === 429) {
      throw new Error(
        'Cuota agotada en todos los proveedores AI configurados (429). Configura GROQ_API_KEY o DEEPSEEK_API_KEY en Vercel para más capacidad, o espera al reset diario.',
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
SCOPE RULES — STRICTLY FOLLOW THESE (most common reason tests fail):

1. Verify ONLY what the description explicitly asks for. Do NOT add
   additional verification steps the user did not request. If the
   description says "validate that an invalid email shows an error",
   you verify ONLY that — do NOT also try to log in successfully, do
   NOT verify a redirect, do NOT verify the dashboard, do NOT verify
   anything not in the description.

2. NEVER invent credentials, IDs, slugs, product names, prices, or any
   other data the user did not provide. If the test requires real data
   you don't have, the test is OUT OF SCOPE — describe ONLY the part
   you CAN verify with the data provided.

3. NEVER add a "happy path" step alongside a "negative path". If the
   user asked for negative validation (invalid input → error message),
   stop there. Do NOT also test the positive flow.

4. Total flow length: prefer 3-6 actions. Tests longer than that almost
   always include scope creep that wasn't requested.

5. test.step() blocks must each map to something explicitly in the
   description. If you can't tie a step back to a phrase in the user's
   request, delete it.

6. PAGE-INTENT MATCH: the snapshot shows ONE specific page. If the
   description mentions a feature (login form, signup, checkout, search,
   etc.) and that feature is NOT on the snapshot page, do NOT invent
   a test for some unrelated form on the page. Instead, generate a
   minimal test that navigates to the correct path FIRST (e.g.
   page.goto('/login')) and ONLY uses elements that would exist there.
   Better to have the test fail with "no such input on /login" than
   pass-by-accident on the wrong page.

7. HIDDEN ELEMENTS: any item in the snapshot tagged "HIDDEN" (visible=false)
   requires user interaction to become visible (popup trigger, accordion,
   tab, modal). NEVER fill / click / check on a HIDDEN element directly —
   it will TimeoutError every time. Either:
     a) Add the action that exposes it BEFORE interacting (click the
        trigger button by its visible text), then interact.
     b) Skip that scenario entirely if you can't identify the trigger.
   Forms inside popups (e.g. "Book an Appointment", "Schedule") usually
   have HIDDEN inputs/buttons until the popup opens.

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

  /**
   * Low-level helper for callers that need full control over the prompt
   * (e.g. site exploration / suggestions). Skips the test-validator since
   * the response is JSON metadata, not Playwright code.
   */
  async generateRaw(args: {
    prompt: string;
    temperature?: number;
    maxOutputTokens?: number;
    responseMimeType?: 'application/json' | 'text/plain';
  }): Promise<string> {
    const result = await this.generateContentWithRetry({
      contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
      generationConfig: {
        temperature: args.temperature ?? 0.3,
        maxOutputTokens: args.maxOutputTokens ?? 4096,
        responseMimeType: args.responseMimeType,
      },
    });
    return result.response.text();
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

// ─── OpenAI-compatible providers (Groq, DeepSeek, OpenRouter, etc.) ──
//
// Both Groq and DeepSeek expose an OpenAI-compatible chat completions API.
// We extract the prompt + config from the Gemini-shaped request, fire the
// OpenAI-style call, and wrap the response back in Gemini's shape so the
// rest of the codebase doesn't need to know which provider answered.

interface OpenAICompatCall {
  baseUrl: string;
  apiKey: string;
  model: string;
  // Reuse the Gemini-shaped request to avoid duplicate plumbing
  request: {
    contents: Array<{ role: string; parts: Array<{ text: string }> }>;
    generationConfig?: {
      temperature?: number;
      maxOutputTokens?: number;
      responseMimeType?: 'application/json' | 'text/plain';
    };
  };
}

interface FakeGeminiResponse {
  response: { text: () => string };
}

interface OpenAICompatResult {
  ok: boolean;
  value?: FakeGeminiResponse;
  error?: { message: string; status?: number };
}

async function callOpenAICompatible(
  call: OpenAICompatCall,
): Promise<OpenAICompatResult> {
  const { baseUrl, apiKey, model, request } = call;
  const prompt = request.contents
    .map((c) => c.parts.map((p) => p.text).join(''))
    .join('\n');
  const cfg = request.generationConfig || {};
  const wantJson = cfg.responseMimeType === 'application/json';

  let resp: Response;
  try {
    resp = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: cfg.temperature ?? 0.3,
        max_tokens: cfg.maxOutputTokens ?? 4096,
        ...(wantJson ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { message: `network: ${message}` } };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    return {
      ok: false,
      error: { message: `HTTP ${resp.status}: ${text.slice(0, 200)}`, status: resp.status },
    };
  }

  let data: { choices?: Array<{ message?: { content?: string } }> };
  try {
    data = await resp.json();
  } catch (e) {
    return {
      ok: false,
      error: { message: `bad json: ${e instanceof Error ? e.message : ''}` },
    };
  }

  const text = data.choices?.[0]?.message?.content || '';
  if (!text) {
    return { ok: false, error: { message: 'empty response' } };
  }
  return {
    ok: true,
    value: { response: { text: () => text } },
  };
}
