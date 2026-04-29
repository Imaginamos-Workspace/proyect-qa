import { AIGenerateRequest, TestType } from '../../../shared-types';

export function buildTestGenerationPrompt(request: AIGenerateRequest): string {
  const typeInstructions = request.test_types
    .map((t) => getTypeInstructions(t))
    .join('\n\n');

  const pageContext = request.page_analysis
    ? `
PAGE ANALYSIS:
- Title: ${request.page_analysis.title}
- URL: ${request.page_analysis.url}
- Headings: ${JSON.stringify(request.page_analysis.headings)}
- Interactive Elements: ${JSON.stringify(request.page_analysis.interactive_elements.slice(0, 50))}
- Forms: ${JSON.stringify(request.page_analysis.forms)}
- Navigation Links: ${JSON.stringify(request.page_analysis.navigation_links.slice(0, 30))}
- ARIA Landmarks: ${JSON.stringify(request.page_analysis.aria_landmarks)}
- API Endpoints: ${JSON.stringify(request.page_analysis.api_endpoints)}
- Page Routes: ${JSON.stringify(request.page_analysis.page_routes)}
`
    : `URL: ${request.base_url}`;

  return `You are an expert QA automation engineer. Generate Playwright test scripts in TypeScript for the following web application.

${pageContext}

${request.additional_context ? `ADDITIONAL CONTEXT: ${request.additional_context}` : ''}

TEST TYPES TO GENERATE:
${typeInstructions}

REQUIREMENTS:
- Use @playwright/test framework with TypeScript
- Use accessible selectors: getByRole, getByLabel, getByText, getByPlaceholder (prefer over CSS selectors)
- Include proper assertions with expect()
- Handle dynamic content with appropriate waits (auto-waiting is built-in)
- Each test must be independent and self-contained
- Include descriptive test names and comments
- Generate 3-5 tests per test type requested

SCOPE RULES — STRICTLY FOLLOW (most common reason tests fail at runtime):

1. NEVER invent credentials, user IDs, product names, slugs, prices, or
   any data the description does not provide. If a test would need
   real authenticated data you don't have (real email/password, real
   admin user, real product in cart), DO NOT generate it. Skip that
   scenario entirely. Better to ship 3 working tests than 5 with 2
   that fail because they hardcode "test@example.com" / "password123".

2. Each test verifies ONE concrete thing. Do NOT chain a "negative
   path then happy path" inside the same test() — split into separate
   test() calls, and only emit the happy-path test if you have real
   credentials/data for it.

3. If the description says "validate X", you verify X — do NOT also
   verify "the happy path", "the redirect", "the dashboard", or any
   other thing not explicitly requested. Scope creep = test failure.

4. Login flows: only generate a "successful login" test if the user
   provided concrete credentials in additional_context. Otherwise
   ONLY generate negative-path login tests (invalid email format,
   empty fields, wrong password message).

SYNTAX RULES (MUST FOLLOW — the output is parsed with the TypeScript compiler and invalid tests are DROPPED):
- Regex literals: ONLY valid JavaScript regex. NEVER put characters after the closing /. WRONG: /.*foo/.*/  CORRECT: /.*foo.*/
- Regex literals: escape forward slashes inside patterns. WRONG: /path/to/ CORRECT: /path\\/to/
- Strings: always balance quotes. Prefer single quotes unless the string contains one.
- Template literals: balance backticks and \${}. Never leave \${ unclosed.
- Parentheses, braces, brackets: always balanced.
- Semicolons: required at the end of statements inside test callbacks.
- No markdown fences, no triple-backtick blocks anywhere in the playwright_code value.
- No top-level imports other than @playwright/test (the runner adds it automatically — but it's fine if you include it, it will be stripped).
- No export statements in the test code.
- The code MUST contain at least one test(...) call. Do not return bare helper functions.
- Prefer string locators or getByRole over regex whenever possible. Use regex ONLY when you need pattern matching.
- NAVIGATION: Always use RELATIVE paths in page.goto() calls (e.g., page.goto('/'), page.goto('/login'), page.goto('/dashboard')). NEVER hardcode absolute URLs like 'http://localhost:3000/login'. The baseURL is configured in playwright.config.ts and will be prepended automatically.

OUTPUT FORMAT:
Return a JSON array of test cases with this structure:
[
  {
    "title": "descriptive test name",
    "description": "what this test validates",
    "test_type": "e2e|regression|visual|accessibility|performance|api|cross_browser|responsive",
    "priority": "low|medium|high|critical",
    "tags": ["tag1", "tag2"],
    "playwright_code": "import { test, expect } from '@playwright/test';\\n\\ntest('test name', async ({ page }) => {\\n  // test code\\n});",
    "browser_targets": ["chromium"],
    "viewport_config": null
  }
]`;
}

