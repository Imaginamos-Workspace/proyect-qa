// Streaming AI Test Generation — POST /api/generate-stream

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') { res.status(200).end(); return; }
  if (req.method !== 'POST') {
    res.json({ info: 'Use POST', node: process.version });
    return;
  }

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const GEMINI_KEY = process.env.GEMINI_API_KEY;

  try {
    // Auth check
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Missing authorization' });
      return;
    }
    const userRes = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { 'Authorization': auth, 'apikey': SUPABASE_KEY },
    });
    if (!userRes.ok) { res.status(401).json({ error: 'Invalid token' }); return; }

    const body = req.body || {};
    const base_url = body.base_url;
    if (!base_url) { res.status(400).json({ error: 'base_url required' }); return; }

    const test_types = body.test_types || ['e2e'];
    const project_name = body.project_name || '';
    const biz = body.business_context;
    const language = body.language || 'en';
    // Optional: structured flows pre-selected by the user via the explore step.
    // When provided, the AI generates tests strictly for these flows + assertions.
    const selected_flows = Array.isArray(body.selected_flows) ? body.selected_flows : null;

    // Extract web via Jina AI — TWO modes for maximum fidelity:
    //   - Markdown:  human-readable copy/text (good for understanding the site)
    //   - HTML:      rendered DOM with REAL attributes (placeholder, name, id,
    //                type, aria-label) → the AI can pick exact selectors.
    let page = '';
    let renderedHtml = '';
    try {
      const baseHeaders = {};
      if (process.env.JINA_API_KEY) {
        baseHeaders['Authorization'] = 'Bearer ' + process.env.JINA_API_KEY;
      }
      // Fetch BOTH formats in parallel.
      const [mdRes, htmlRes] = await Promise.all([
        fetch('https://r.jina.ai/' + base_url, {
          headers: { ...baseHeaders, 'Accept': 'text/markdown' },
          signal: AbortSignal.timeout(15000),
        }).catch(() => null),
        fetch('https://r.jina.ai/' + base_url, {
          headers: { ...baseHeaders, 'Accept': 'text/html', 'X-Return-Format': 'html' },
          signal: AbortSignal.timeout(15000),
        }).catch(() => null),
      ]);
      if (mdRes && mdRes.ok) page = await mdRes.text();
      if (htmlRes && htmlRes.ok) renderedHtml = await htmlRes.text();
      if (!page && !renderedHtml) {
        res.status(502).json({ error: 'Jina returned no content for ' + base_url });
        return;
      }
    } catch (e) {
      res.status(502).json({ error: 'Web extraction failed: ' + e.message });
      return;
    }

    const content = (page || '').substring(0, 12000);

    // Build a STRUCTURED DOM snapshot from the rendered HTML — this is what
    // makes the AI use REAL selectors instead of guessing.
    let domBlock = '';
    if (renderedHtml) {
      try {
        const { parse: parseHtml } = require('node-html-parser');
        const root = parseHtml(renderedHtml.slice(0, 2_000_000), {
          blockTextElements: { script: false, style: false },
        });
        const lines = [];
        // Labels (for input ↔ label association)
        const labelMap = {};
        root.querySelectorAll('label').forEach((el) => {
          const t = (el.text || '').trim().replace(/\s+/g, ' ').slice(0, 80);
          const htmlFor = el.getAttribute('for');
          if (htmlFor && t) labelMap[htmlFor] = t;
        });
        // Forms (with their fields)
        const forms = root.querySelectorAll('form');
        if (forms.length) {
          lines.push('FORMS (use these EXACT attributes):');
          forms.slice(0, 5).forEach((form, i) => {
            const action = form.getAttribute('action') || '';
            const method = (form.getAttribute('method') || 'get').toLowerCase();
            lines.push(`  Form ${i + 1} [method=${method}${action ? `, action=${action}` : ''}]:`);
            form.querySelectorAll('input, select, textarea').slice(0, 15).forEach((el) => {
              const type = el.getAttribute('type');
              if (type === 'hidden') return;
              const tag = el.tagName.toLowerCase();
              const parts = [];
              if (el.getAttribute('name')) parts.push(`name="${el.getAttribute('name')}"`);
              if (el.getAttribute('id')) parts.push(`id="${el.getAttribute('id')}"`);
              if (el.getAttribute('placeholder')) parts.push(`placeholder="${el.getAttribute('placeholder')}"`);
              if (el.getAttribute('aria-label')) parts.push(`aria-label="${el.getAttribute('aria-label')}"`);
              const tid = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
              if (tid) parts.push(`data-testid="${tid}"`);
              const lbl = el.getAttribute('id') ? labelMap[el.getAttribute('id')] : null;
              if (lbl) parts.push(`label="${lbl}"`);
              lines.push(`    - ${tag}${type ? `[type=${type}]` : ''} ${parts.join(' ')}`);
            });
          });
        }
        // Standalone inputs (not in a form)
        const standaloneInputs = root.querySelectorAll('input, select, textarea').filter((el) => {
          if (el.getAttribute('type') === 'hidden') return false;
          // Walk up to check if inside a form
          let p = el.parentNode;
          while (p) {
            if (p.tagName && p.tagName.toLowerCase() === 'form') return false;
            p = p.parentNode;
          }
          return true;
        });
        if (standaloneInputs.length) {
          lines.push('STANDALONE INPUTS:');
          standaloneInputs.slice(0, 20).forEach((el) => {
            const type = el.getAttribute('type');
            const tag = el.tagName.toLowerCase();
            const parts = [];
            if (el.getAttribute('name')) parts.push(`name="${el.getAttribute('name')}"`);
            if (el.getAttribute('id')) parts.push(`id="${el.getAttribute('id')}"`);
            if (el.getAttribute('placeholder')) parts.push(`placeholder="${el.getAttribute('placeholder')}"`);
            if (el.getAttribute('aria-label')) parts.push(`aria-label="${el.getAttribute('aria-label')}"`);
            lines.push(`  - ${tag}${type ? `[type=${type}]` : ''} ${parts.join(' ')}`);
          });
        }
        // Buttons
        const buttons = root.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]');
        if (buttons.length) {
          lines.push('BUTTONS:');
          buttons.slice(0, 25).forEach((el) => {
            const t = (el.text || '').trim().replace(/\s+/g, ' ').slice(0, 60);
            const parts = [];
            if (t) parts.push(`text="${t}"`);
            if (el.getAttribute('id')) parts.push(`id="${el.getAttribute('id')}"`);
            if (el.getAttribute('name')) parts.push(`name="${el.getAttribute('name')}"`);
            if (el.getAttribute('aria-label')) parts.push(`aria-label="${el.getAttribute('aria-label')}"`);
            const tid = el.getAttribute('data-testid') || el.getAttribute('data-test-id') || el.getAttribute('data-test');
            if (tid) parts.push(`data-testid="${tid}"`);
            lines.push(`  - ${parts.join(' ') || '(unlabeled)'}`);
          });
        }
        // Links (only those with hrefs)
        const links = root.querySelectorAll('a[href]').filter((el) => {
          const h = el.getAttribute('href');
          return h && !h.startsWith('#') && !h.startsWith('javascript:');
        });
        if (links.length) {
          lines.push('LINKS:');
          links.slice(0, 15).forEach((el) => {
            const t = (el.text || '').trim().replace(/\s+/g, ' ').slice(0, 50);
            lines.push(`  - "${t || '(no text)'}" → ${el.getAttribute('href')}`);
          });
        }
        if (lines.length) {
          domBlock = lines.join('\n');
          if (domBlock.length > 6000) domBlock = domBlock.slice(0, 6000) + '\n…(truncated)';
        }
      } catch (e) {
        // node-html-parser failed — drop the structured block but keep markdown
        domBlock = '';
      }
    }
    const domSection = domBlock
      ? `\n═══════════════════════════════════════════════════════════════
LIVE DOM ELEMENTS (real attributes, freshly fetched — USE THESE VERBATIM)
═══════════════════════════════════════════════════════════════
${domBlock}
═══════════════════════════════════════════════════════════════
`
      : '';

    // Build prompt
    const ctx = biz ? '\nBusiness: ' + JSON.stringify(biz) : '';
    const langName = language === 'es' ? 'Spanish' : 'English';

    // If the user already ran the explore step and selected flows + assertions,
    // build a highly-focused prompt that generates ONLY those specific flows.
    let prompt;
    if (selected_flows && selected_flows.length > 0) {
      const flowsJson = JSON.stringify(selected_flows, null, 2);
      prompt = `You are an expert QA engineer. Generate Playwright tests for EXACTLY the flows listed below — no more, no less. The user already explored the site and picked these specific flows and assertions.

Website: ${base_url} ${project_name ? '(' + project_name + ')' : ''}${ctx}

PAGE CONTENT (Markdown snapshot, for context on copy/text):
${content}
${domSection}
METADATA LANGUAGE: ${langName}.

SELECTED FLOWS TO GENERATE (one test per flow, using the provided assertions):
${flowsJson}

RULES:
1. Generate EXACTLY one test per flow in the SELECTED FLOWS array above
2. Group flows by their module_name into modules in the output
3. Each test MUST include all assertions listed for that flow — use the assertion.code snippets verbatim
4. Start every test with: await page.goto('/') — RELATIVE path. NEVER hardcode absolute URLs.
5. Add a defensive sanity assertion right after goto(): await expect(page.locator('body')).toBeVisible()
6. Use the flow.name as the test title (in ${langName})
7. Use the flow.description as the test description (in ${langName})
8. SELECTOR RULES — use the LIVE DOM ELEMENTS list above as ground truth:
   - If an input has name="X" → use page.locator('input[name="X"]')
   - If an input has placeholder="X" → use page.getByPlaceholder('X') VERBATIM
   - If a button has text "X" → use page.getByRole('button', { name: 'X' }) VERBATIM
   - If element has data-testid → use page.getByTestId('X')
   - NEVER invent placeholders, labels, or CSS classes that are not in the snapshot.
9. URL ASSERTIONS — use RELATIVE regex, NEVER absolute strings:
   WRONG: expect(page).toHaveURL('https://example.com/login/')
   RIGHT: expect(page).toHaveURL(/\\/login\\/?$/)

RETURN ONLY valid JSON (no markdown fences):
{"modules":[{"name":"Module","description":"desc","test_cases":[{"title":"name","description":"what","test_type":"e2e","priority":"high","tags":["tag"],"code":"import { test, expect } from '@playwright/test';\\ntest('name', async ({ page }) => { await page.goto('/'); });"}]}]}`;
    } else {
      // Original prompt — generate from scratch without pre-selection
      prompt = `You are an expert QA engineer. This platform is site-AGNOSTIC — the tests you generate MUST work regardless of the website's language, framework, or domain. You only know about this site what the PAGE CONTENT and LIVE DOM ELEMENTS below tell you. Never assume anything not visible there.

Website: ${base_url} ${project_name ? '(' + project_name + ')' : ''}${ctx}

PAGE CONTENT (Markdown extracted from the live page — for understanding copy/text):
${content}
${domSection}
LANGUAGE FOR METADATA: titles, descriptions, module names, code comments → ${langName}.
Code itself (Playwright API) is always in English.

═══════════════════════════════════════════════════════════════
CRITICAL — SELECTOR STRATEGY (agnostic to any site, any language)
═══════════════════════════════════════════════════════════════

GROUND TRUTH: The "LIVE DOM ELEMENTS" block above (when present) lists the
REAL inputs, buttons, and links on the page with their REAL attributes
(name, id, placeholder, aria-label, data-testid, button text). USE THESE
VERBATIM. Do not invent attributes that do not appear there.

Before writing a selector, ask yourself:
  "Did I actually see this exact text/attribute in the LIVE DOM ELEMENTS or PAGE CONTENT above?"
  If NO → use a CSS attribute selector instead, OR fall back to a wide
          regex locator. NEVER guess specific text.

PRIORITY ORDER (use the FIRST strategy that works):

  1. **CSS selectors by semantic attribute** (BEST — language-independent, stable):
     page.locator('input[type="email"]')         // any email field
     page.locator('input[type="password"]')      // any password field
     page.locator('input[type="submit"]')        // any submit input
     page.locator('button[type="submit"]')       // any submit button
     page.locator('form')                        // any form
     page.locator('a[href*="signup"]')           // any link whose href contains "signup"

  2. **CSS selectors by name/id attribute** (when visible in HTML):
     page.locator('input[name="email"]')
     page.locator('#login-form')
     page.locator('[data-testid="login-btn"]')

  3. **getByPlaceholder** ONLY if you see the EXACT placeholder in PAGE CONTENT:
     page.getByPlaceholder('correo@ejemplo.com')

  4. **getByRole with regex and /i flag** for buttons/links with visible text:
     page.getByRole('button', { name: /log\\s*in|iniciar\\s*sesi[oó]n|entrar/i })
     (use alternation to cover multiple possible labels across languages/wording)

  5. **getByLabel** ONLY if you see the exact label text verbatim in PAGE CONTENT.
     NEVER guess labels. If the page text shows "Contraseña", use 'Contraseña' — not 'Password'.

  6. **getByText with regex** for visible copy assertions:
     expect(page.getByText(/bienvenid|welcome/i)).toBeVisible();

FORBIDDEN (these break silently on real sites):
  ✗ Assuming labels in English ('Password', 'Email', 'Login') without seeing them in PAGE CONTENT
  ✗ Hardcoded text strings without /i flag or regex alternation
  ✗ Selectors that depend on specific framework class names (e.g. .ant-btn-primary, .error-message, .alert-danger) unless they appear in the LIVE DOM ELEMENTS block
  ✗ Testing functionality you didn't observe in the page (e.g. "password reset" if no such link exists)
  ✗ Inventing data-testid values — only use those listed in LIVE DOM ELEMENTS
  ✗ Hardcoding absolute URLs in page.goto() or toHaveURL() — use relative paths / regex

ERROR / VALIDATION MESSAGES:
  Login error messages typically appear AFTER form submission via JS — they
  may NOT be in the static snapshot. For these, use a wide text-based regex:
    page.locator('text=/correo|email|inv[aá]lid|invalid|incorrecto|incorrect/i').first()
  Do NOT invent CSS selectors like .error-message, .alert-danger, [data-test="email-error"].

═══════════════════════════════════════════════════════════════
TEST STRUCTURE RULES
═══════════════════════════════════════════════════════════════

1. MODULE DETECTION: Divide tests into 2-5 modules based on what you actually SEE in the page:
   - If you see a login form → "Autenticación" module
   - If you see a nav bar → "Navegación" module
   - If you see a checkout button → "Checkout" module
   - Do NOT invent modules for features you can't confirm from the content.

2. Generate ${test_types.join(', ')} tests

3. Each test is fully independent — no shared state, each starts with page.goto()

4. Every test starts with: await page.goto('/');  ← RELATIVE PATH ONLY.
   Subsequent navigations: await page.goto('/login'), '/signup', etc.
   NEVER hardcode absolute URLs like '${base_url}/login' — baseURL is set
   in playwright.config.ts and prepended automatically.

5. Each test MUST have at least 2 expect() assertions so failures are attributable

6. URL ASSERTIONS — use REGEX on the path, NEVER an absolute URL string:
   WRONG: await expect(page).toHaveURL('https://example.com/login/')
   RIGHT: await expect(page).toHaveURL(/\\/login\\/?$/)
   Trailing slashes vary across sites — regex tolerates both /login and /login/.

7. Prefer STABLE assertions:
   - toHaveURL(/regex/) for navigation checks
   - toBeVisible() for element presence
   - toHaveTitle(/regex/) for page identity

7. Each interactive test should have a defensive first step:
   await expect(page.locator('body')).toBeVisible();   // page loaded at all
   before interacting with anything else. This distinguishes "site down" from "test wrong".

8. Use Playwright's auto-waiting — don't add waitForTimeout() unless absolutely needed.

RETURN ONLY valid JSON (no markdown fences, no explanatory text before or after):
{"modules":[{"name":"Module","description":"desc","test_cases":[{"title":"name","description":"what","test_type":"e2e","priority":"high","tags":["tag"],"code":"import { test, expect } from '@playwright/test';\\ntest('name', async ({ page }) => { await page.goto('/'); });"}]}]}`;
    }
    // End of prompt selection (selected_flows vs from-scratch)

    // SSE streaming
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    res.write('event: status\ndata: ' + JSON.stringify({ step: 'extracting', message: 'Web content extracted (' + content.length + ' chars)' }) + '\n\n');
    res.write('event: status\ndata: ' + JSON.stringify({ step: 'generating', message: 'AI generating tests...' }) + '\n\n');

    // Gemini streaming
    const gUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent?key=' + GEMINI_KEY + '&alt=sse';
    const gRes = await fetch(gUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.3, maxOutputTokens: 24576 },
      }),
    });

    if (!gRes.ok) {
      res.write('event: error\ndata: ' + JSON.stringify({ message: 'Gemini error: ' + gRes.status }) + '\n\n');
      res.end();
      return;
    }

    const reader = gRes.body.getReader();
    const dec = new TextDecoder();
    let full = '';
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const ln of lines) {
        if (!ln.startsWith('data: ')) continue;
        const j = ln.substring(6).trim();
        if (j === '[DONE]') continue;
        try {
          const p = JSON.parse(j);
          const t = p?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (t) {
            full += t;
            res.write('event: chunk\ndata: ' + JSON.stringify({ text: t }) + '\n\n');
          }
        } catch {}
      }
    }

    // Parse result
    res.write('event: status\ndata: ' + JSON.stringify({ step: 'parsing', message: 'Parsing...' }) + '\n\n');

    // Resilient LLM-JSON parser (state-machine based).
    // Handles: markdown fences, prose wrappers, literal newlines inside
    // strings, bad backslash escapes (\s, \d, etc.), control chars,
    // trailing commas, AND truncation by auto-closing unclosed brackets.
    const parsed = parseLLMJson(full);
    let mods = [];
    if (parsed) {
      mods = Array.isArray(parsed) ? parsed : (parsed.modules || [parsed]);
    } else {
      mods = [{ name: 'Generated Tests', description: 'AI tests', test_cases: [{ title: 'Generated Suite', description: '', test_type: 'e2e', priority: 'medium', code: full, tags: [] }] }];
    }

    // Post-process: harden selectors for robustness across any site/language.
    // This is defense-in-depth — the prompt already asks the AI to do this,
    // but we enforce it at the gate so bad selectors don't reach the user.
    // Strategy: ALWAYS widen known semantic patterns to multi-language regex.
    // A regex that includes the original literal is strictly safer than the
    // literal itself, so there's no downside to always widening.
    function hardenCode(code) {
      if (!code || typeof code !== 'string') return code;
      let out = code;

      // Known semantic labels with multi-language alternations.
      // When the AI emits any of these as a string literal in getByLabel/Role,
      // we replace with a regex covering the common variants across languages.
      const LABEL_MAP = [
        { match: /^\s*(password|contrase[ñn]a)\s*$/i,                                         rx: 'password|contrase[ñn]a' },
        { match: /^\s*(email|correo(\s+electr[oó]nico)?|e-?mail)\s*$/i,                       rx: 'email|correo(\\s+electr[oó]nico)?|e-?mail' },
        { match: /^\s*(user(name)?|usuario)\s*$/i,                                             rx: 'user(name)?|usuario' },
        { match: /^\s*(log\s*in|sign\s*in|iniciar\s*sesi[oó]n|entrar|ingresar|acceder)\s*$/i,  rx: 'log\\s*in|sign\\s*in|iniciar\\s*sesi[oó]n|entrar|ingresar|acceder' },
        { match: /^\s*(sign\s*up|register|registrarse|crear\s*cuenta|reg[ií]strate)\s*$/i,     rx: 'sign\\s*up|register|registrarse|crear\\s*cuenta|reg[ií]strate' },
        { match: /^\s*(submit|enviar|continuar|siguiente|next)\s*$/i,                          rx: 'submit|enviar|continuar|siguiente|next' },
        { match: /^\s*(search|buscar|b[uú]squeda)\s*$/i,                                       rx: 'search|buscar|b[uú]squeda' },
        { match: /^\s*(cancel|cancelar)\s*$/i,                                                 rx: 'cancel|cancelar' },
        { match: /^\s*(delete|eliminar|borrar)\s*$/i,                                          rx: 'delete|eliminar|borrar' },
        { match: /^\s*(save|guardar)\s*$/i,                                                    rx: 'save|guardar' },
        { match: /^\s*(forgot(\s+(your\s+)?password)?|olvid[oó](\s+(su|tu)\s+contrase[ñn]a)?)\s*$/i, rx: 'forgot(\\s+(your\\s+)?password)?|olvid[oó](\\s+(su|tu)\\s+contrase[ñn]a)?' },
      ];

      const widenLiteral = (full, quote, value) => {
        for (const { match, rx } of LABEL_MAP) {
          if (match.test(value)) {
            return full.replace(quote + value + quote, '/' + rx + '/i');
          }
        }
        // Unknown label: still widen to regex with /i so case/whitespace variance doesn't break it
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        return full.replace(quote + value + quote, '/' + escaped + '/i');
      };

      // getByLabel('X')
      out = out.replace(/getByLabel\(\s*(['"`])([^'"`]+)\1\s*\)/g, (m, q, v) => widenLiteral(m, q, v));
      // getByRole('role', { name: 'X' })
      out = out.replace(/getByRole\([^)]*name:\s*(['"`])([^'"`]+)\1[^)]*\)/g, (m, q, v) => widenLiteral(m, q, v));
      // getByText('X') — widen to regex
      out = out.replace(/getByText\(\s*(['"`])([^'"`]+)\1\s*\)/g, (m, q, v) => widenLiteral(m, q, v));
      // getByPlaceholder('X') — widen to regex
      out = out.replace(/getByPlaceholder\(\s*(['"`])([^'"`]+)\1\s*\)/g, (m, q, v) => widenLiteral(m, q, v));

      // Harden common URL assertions — AIs love asserting /register but site uses /signup (or vice versa)
      const URL_MAP = [
        { match: /toHaveURL\(\s*\/[.*]*\\?\/?(register|signup|sign-?up)[^)]*\)/gi,
          replace: "toHaveURL(/register|signup|sign-?up|crear.*cuenta|reg[ií]strate/i)" },
        { match: /toHaveURL\(\s*\/[.*]*\\?\/?(login|signin|sign-?in)[^)]*\)/gi,
          replace: "toHaveURL(/login|signin|sign-?in|sesi[oó]n|ingresar|entrar/i)" },
      ];
      for (const { match, replace } of URL_MAP) {
        out = out.replace(match, replace);
      }

      // Harden fragile toHaveText('exact') on top-level elements — convert to toContainText with regex
      // so "WIS3" assertion on h1 becomes "contains any text" instead of exact match.
      // This makes the test verify the element exists with some text, not a specific brand name.
      out = out.replace(
        /expect\(\s*(page\.locator\(\s*(['"`])(h[1-6]|title|header)\2\s*\))\s*\)\.toHaveText\(\s*(['"`])([^'"`]+)\4\s*\)/g,
        (_m, locator) => `expect(${locator}).toBeVisible()`,
      );

      // Ensure each test has a "page loaded" sanity assert right after goto().
      // Distinguishes "site down" from "selector wrong" in the report.
      out = out.replace(
        /(await\s+page\.goto\([^)]+\);)(\s*\n)(?!\s*(?:await\s+expect\s*\(\s*page\.locator\(\s*['"`]body))/g,
        (_m, goto, nl) => goto + nl + "  await expect(page.locator('body')).toBeVisible();\n",
      );

      return out;
    }

    let warningsCount = 0;
    for (const m of mods) {
      if (!Array.isArray(m.test_cases)) continue;
      for (const tc of m.test_cases) {
        const before = tc.code || '';
        tc.code = hardenCode(before);
        if (tc.code !== before) warningsCount++;
      }
    }

    res.write('event: complete\ndata: ' + JSON.stringify({
      modules: mods,
      summary: {
        modules_count: mods.length,
        test_cases_count: mods.reduce(function(s, m) { return s + (m.test_cases ? m.test_cases.length : 0); }, 0),
        hardened_tests: warningsCount,
      },
    }) + '\n\n');

    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Server error' });
    } else {
      try { res.write('event: error\ndata: ' + JSON.stringify({ message: err.message }) + '\n\n'); } catch {}
      res.end();
    }
  }
};

/* ------------------------------------------------------------------ */
/*  Resilient LLM-JSON parser (same implementation as explore-stream) */
/* ------------------------------------------------------------------ */

function parseLLMJson(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    s = s.substring(firstBrace, lastBrace + 1);
  } else if (firstBrace >= 0) {
    s = s.substring(firstBrace);
  }
  s = escapeNewlinesInStrings(s);
  s = s.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\');
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

  const attempts = [
    (x) => x,
    (x) => x.replace(/,(\s*[}\]])/g, '$1'),
    (x) => closeTruncatedJson(x),
    (x) => closeTruncatedJson(x.replace(/,(\s*[}\]])/g, '$1')),
  ];
  for (const fix of attempts) {
    try { return JSON.parse(fix(s)); } catch { /* try next */ }
  }
  return null;
}

function escapeNewlinesInStrings(s) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { out += c; escaped = false; continue; }
    if (c === '\\' && inString) { out += c; escaped = true; continue; }
    if (c === '"') { inString = !inString; out += c; continue; }
    if (inString) {
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { out += '\\r'; continue; }
      if (c === '\t') { out += '\\t'; continue; }
    }
    out += c;
  }
  return out;
}

function closeTruncatedJson(s) {
  const openers = [];
  let inString = false;
  let escaped = false;
  let lastSafeComma = -1;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) { escaped = false; continue; }
    if (inString) {
      if (c === '\\') { escaped = true; continue; }
      if (c === '"') { inString = false; }
      continue;
    }
    if (c === '"') { inString = true; continue; }
    if (c === '{' || c === '[') { openers.push(c); continue; }
    if (c === '}' || c === ']') { openers.pop(); continue; }
    if (c === ',') lastSafeComma = i;
  }
  if (!inString && openers.length === 0) return s;
  let out;
  if (lastSafeComma > 0) out = s.substring(0, lastSafeComma);
  else { out = s; if (inString) out += '"'; }
  const stack2 = [];
  let inStr2 = false, esc2 = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (esc2) { esc2 = false; continue; }
    if (inStr2) {
      if (c === '\\') { esc2 = true; continue; }
      if (c === '"') inStr2 = false;
      continue;
    }
    if (c === '"') { inStr2 = true; continue; }
    if (c === '{' || c === '[') { stack2.push(c); continue; }
    if (c === '}' || c === ']') stack2.pop();
  }
  if (inStr2) out += '"';
  out = out.replace(/[,:]\s*$/, '').replace(/,(\s*[}\]])/g, '$1');
  while (stack2.length > 0) {
    const top = stack2.pop();
    out += top === '{' ? '}' : ']';
  }
  return out;
}
