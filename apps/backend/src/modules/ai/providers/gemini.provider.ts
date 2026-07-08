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

// Candidatos GRATIS de OpenRouter, EN ORDEN de preferencia. Los modelos :free
// ROTAN (caso real: deepseek-chat-v3:free pasó a pago y daba 404) — por eso NO
// se fija uno: se intenta esta lista, filtrada/completada con la lista EN VIVO
// de modelos gratis de OpenRouter (endpoint público, cacheado 1h). Es el mismo
// enfoque de herramientas tipo OpenCode: nunca dependen de un solo slug.
// OPENROUTER_MODEL (env) se antepone como primera preferencia si está definido.
const OPENROUTER_FREE_PREFERRED = [
  'qwen/qwen3-coder:free',
  'openai/gpt-oss-120b:free',
  'meta-llama/llama-3.3-70b-instruct:free',
  'qwen/qwen3-next-80b-a3b-instruct:free',
];
// Máximo de modelos de OpenRouter a intentar por llamada (acota la latencia).
const OPENROUTER_MAX_TRIES = 3;
// Modelos de Groq en orden (también los retiran de a poco — lista, no slug fijo).
// gpt-oss-120b primero: MUCHO mejor siguiendo instrucciones largas/JSON que
// llama-3.3 (caso real: el chat de ventas con llama caía en respuestas
// plantilla repetidas y no registraba el draft), misma velocidad de Groq.
const GROQ_MODELS = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'llama-3.1-8b-instant'];