function getTypeInstructions(type: TestType): string {
  const instructions: Record<TestType, string> = {
    e2e: `E2E TESTS:
- Test complete user flows: navigation, form submissions, authentication, CRUD operations
- Verify the happy path and common error scenarios
- Test multi-step workflows end-to-end`,

    regression: `REGRESSION TESTS:
- Test every discovered interactive element functions correctly
- Verify all navigation links work
- Check form validations and error states
- Test edge cases and boundary conditions`,

    visual: `VISUAL REGRESSION TESTS:
- Navigate to each main route and capture full-page screenshots
- Use await expect(page).toHaveScreenshot() for comparison
- Include key states: empty, loaded, error
- Test both light and dark themes if applicable`,

    accessibility: `ACCESSIBILITY TESTS:
- Import and use @axe-core/playwright
- Run axe.check() on each page
- Verify ARIA labels, roles, and landmarks
- Check keyboard navigation and focus management
- Test color contrast and text alternatives
Example:
import AxeBuilder from '@axe-core/playwright';
const results = await new AxeBuilder({ page }).analyze();
expect(results.violations).toEqual([]);`,

    performance: `PERFORMANCE TESTS:
- Measure Core Web Vitals: LCP, FCP, CLS, TTFB
- Use page.evaluate(() => performance.getEntriesByType('navigation'))
- Check page load times are under acceptable thresholds
- Test with network throttling if needed`,

    api: `API TESTS:
- Use Playwright's request API context for direct HTTP testing
- Test GET, POST, PUT, DELETE endpoints
- Verify response status codes, headers, and body structure
- Test error responses and edge cases
Example:
const response = await request.get('/api/endpoint');
expect(response.ok()).toBeTruthy();`,

    cross_browser: `CROSS-BROWSER TESTS:
- Same core tests but annotated for multiple browsers
- Focus on browser-specific rendering issues
- Test CSS features that vary across browsers
- Set browser_targets to ["chromium", "firefox", "webkit"]`,

    responsive: `RESPONSIVE TESTS:
- Test at mobile (375x812), tablet (768x1024), and desktop (1280x800) viewports
- Verify responsive breakpoints
- Test touch interactions for mobile
- Check navigation menu behavior across sizes
- Set viewport_config for each test`,
  };

  return instructions[type];
}

