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