@Injectable()
export class GeminiProvider implements AIProvider {
  private readonly model;
  private readonly fallbackModel;
  private readonly embedModel;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.getOrThrow('GEMINI_API_KEY');
    const genAI = new GoogleGenerativeAI(apiKey);
    // Primary: gemini-2.5-flash — full flash model, much better code quality
    // than flash-lite and still on the free tier.
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
    // Fallback: gemini-2.5-flash-lite — el modelo GRATIS con MÁS cuota del tier
    // free de Gemini (más RPM/día que flash). Pool separado del 2.5-flash →
    // respaldo real. (2.5-pro daba 429 siempre en free; 2.0-flash también quedó
    // con cuota recortada — casos reales del diagnóstico.)
    this.fallbackModel = genAI.getGenerativeModel({ model: 'gemini-2.5-flash-lite' });
    // Embeddings para el RAG de ventas — 768 dims, capa gratuita. Misma key,
    // sin dependencia nueva.
    this.embedModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });
  }

  /**
   * Embeddings (768 dims) para el RAG. batchEmbedContents mete todos los
   * fragmentos en UNA llamada — clave para no gastar cuota gratuita al indexar
   * un brief entero. Devuelve un vector por texto, en el mismo orden.
   */
  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const res = await this.embedModel.batchEmbedContents({
      requests: texts.map((text) => ({
        content: { role: 'user', parts: [{ text }] },
      })),
    });
    return res.embeddings.map((e) => e.values);
  }

  // Lista EN VIVO de modelos :free de OpenRouter (endpoint público, sin key),
  // cacheada 1h. Si el fetch falla, se usa la lista preferida tal cual.
  private orFreeCache: { ts: number; ids: Set<string> } | null = null;

  private async getOpenRouterCandidates(): Promise<string[]> {
    const envModel = this.configService.get<string>('OPENROUTER_MODEL');
    const preferred = [...(envModel ? [envModel] : []), ...OPENROUTER_FREE_PREFERRED];

    if (!this.orFreeCache || Date.now() - this.orFreeCache.ts > 60 * 60_000) {
      try {
        const res = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(6_000) });
        if (res.ok) {
          const json = (await res.json()) as { data?: { id: string }[] };
          this.orFreeCache = {
            ts: Date.now(),
            ids: new Set((json.data ?? []).map((m) => m.id).filter((id) => id.endsWith(':free'))),
          };
        }
      } catch {
        // sin red / lento → seguimos con la lista estática
      }
    }

    const live = this.orFreeCache?.ids;
    if (!live?.size) return preferred.slice(0, OPENROUTER_MAX_TRIES);
    // Preferidos que SIGUEN gratis hoy + completar con otros gratis en vivo.
    const stillFree = preferred.filter((m) => live.has(m) || !m.endsWith(':free')); // un env model pago se respeta
    const extras = [...live].filter((m) => !stillFree.includes(m));
    return [...stillFree, ...extras].slice(0, OPENROUTER_MAX_TRIES);
  }

  /** Intenta OpenRouter con la lista de modelos gratis (en orden) hasta que uno
   *  responda. Los :free rotan — un solo slug fijo es frágil (caso real: 404
   *  "This model is unavailable for free"). */
  private async tryOpenRouter(
    orKey: string,
    request: Parameters<typeof this.model.generateContent>[0],
    failures: { provider: string; status?: number; message: string }[],
  ): Promise<Awaited<ReturnType<typeof this.model.generateContent>> | null> {
    const candidates = await this.getOpenRouterCandidates();
    for (const model of candidates) {
      const resp = await callOpenAICompatible({
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: orKey,
        model,
        request: request as OpenAICompatCall['request'],
      });
      if (resp.ok && resp.value) {
        return resp.value as Awaited<ReturnType<typeof this.model.generateContent>>;
      }
      failures.push({ provider: `openrouter:${model}`, status: resp.error?.status, message: resp.error?.message || 'unknown' });
      console.warn(`[openrouter:${model}] failed: ${resp.error?.message}`);
    }
    return null;
  }

  /** Intenta Groq con su lista de modelos (en orden) hasta que uno responda.
   *  Groq también retira modelos — misma estrategia de lista. */
  private async tryGroq(
    groqKey: string,
    request: Parameters<typeof this.model.generateContent>[0],
    failures: { provider: string; status?: number; message: string }[],
  ): Promise<Awaited<ReturnType<typeof this.model.generateContent>> | null> {
    const envModel = this.configService.get<string>('GROQ_MODEL');
    const models = [...new Set([...(envModel ? [envModel] : []), ...GROQ_MODELS])];
    for (const model of models) {
      const resp = await callOpenAICompatible({
        baseUrl: 'https://api.groq.com/openai/v1',
        apiKey: groqKey,
        model,
        request: request as OpenAICompatCall['request'],
      });
      if (resp.ok && resp.value) {
        return resp.value as Awaited<ReturnType<typeof this.model.generateContent>>;
      }
      failures.push({ provider: `groq:${model}`, status: resp.error?.status, message: resp.error?.message || 'unknown' });
      console.warn(`[groq:${model}] failed: ${resp.error?.message}`);
    }
    return null;
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
    opts: { attemptTimeoutMs?: number; primaryAttempts?: number; useProFallback?: boolean; preferGroq?: boolean } = {},
  ): Promise<Awaited<ReturnType<typeof this.model.generateContent>>> {
    // Cascade — every configured provider gets a shot before we surface
    // the error. Strategy:
    //   1. gemini-2.5-flash      — 4 attempts, exponential backoff
    //   2. gemini-2.5-pro        — 2 attempts (separate quota pool)
    //   3. Groq Llama 3.3 70B    — 1 attempt (if GROQ_API_KEY)
    //   4. DeepSeek-V3           — 1 attempt (if DEEPSEEK_API_KEY)
    //
    // Critical: once a provider FAILS for ANY reason — quota, network,
    // overload, malformed response — we move on to the next one. The
    // user does not get blocked because Gemini hit a 429 if Groq is
    // configured and healthy. We only surface an error if EVERY
    // configured provider fails, and the message tells them why.
    type Failure = { provider: string; status?: number; message: string };
    const failures: Failure[] = [];

    const isQuotaOrOverload = (s?: number) =>
      s === 503 || s === 429 || s === 502 || s === 500;

    const groqKey = this.configService.get<string>('GROQ_API_KEY');
    let groqTried = false;

    // ── Step 0: Groq PRIMERO (preferGroq) — para el chat interactivo. Groq
    // (Llama 3.3 70B) es rápido y estable; el Gemini gratis es el que se
    // satura/cuelga. Probar Groq primero da respuesta en ~1-2s y evita perder
    // 12-24s en un Gemini colgado. Si Groq falla, sigue la cascada normal.
    if (opts.preferGroq && groqKey) {
      const r = await this.tryGroq(groqKey, request, failures);
      if (r) return r;
      groqTried = true;
    }

    // ── Step 1: gemini-2.5-flash ────────────────────────────────────
    // attemptTimeoutMs: si el modelo se CUELGA (no responde), lo tratamos como
    // fallo y pasamos al siguiente proveedor — un cuelgue no lanza error solo,
    // así que sin esto la cascada nunca llegaba a Groq/DeepSeek (bug real del
    // chat de ventas: se quedaba "Pensando" sin fin en vez de caer al respaldo).
    const PRIMARY_ATTEMPTS = opts.primaryAttempts ?? 4;
    for (let attempt = 1; attempt <= PRIMARY_ATTEMPTS; attempt++) {
      try {
        // timeout del SDK: cancela DE VERDAD la petición (aborta el fetch) al
        // vencer — así un Gemini colgado no queda corriendo en segundo plano
        // manteniendo viva la función serverless y retrasando la respuesta.
        return await this.model.generateContent(request, opts.attemptTimeoutMs ? { timeout: opts.attemptTimeoutMs } : {});
      } catch (err) {
        const status = (err as { status?: number })?.status;
        const message = err instanceof Error ? err.message : String(err);
        const isRetryable = isQuotaOrOverload(status);
        if (!isRetryable || attempt === PRIMARY_ATTEMPTS) {
          failures.push({ provider: 'gemini-flash', status, message });
          break;
        }
        const delayMs = 1000 * Math.pow(2, attempt - 1);
        console.warn(
          `[gemini-flash] ${status} on attempt ${attempt}/${PRIMARY_ATTEMPTS}, retrying in ${delayMs}ms`,
        );
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }

    // ── Step 2: gemini-2.5-pro ──────────────────────────────────────
    // Se puede saltar (useProFallback:false) — para el chat de ventas conviene
    // caer directo a Groq (otro proveedor) en vez de reintentar el mismo Gemini
    // que probablemente también está saturado.
    if (opts.useProFallback !== false) {
      const FALLBACK_ATTEMPTS = 2;
      console.warn(`[ai] -flash failed, trying -pro`);
      for (let attempt = 1; attempt <= FALLBACK_ATTEMPTS; attempt++) {
        try {
          return await this.fallbackModel.generateContent(request, opts.attemptTimeoutMs ? { timeout: opts.attemptTimeoutMs } : {});
        } catch (err) {
          const status = (err as { status?: number })?.status;
          const message = err instanceof Error ? err.message : String(err);
          if (attempt === FALLBACK_ATTEMPTS || !isQuotaOrOverload(status)) {
            failures.push({ provider: 'gemini-flash-lite', status, message });
            break;
          }
          const delayMs = 2000 * attempt;
          console.warn(
            `[gemini-flash-lite] ${status} on attempt ${attempt}/${FALLBACK_ATTEMPTS}, retrying in ${delayMs}ms`,
          );
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }

    // ── Step 3: Groq (si no se probó ya en el Step 0) ───────────────
    if (groqKey && !groqTried) {
      console.warn('[ai] -pro failed, trying Groq');
      const r = await this.tryGroq(groqKey, request, failures);
      if (r) return r;
    }

    // ── Step 4: OpenRouter (GRATIS) — lista dinámica de modelos :free con
    // fallback entre ellos (los :free rotan; ver tryOpenRouter). Requiere
    // OPENROUTER_API_KEY (gratis en openrouter.ai).
    const orKey = this.configService.get<string>('OPENROUTER_API_KEY');
    if (orKey) {
      console.warn('[ai] groq failed/missing, trying OpenRouter (lista de modelos gratis)');
      const r = await this.tryOpenRouter(orKey, request, failures);
      if (r) return r;
    }

    // ── All providers exhausted — build a helpful error ─────────────
    throw buildExhaustedError(failures);
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
    const basePrompt = buildRefinePrompt(currentCode, feedback, liveDomSnapshot);

    // Same syntax-retry pattern as completeSingleTest / healTestCase.
    const MAX_SYNTAX_RETRIES = 2;
    let lastErrors: string[] = [];

    for (let attempt = 0; attempt <= MAX_SYNTAX_RETRIES; attempt++) {
      const prompt =
        attempt === 0
          ? basePrompt
          : `${basePrompt}\n\nPREVIOUS ATTEMPT WAS SYNTACTICALLY INVALID. Errors:\n${lastErrors.map((e) => `  - ${e}`).join('\n')}\n\nReturn ONLY corrected TypeScript code.`;

      const result = await this.generateContentWithRetry({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: attempt === 0 ? 0.2 : 0.3,
          maxOutputTokens: 4096,
        },
      });

      const raw = result.response.text();
      const validation = validateAndFixTestCode(raw);
      if (validation.valid) return validation.fixed!;

      lastErrors = validation.errors;
      console.warn(
        `[refine] syntax retry ${attempt + 1}/${MAX_SYNTAX_RETRIES + 1}: ${lastErrors.join('; ')}`,
      );
    }

    throw new Error(
      `Refined test has syntax errors after ${MAX_SYNTAX_RETRIES + 1} attempts: ${lastErrors.join('; ')}`,
    );
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
   b. element id="X"  → page.locator('#X')   ← ALWAYS unique on a page
   c. input name="X"  → page.locator('input[name="X"]')   ← ONLY if not flagged DUPLICATE
   d. placeholder="X" → page.getByPlaceholder('X') VERBATIM
   e. button text "X" → page.getByRole('button', { name: 'X' }) VERBATIM
   f. label "X"       → page.getByLabel('X') VERBATIM
3. STRICT-MODE / DUPLICATE-NAME RULE — Playwright fails loudly on locators
   that match multiple elements. If the snapshot above flags an element as
   ⚠️DUPLICATE-NAME (i.e. multiple inputs share the same \`name\`), you
   MUST NOT use \`input[name="X"]\` directly. Disambiguate by:
     a. Use the unique \`id\` if present:        page.locator('#user-5ca830f')
     b. Use accessible name via getByRole:      page.getByRole('textbox', { name: 'Email Address' })
     c. Use a unique placeholder/label if any:  page.getByLabel('Email Address')
     d. Last resort, .first() / .nth(N) when the rest of the test makes
        the index obvious — but explain in a comment why.
4. POST-SUBMIT ERROR / VALIDATION MESSAGES that may NOT be in the snapshot:
   use a wide text regex, NEVER invent CSS classes:
     page.locator('text=/correo|email|inv[aá]lid|invalid|incorrecto|incorrect/i').first()
5. URL ASSERTIONS: regex on path ONLY, no absolute strings.
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

    // Retry loop on syntax errors — same pattern as healTestCase. Gemini
    // sometimes emits invalid TS (unterminated regex, missing argument,
    // unclosed brace) on the first try. We give it 2 more shots with
    // explicit feedback before giving up.
    const MAX_SYNTAX_RETRIES = 2;
    let lastErrors: string[] = [];
    let parsed: AIGeneratedTestCase | null = null;

    for (let attempt = 0; attempt <= MAX_SYNTAX_RETRIES; attempt++) {
      const promptForAttempt =
        attempt === 0
          ? prompt
          : `${prompt}\n\n========================================\nPREVIOUS ATTEMPT WAS SYNTACTICALLY INVALID — DO NOT REPEAT\n========================================\nThe TypeScript compiler rejected your last output with these errors:\n${lastErrors.map((e) => `  - ${e}`).join('\n')}\n\nCheck especially:\n- Regex literals: never put characters after the closing /. e.g. WRONG: /foo/.*/  CORRECT: /foo.*/\n- Escape forward slashes inside regex patterns\n- Balance every quote, backtick, paren, brace, bracket\n- No markdown fences\n- Always close every test() and test.step() callback\nReturn ONLY the JSON object with the corrected playwright_code.`;

      const result = await this.generateContentWithRetry({
        contents: [{ role: 'user', parts: [{ text: promptForAttempt }] }],
        generationConfig: {
          temperature: attempt === 0 ? 0.2 : 0.3,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
        },
      });

      const responseText = result.response.text();
      let candidate: AIGeneratedTestCase;
      try {
        candidate = JSON.parse(responseText);
      } catch {
        lastErrors = [`invalid JSON: ${responseText.substring(0, 100)}`];
        console.warn(
          `[completeSingleTest] JSON parse retry ${attempt + 1}/${MAX_SYNTAX_RETRIES + 1}`,
        );
        continue;
      }

      const validation = validateAndFixTestCode(
        candidate.playwright_code || '',
      );
      if (validation.valid) {
        parsed = { ...candidate, playwright_code: validation.fixed! };
        break;
      }

      lastErrors = validation.errors;
      console.warn(
        `[completeSingleTest] syntax retry ${attempt + 1}/${MAX_SYNTAX_RETRIES + 1}: ${lastErrors.join('; ')}`,
      );
    }

    if (!parsed) {
      throw new Error(
        `Generated test has syntax errors after ${MAX_SYNTAX_RETRIES + 1} attempts: ${lastErrors.join('; ')}`,
      );
    }

    return parsed;
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
    // Control de la cascada para llamadas interactivas (chat de ventas): timeout
    // por intento para caer rápido al respaldo si Gemini se cuelga, menos
    // reintentos de Gemini, y saltar -pro para ir directo a Groq.
    cascade?: { attemptTimeoutMs?: number; primaryAttempts?: number; useProFallback?: boolean; preferGroq?: boolean };
  }): Promise<string> {
    const result = await this.generateContentWithRetry({
      contents: [{ role: 'user', parts: [{ text: args.prompt }] }],
      generationConfig: {
        temperature: args.temperature ?? 0.3,
        maxOutputTokens: args.maxOutputTokens ?? 4096,
        responseMimeType: args.responseMimeType,
      },
    }, args.cascade);
    return result.response.text();
  }

  /** Diagnóstico: pinguea cada proveedor por separado (generación mínima) y
   *  reporta cuál responde y en cuánto. Alimenta el endpoint GET /ai/health,
   *  para ver EN VIVO si Gemini está saturado y si Groq/DeepSeek responden. */
  async checkProviders(): Promise<
    Array<{ provider: string; configured: boolean; ok: boolean; ms: number | null; error?: string }>
  > {
    const req = {
      contents: [{ role: 'user', parts: [{ text: 'Responde solo con: OK' }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 8 },
    } as Parameters<typeof this.model.generateContent>[0];

    const time = async (provider: string, run: () => Promise<unknown>) => {
      const t0 = Date.now();
      try {
        await run();
        return { provider, configured: true, ok: true, ms: Date.now() - t0 };
      } catch (e) {
        const ms = Date.now() - t0;
        // Nunca dejar el error vacío (antes a veces no mostraba nada). Si tardó
        // ~15s, casi seguro fue timeout (el modelo tarda, no está roto).
        const raw = (e instanceof Error ? e.message : String(e)).trim();
        const msg = raw || (ms >= 14_000 ? 'timeout: no respondió a tiempo (el modelo tarda demasiado)' : 'error desconocido (sin mensaje)');
        return { provider, configured: true, ok: false, ms, error: msg.slice(0, 200) };
      }
    };

    const groqKey = this.configService.get<string>('GROQ_API_KEY');
    const orKey = this.configService.get<string>('OPENROUTER_API_KEY');
    const pingOpenAI = (provider: string, baseUrl: string, apiKey: string, model: string) =>
      time(provider, async () => {
        const r = await callOpenAICompatible({ baseUrl, apiKey, model, request: req as OpenAICompatCall['request'] });
        if (!r.ok) throw new Error(r.error?.message ?? 'sin respuesta');
      });

    // El ping de OpenRouter hace LO MISMO que la cascada real: prueba los
    // candidatos en orden hasta que uno responda, y reporta CUÁL respondió.
    // Antes pingueaba solo el primero y daba falso "falla" cuando ese estaba
    // rate-limited temporalmente (caso real: qwen3-coder:free con 429 upstream
    // mientras gpt-oss-120b:free respondía perfecto).
    const orCandidates = orKey ? await this.getOpenRouterCandidates() : [];
    const pingOpenRouter = async () => {
      const t0 = Date.now();
      let lastErr = 'sin candidatos';
      for (const model of orCandidates) {
        const r = await callOpenAICompatible({
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: orKey!,
          model,
          request: req as OpenAICompatCall['request'],
        });
        if (r.ok) return { provider: `openrouter (${model})`, configured: true, ok: true, ms: Date.now() - t0 };
        lastErr = `${model}: ${r.error?.message ?? 'sin respuesta'}`;
      }
      return { provider: 'openrouter', configured: true, ok: false, ms: Date.now() - t0, error: lastErr.slice(0, 200) };
    };

    // timeout del SDK (15s) para los pings de Gemini — aborta de verdad, sin dejar
    // la petición colgada. 15s porque el Gemini gratis a veces tarda >8s aun
    // funcionando. Groq/OpenRouter abortan solos en callOpenAICompatible.
    // Todos GRATIS: gemini-2.5-flash, gemini-2.5-flash-lite, groq, openrouter.
    return Promise.all([
      time('gemini-flash', () => this.model.generateContent(req, { timeout: 15_000 })),
      time('gemini-flash-lite', () => this.fallbackModel.generateContent(req, { timeout: 15_000 })),
      groqKey
        ? pingOpenAI(`groq (${GROQ_MODELS[0]})`, 'https://api.groq.com/openai/v1', groqKey, GROQ_MODELS[0])
        : Promise.resolve({ provider: 'groq', configured: false, ok: false, ms: null }),
      orKey && orCandidates.length
        ? pingOpenRouter()
        : Promise.resolve({ provider: 'openrouter', configured: false, ok: false, ms: null }),
    ]);
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

/**
 * Compose a user-friendly error from the per-provider failure list. The
 * goal: tell the user EXACTLY why we gave up — quota everywhere, or one
 * specific provider broken, or all overloaded — so they know whether to
 * retry, configure another key, or just wait.
 */
type ProviderFailure = { provider: string; status?: number; message: string };

function buildExhaustedError(failures: ProviderFailure[]): Error {
  if (failures.length === 0) {
    return new Error('No AI providers were attempted (this should not happen).');
  }

  const isQuota = (f: ProviderFailure) =>
    f.status === 429 || /quota|rate.?limit|exhaust/i.test(f.message);
  const isOverload = (f: ProviderFailure) =>
    f.status === 503 || f.status === 502 || /overload|sobrecarg/i.test(f.message);
  const isAuth = (f: ProviderFailure) =>
    f.status === 401 || f.status === 403 || /api.?key|invalid.?key|forbidden/i.test(f.message);

  const allQuota = failures.every(isQuota);
  const allOverload = failures.every(isOverload);
  const allQuotaOrOverload = failures.every((f) => isQuota(f) || isOverload(f));
  const anyAuth = failures.find(isAuth);

  if (allQuota) {
    return new Error(
      `Cuota agotada en TODOS los proveedores AI configurados (${failures.map((f) => f.provider).join(', ')}). Espera al reset diario o configura otro API key (Groq/DeepSeek).`,
    );
  }
  if (allOverload) {
    return new Error(
      `Todos los proveedores AI están sobrecargados (${failures.map((f) => f.provider).join(', ')}). Intenta de nuevo en 5-10 minutos.`,
    );
  }
  if (allQuotaOrOverload) {
    return new Error(
      `Todos los proveedores AI están saturados o agotados. Intenta en 5-10 minutos o espera al reset de cuota. Detalle: ${failures
        .map((f) => `${f.provider}=${f.status || 'err'}`)
        .join(', ')}.`,
    );
  }
  if (anyAuth) {
    return new Error(
      `API key inválida para ${anyAuth.provider} (${anyAuth.status}). Revisa la env var correspondiente en Vercel. Resto de providers también fallaron: ${failures
        .filter((f) => f !== anyAuth)
        .map((f) => `${f.provider}=${f.status || 'err'}`)
        .join(', ')}.`,
    );
  }

  // Mixed bag — surface the last meaningful error
  const last = failures[failures.length - 1];
  return new Error(
    `Todos los proveedores AI fallaron. Último: ${last.provider} → ${last.message}. Detalle completo: ${failures
      .map((f) => `${f.provider}=${f.status || 'err'} (${f.message.slice(0, 60)})`)
      .join(' | ')}.`,
  );
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
  // interno: reintento sin response_format (varios modelos gratis no lo soportan)
  skipJsonFormat = false,
): Promise<OpenAICompatResult> {
  const { baseUrl, apiKey, model, request } = call;
  const prompt = request.contents
    .map((c) => c.parts.map((p) => p.text).join(''))
    .join('\n');
  const cfg = request.generationConfig || {};
  const wantJson = cfg.responseMimeType === 'application/json' && !skipJsonFormat;

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
      // Timeout duro que aborta el fetch: si Groq/DeepSeek se cuelga, no bloquea.
      signal: AbortSignal.timeout(12_000),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, error: { message: `network: ${message}` } };
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    // Varios modelos gratis (sobre todo en OpenRouter) rechazan response_format
    // con 400 — reintentamos UNA vez sin él; el parseo robusto del caller extrae
    // el JSON igual aunque venga con texto/fences alrededor.
    if (resp.status === 400 && wantJson && /response_format|json_object/i.test(text)) {
      return callOpenAICompatible(call, true);
    }
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