export function buildRefinePrompt(
  currentCode: string,
  feedback: string,
  liveDomSnapshot?: string,
): string {
  const domSection = liveDomSnapshot
    ? `
========================================
LIVE DOM SNAPSHOT — GROUND TRUTH
========================================
This snapshot was fetched LIVE from the target page seconds ago. Every input,
button, link, label, placeholder and id below is REAL — copy them VERBATIM.

${liveDomSnapshot}
========================================

CRITICAL — SELECTOR RULES (failure to follow = test will fail at runtime):

1. PROHIBITED: Inventing placeholders, labels, button texts, CSS classes, or
   data-test attributes that DO NOT appear above. Examples of what NOT to do:
     - WRONG: getByPlaceholder('Correo electrónico') when snapshot says placeholder="Email"
     - WRONG: page.locator('.error-message') when snapshot has no .error-message
     - WRONG: page.locator('[data-test="email-error"]') when no such testid exists.

2. SELECTOR PREFERENCE (in order):
   a. If snapshot lists data-testid="X" → use page.getByTestId('X')
   b. If input has name="X" → use page.locator('input[name="X"]')
   c. If input has id="X" → use page.locator('#X')
   d. If input has placeholder="X" → use page.getByPlaceholder('X') with EXACT text
   e. If button has text "X" → use page.getByRole('button', { name: 'X' }) with EXACT text
   f. For labels: use page.getByLabel('X') with EXACT label text from snapshot

3. ERROR/VALIDATION ELEMENTS NOT IN SNAPSHOT:
   Login error messages typically appear AFTER form submission via JS — they
   may not be in the static snapshot. For these, use a wide locator that
   matches by text content with a regex covering common Spanish/English
   wordings, e.g.:
     page.locator('text=/correo|email|inválid|invalid|incorrecto|incorrect/i').first()
   Do NOT invent CSS classes like .error-message or .alert-danger — they
   probably don't exist on this site.

4. URL ASSERTIONS — use RELATIVE regex, never absolute strings:
   WRONG: await expect(page).toHaveURL('https://example.com/login/')
   RIGHT: await expect(page).toHaveURL(/\\/login\\/?$/)

5. NAVIGATION — use RELATIVE paths only:
   WRONG: await page.goto('https://example.com/login')
   RIGHT: await page.goto('/login')

If the snapshot does not contain a needed element AND it is not a post-submit
error message, KEEP the existing selector from the current code and add a
// TODO comment explaining the gap. NEVER guess.
`
    : '';

  return `You are a Playwright test expert. Refine the following test based on the feedback.

CURRENT TEST CODE:
\`\`\`typescript
${currentCode}
\`\`\`

FEEDBACK:
${feedback}
${domSection}
SCOPE RULES — apply BEFORE you start refining:
- The user's feedback is the ONLY source of new behavior. Do NOT add
  steps, assertions, or scenarios the feedback does not explicitly
  ask for. If the existing test was overscoped (e.g. has a happy-path
  step that uses fake credentials and fails), you MAY remove the
  invented step — but never add new ones the user didn't request.
- NEVER hardcode credentials, IDs, prices, or other data not present
  in the existing test or the feedback. If the test references
  test@example.com / password123 / fake data, that data is suspect
  and must NOT be assumed to be valid on the real site.

SYNTAX RULES (STRICT — your output is parsed with the TypeScript compiler and REJECTED if invalid):
- Regex literals must be valid JavaScript. NEVER put characters after the closing /. WRONG: /.*foo/.*/  CORRECT: /.*foo.*/
- Escape forward slashes inside regex patterns.
- Balance every quote, backtick, paren, brace, bracket. Never leave \${ unclosed.
- No markdown fences or triple-backtick blocks in the response.
- No export statements.
- The code MUST contain at least one test(...) call.
- NAVIGATION: Use RELATIVE paths in page.goto() (e.g., '/login', '/'). NEVER hardcode absolute URLs — baseURL is set in playwright.config.ts.

Return ONLY the refined TypeScript test code, no explanations. Keep the @playwright/test import and test structure.`;
}

/**
 * Self-healing prompt — used when a test that the AI generated FAILED at
 * runtime. The user's local Playwright captured the actual DOM at the
 * failure point and the error message; we feed that GROUND TRUTH back to
 * the AI to regenerate. Because the DOM is captured by the same engine that
 * runs the test, this prompt is far more reliable than scan-based refine.
 */
export function buildHealPrompt(args: {
  currentCode: string;
  iteration: number;
  maxIterations: number;
  errorMessage: string;
  failingSelector?: string;
  domSnapshot: string;
  structuredSnapshot?: import('../../../shared-types').HealDomSnapshot;
  failureUrl?: string;
  priorFailedSelectors?: string[];
}): string {
  const {
    currentCode,
    iteration,
    maxIterations,
    errorMessage,
    failingSelector,
    domSnapshot,
    structuredSnapshot,
    failureUrl,
    priorFailedSelectors,
  } = args;

  const failingLine = failingSelector
    ? `\nFAILING SELECTOR / CALL:\n  ${failingSelector}\n`
    : '';
  const urlLine = failureUrl ? `\nURL AT FAILURE: ${failureUrl}\n` : '';

  // Prefer structured snapshot — it's compact, easy to read, and the AI
  // can quote attribute values directly.
  const groundTruthSection = structuredSnapshot
    ? formatStructuredSnapshot(structuredSnapshot)
    : `Raw HTML (truncated):\n\n${domSnapshot}`;

  const priorBlock =
    priorFailedSelectors && priorFailedSelectors.length > 0
      ? `\n\n========================================\nSELECTORS THAT ALREADY FAILED (DO NOT REUSE)\n========================================\n${priorFailedSelectors.map((s) => `  - ${s}`).join('\n')}\n`
      : '';

  return `You are a Playwright test expert. A test you wrote previously FAILED at runtime in a real browser. Your job is to fix it using the REAL DOM that was captured at the failure moment.

This is heal iteration ${iteration} of ${maxIterations} maximum.

========================================
PREVIOUS TEST CODE (the one that failed)
========================================
\`\`\`typescript
${currentCode}
\`\`\`

========================================
RUNTIME ERROR FROM PLAYWRIGHT
========================================
${errorMessage}
${failingLine}${urlLine}
========================================
ACTUAL DOM AT FAILURE — GROUND TRUTH
========================================
This was captured by Playwright at the EXACT moment of the failure, on
the same engine that will re-run the test. Every attribute and value
below is REAL and PRESENT on the page right now. Quote values verbatim.

${groundTruthSection}
========================================${priorBlock}

CRITICAL HEAL RULES:

1. The selector that failed (\`${failingSelector || 'see error above'}\`) does NOT exist in the DOM above. You MUST replace it with a selector that DOES exist in the DOM above.

2. SELECTOR PRIORITY when picking a replacement (use the FIRST that matches):
   a. data-testid="X"  → page.getByTestId('X')
   b. name="X" on input/textarea/select → page.locator('input[name="X"]') (or textarea/select)
   c. id="X" → page.locator('#X')
   d. placeholder="X" on input → page.getByPlaceholder('X') with EXACT text
   e. button text → page.getByRole('button', { name: 'EXACT TEXT' })
   f. <label> text linked to input → page.getByLabel('EXACT TEXT')
   g. role + accessible name → page.getByRole('role', { name: 'EXACT TEXT' })

3. PROHIBITED:
   - Inventing any attribute that does not appear in the DOM above
   - Using CSS classes (.foo) unless they appear with that exact name in the DOM
   - Guessing placeholder/label text — copy verbatim from DOM
   - Absolute URLs in page.goto — use RELATIVE paths only ('/login' not 'https://...')
   - Absolute URL strings in toHaveURL — use regex like /\\/dashboard\\/?$/

4. POST-SUBMIT ERROR MESSAGES (validation, login errors): these may not be in the captured DOM if the failure happened BEFORE the submit. Use a flexible text regex:
     page.locator('text=/correo|email|inv[aá]lid|invalid|incorrect|wrong/i').first()

5. KEEP everything that was working — only change what the error indicates is broken. Do not rewrite the whole test.

5a. SCOPE GUARD — if the existing test contains a step that uses
    obviously hardcoded fake credentials/data (test@example.com,
    password123, "test", etc.) AND that step is what's failing, the
    correct heal is to REMOVE that step entirely. Do NOT try to make
    it pass by guessing more credentials — those are out of reach
    without real data the user did not provide. Keep the parts that
    DO work (e.g. the negative-path validation), drop the rest.

5b. HIDDEN ELEMENTS — if the failing locator points to an input/button
    that is marked HIDDEN in the DOM snapshot, the element exists but
    is not visible (it's inside a popup/modal/accordion that hasn't
    been opened). NEVER try to interact with a hidden element directly:
    Playwright's auto-wait will timeout. Either:
      a) Insert the trigger action BEFORE the interaction (e.g. click
         the visible button that opens the popup), or
      b) Remove the step entirely if you can't identify the trigger.
    Hidden form inputs are the #1 cause of "element is not visible"
    timeouts — fix this pattern, don't paper over it with retries.

6. SYNTAX RULES (parsed by TS compiler — invalid output is REJECTED):
   - Balance every quote, backtick, paren, brace, bracket
   - Regex literals must be valid — never put characters after closing /
   - No markdown fences, no triple-backtick blocks
   - No export statements; @playwright/test is the only allowed import
   - Must contain at least one test(...) call

OUTPUT: Return ONLY the healed TypeScript code. No explanations, no JSON wrapper, no markdown — just raw .ts code starting with "import { test, expect } from '@playwright/test';".`;
}

/**
 * Format the structured DOM snapshot as a compact, AI-readable section.
 * Inputs/buttons/links each get one line per element with all real
 * attributes, so the AI can pick the best selector at a glance.
 */
function formatStructuredSnapshot(
  s: import('../../../shared-types').HealDomSnapshot,
): string {
  const lines: string[] = [];
  if (s.title) lines.push(`PAGE TITLE: ${s.title}`);
  if (s.headings && s.headings.length) {
    lines.push(`HEADINGS: ${s.headings.slice(0, 5).join(' | ')}`);
  }

  if (s.inputs && s.inputs.length) {
    lines.push('');
    lines.push(`INPUTS (${s.inputs.length}):`);
    for (const i of s.inputs) {
      const attrs: string[] = [];
      if (i.data_testid) attrs.push(`data-testid="${i.data_testid}"`);
      if (i.name) attrs.push(`name="${i.name}"`);
      if (i.id) attrs.push(`id="${i.id}"`);
      if (i.type) attrs.push(`type="${i.type}"`);
      if (i.placeholder) attrs.push(`placeholder="${i.placeholder}"`);
      if (i.aria_label) attrs.push(`aria-label="${i.aria_label}"`);
      if (i.required) attrs.push('required');
      if (i.visible === false) attrs.push('HIDDEN');
      lines.push(`  - <input ${attrs.join(' ')}>`);
    }
  }

  if (s.buttons && s.buttons.length) {
    lines.push('');
    lines.push(`BUTTONS (${s.buttons.length}):`);
    for (const b of s.buttons) {
      const attrs: string[] = [];
      if (b.data_testid) attrs.push(`data-testid="${b.data_testid}"`);
      if (b.id) attrs.push(`id="${b.id}"`);
      if (b.name) attrs.push(`name="${b.name}"`);
      if (b.type) attrs.push(`type="${b.type}"`);
      if (b.aria_label) attrs.push(`aria-label="${b.aria_label}"`);
      if (b.visible === false) attrs.push('HIDDEN');
      const txt = b.text ? ` text="${b.text}"` : '';
      lines.push(`  - <button ${attrs.join(' ')}>${txt}`);
    }
  }

  if (s.forms && s.forms.length) {
    lines.push('');
    lines.push(`FORMS (${s.forms.length}):`);
    for (const f of s.forms) {
      const attrs: string[] = [];
      if (f.id) attrs.push(`id="${f.id}"`);
      if (f.action) attrs.push(`action="${f.action}"`);
      if (f.method) attrs.push(`method="${f.method}"`);
      lines.push(`  - <form ${attrs.join(' ')}>`);
    }
  }

  if (s.links && s.links.length) {
    lines.push('');
    lines.push(`LINKS (first 20 of ${s.links.length}):`);
    for (const l of s.links.slice(0, 20)) {
      const attrs: string[] = [];
      if (l.data_testid) attrs.push(`data-testid="${l.data_testid}"`);
      if (l.href) attrs.push(`href="${l.href}"`);
      const txt = l.text ? ` text="${l.text}"` : '';
      lines.push(`  - <a ${attrs.join(' ')}>${txt}`);
    }
  }

  if (s.visible_messages && s.visible_messages.length) {
    lines.push('');
    lines.push('VISIBLE MESSAGES (alerts/errors/aria-live):');
    for (const m of s.visible_messages.slice(0, 10)) {
      lines.push(`  - "${m}"`);
    }
  }

  return lines.join('\n');
}

/**
 * Site exploration prompt — used by /ai/suggest-explore. The platform
 * scans multiple pages of the configured site and feeds compact DOM
 * summaries to Gemini, which proposes a structured list of test
 * scenarios grouped by detected section. The user reviews them, then
 * picks which ones to convert into real test cases.
 *
 * This is NOT for generating final Playwright code — only for naming
 * what's testable. The conversion step calls completeSingleTest with
 * the chosen suggestion's metadata to produce the actual code.
 */
export function buildSuggestExplorationPrompt(args: {
  baseUrl: string;
  pages: Array<{
    section: string;
    url: string;
    snapshot: string;
  }>;
  existingTestTitles: string[];
}): string {
  const pagesBlock = args.pages
    .map(
      (p, i) => `### PAGE ${i + 1} — section guess: "${p.section}"
URL: ${p.url}

Live DOM summary (real attributes, copy them verbatim if you reference them):
${p.snapshot}
---`,
    )
    .join('\n\n');

  const existingBlock =
    args.existingTestTitles.length > 0
      ? `\n\n========================================\nALREADY-EXISTING TEST CASE TITLES (DO NOT PROPOSE OVERLAPPING SCENARIOS)\n========================================\n${args.existingTestTitles.map((t) => `  - "${t}"`).join('\n')}\n\nIf a scenario you'd otherwise propose is clearly already covered by one of these titles, SKIP it.`
      : '';

  return `You are an expert QA architect doing exploratory analysis on a web application. The platform has scanned several pages. Your job: propose a CURATED LIST of test scenarios the user could meaningfully run, grouped by site section.

These are SUGGESTIONS — not final tests. The user will pick which ones to convert into real Playwright code later. Be concrete, actionable, and avoid scope creep.

BASE URL: ${args.baseUrl}

${pagesBlock}${existingBlock}

YOUR TASK:

1. For each section the user could meaningfully test, propose 1-4 scenarios.
2. Each scenario must be GROUNDED in the actual elements you saw in the snapshot. NEVER invent forms, buttons, or features that don't appear in any page snapshot above.
3. Skip scenarios that require credentials, payment, or other data you cannot have ("login successfully" without real users, "complete checkout" without real card, etc.). Stick to negative-path / validation / navigation / visual scenarios that don't need authenticated state.
4. Skip scenarios overlapping with the existing test case titles listed above.
5. Use plain Spanish for the user-facing fields (title, description, what_to_test, how_to_test). Make them readable for a QA reviewer.

OUTPUT FORMAT (strict JSON, no markdown fences, no explanations):

{
  "sections": [
    {
      "name": "Login",                                      // section label, capitalize
      "scan_url": "/login",                                 // path on the base URL
      "suggestions": [
        {
          "title": "Validar formato de email en login",     // ≤60 chars, action-oriented
          "description": "Verificar que un email mal formado muestra mensaje de error",
          "what_to_test": "El input de email rechaza valores sin @ o sin dominio",
          "how_to_test": "Llenar el input con 'foo' y hacer submit; esperar que aparezca un mensaje del navegador o del servidor indicando email inválido",
          "test_type": "e2e",                               // one of: e2e|regression|visual|accessibility|performance|api|cross_browser|responsive
          "priority": "high",                               // low|medium|high|critical
          "ai_metadata": {                                  // free-form hints for the conversion step
            "key_elements": ["input[name=log]", "button text 'Acceder'"],
            "page_observations": "form posts to /wp-login.php"
          }
        }
      ]
    }
  ]
}

GUIDELINES PER SECTION:

- Common section labels to use: "Login", "Registro", "Recuperar contraseña", "Productos", "Detalle de producto", "Carrito", "Checkout", "Búsqueda", "Filtros", "Navegación", "Footer", "Contacto", "Perfil", "Dashboard", "Página de inicio", "Accesibilidad", etc. Use what fits the actual page.
- Prioritize HIGH-VALUE scenarios: form validations, navigation links work, no broken images, search returns results, filters update state, footer links go somewhere, cart-empty state is shown, etc.
- AVOID: anything requiring real auth, real payment, server state mutations you can't roll back.
- Each suggestion's how_to_test should be 1-3 sentences max — concrete enough that a Playwright test could be written from it without further clarification.

Return ONLY the JSON object. No prose before or after.`;
}

export function buildAnalyzePrompt(url: string, pageData: string): string {
  return `Analyze this web page and provide a structured summary for QA test generation.

URL: ${url}
PAGE DATA:
${pageData}

Return a JSON summary with:
{
  "summary": "Brief description of the application",
  "main_features": ["feature1", "feature2"],
  "user_flows": ["flow1", "flow2"],
  "potential_issues": ["issue1", "issue2"],
  "recommended_test_types": ["e2e", "accessibility"],
  "priority_areas": ["area1", "area2"]
}`;
}
