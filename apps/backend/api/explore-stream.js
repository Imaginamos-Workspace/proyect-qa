// Site Exploration — POST /api/explore-stream
// Crawls the site (up to 8 pages), aggregates content, and asks the AI
// for a structured site map with modules, flows, and suggested assertions.
// Returns SSE events so the UI can show real-time progress.

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

    const project_name = body.project_name || '';
    const biz = body.business_context;
    const language = body.language || 'en';
    const max_pages = Math.min(parseInt(body.max_pages || '12', 10), 20);
    const additional_urls = Array.isArray(body.additional_urls) ? body.additional_urls : [];
    const requires_auth = Boolean(body.requires_auth);
    // GitHub repo URL + optional personal access token for private repos.
    // The backend reads router/page/service files via GitHub API — this gives
    // the AI access to the COMPLETE module structure, even areas behind login
    // that no crawler could see.
    const repo_url = (body.repo_url || '').trim();
    const github_token = (body.github_token || '').trim();

    // Set up SSE early so events can flow
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const send = (event, data) => {
      res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
    };

    // ───────────────────────────────────────────────────────────────
    // Step 1: Scrape the home page via Jina
    // ───────────────────────────────────────────────────────────────
    send('status', { step: 'scraping_home', message: 'Analizando página principal...' });

    const jinaFetch = async (url) => {
      const headers = { 'Accept': 'text/markdown' };
      if (process.env.JINA_API_KEY) {
        headers['Authorization'] = 'Bearer ' + process.env.JINA_API_KEY;
      }
      const r = await fetch('https://r.jina.ai/' + url, {
        headers,
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) throw new Error('Jina ' + r.status + ' for ' + url);
      return await r.text();
    };

    let homeContent = '';
    try {
      homeContent = await jinaFetch(base_url);
    } catch (e) {
      send('error', { message: 'No se pudo acceder a la página principal: ' + e.message });
      res.end();
      return;
    }

    send('status', { step: 'home_scraped', message: 'Página principal cargada (' + homeContent.length + ' chars)' });

    // ───────────────────────────────────────────────────────────────
    // Step 2: Extract internal links from the home page markdown
    // ───────────────────────────────────────────────────────────────
    const baseUrlObj = new URL(base_url);
    const baseHost = baseUrlObj.host;

    // Match Markdown [text](url) links and raw https URLs
    const urlSet = new Set();
    const mdLinkRe = /\[[^\]]*\]\(([^)]+)\)/g;
    const rawUrlRe = /https?:\/\/[^\s<>"')]+/g;
    let m;
    while ((m = mdLinkRe.exec(homeContent)) !== null) {
      try {
        const u = new URL(m[1], base_url);
        if (u.host === baseHost) urlSet.add(u.origin + u.pathname);
      } catch { /* bad URL */ }
    }
    while ((m = rawUrlRe.exec(homeContent)) !== null) {
      try {
        const u = new URL(m[0]);
        if (u.host === baseHost) urlSet.add(u.origin + u.pathname);
      } catch { /* bad URL */ }
    }
    urlSet.delete(baseUrlObj.origin + baseUrlObj.pathname); // don't re-scrape home

    // Merge user-provided URLs with auto-discovered ones — user URLs go first
    // so they're guaranteed to be crawled within the max_pages budget.
    const discovered = Array.from(urlSet);
    const priorityKeywords = ['signin', 'signup', 'login', 'register', 'dashboard', 'catalog', 'catalogue', 'product', 'checkout', 'cart', 'account', 'profile', 'settings', 'orders', 'quotes', 'requests', 'invoic'];
    discovered.sort((a, b) => {
      const aScore = priorityKeywords.some((k) => a.toLowerCase().includes(k)) ? 0 : 1;
      const bScore = priorityKeywords.some((k) => b.toLowerCase().includes(k)) ? 0 : 1;
      return aScore - bScore;
    });

    // Normalize user URLs so comparison is stable
    const normalizeUrl = (u) => {
      try {
        const n = new URL(u, base_url);
        return n.origin + n.pathname;
      } catch { return null; }
    };
    const userUrls = additional_urls
      .map(normalizeUrl)
      .filter(Boolean)
      .filter((u) => u !== baseUrlObj.origin + baseUrlObj.pathname);
    // De-dup while preserving user-first order
    const seen = new Set();
    const ordered = [];
    for (const u of [...userUrls, ...discovered]) {
      if (seen.has(u)) continue;
      seen.add(u);
      ordered.push(u);
    }
    const toVisit = ordered.slice(0, max_pages - 1);

    send('links_found', {
      total: discovered.length,
      user_provided: userUrls.length,
      to_visit: toVisit,
    });

    // ───────────────────────────────────────────────────────────────
    // Step 3: Scrape each discovered URL (with a concurrency cap)
    // ───────────────────────────────────────────────────────────────
    const pages = [{ url: base_url, content: homeContent.substring(0, 4000) }];

    // Process in parallel batches of 3 to respect Jina rate limits and Vercel 60s ceiling
    const batchSize = 3;
    for (let i = 0; i < toVisit.length; i += batchSize) {
      const batch = toVisit.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(async (url) => {
          send('page_start', { url });
          try {
            const c = await jinaFetch(url);
            const truncated = c.substring(0, 4000);
            send('page_done', { url, chars: truncated.length });
            return { url, content: truncated };
          } catch (e) {
            send('page_failed', { url, error: e.message });
            return null;
          }
        }),
      );
      for (const r of results) if (r) pages.push(r);
    }

    send('status', { step: 'pages_scraped', count: pages.length, message: pages.length + ' páginas analizadas' });

    // ───────────────────────────────────────────────────────────────
    // Step 3.5: If a GitHub repo URL was provided, pull router + key
    // files. This gives the AI 100% module visibility, even for areas
    // behind login that no crawler could see.
    // ───────────────────────────────────────────────────────────────
    let repoAnalysis = '';
    if (repo_url) {
      send('status', { step: 'analyzing_repo', message: 'Analizando repositorio Git...' });
      try {
        repoAnalysis = await analyzeGitRepo(repo_url, github_token, send);
        send('status', {
          step: 'repo_done',
          message: 'Repo analizado: ' + repoAnalysis.split('=== FILE:').length + ' archivos relevantes',
        });
      } catch (e) {
        send('status', { step: 'repo_failed', message: 'Repo: ' + e.message });
        // non-fatal — continue with just page content
      }
    }

    // ───────────────────────────────────────────────────────────────
    // Step 4: Send combined content to Gemini for structure analysis
    // ───────────────────────────────────────────────────────────────
    send('status', { step: 'analyzing', message: 'IA analizando estructura del sitio...' });

    const langName = language === 'es' ? 'Spanish' : 'English';
    const ctx = biz ? '\nBusiness context (VERY IMPORTANT — use to expand coverage beyond what is visible): ' + JSON.stringify(biz) : '';

    let combinedContent = pages
      .map((p, i) => '=== PAGE ' + (i + 1) + ': ' + p.url + ' ===\n' + p.content)
      .join('\n\n');

    // Prepend repo analysis so the AI sees module structure from source code
    // BEFORE the scraped HTML. Router files define the complete app topology.
    if (repoAnalysis) {
      combinedContent = repoAnalysis + '\n\n' + combinedContent;
    }

    const authHint = requires_auth
      ? '\n\n⚠️ AUTH-PROTECTED SITE: Most pages require login and are NOT visible in the scraped content above. You can ONLY see the public pages (landing, login, signup). However, the user already provided the expected functionality in business_context.key_flows. For those auth-protected flows:\n' +
        '  - Create modules for them based on key_flows (e.g. if key_flows mentions "checkout", create a Checkout module)\n' +
        '  - For each flow, mark entry_url as the login URL, with a note in description that authentication is required first\n' +
        '  - Use generic CSS selectors (input[type="..."], button[type="submit"]) since you cannot observe the exact labels\n' +
        '  - Prefer navigation assertions (toHaveURL with regex) and structural assertions (toBeVisible on common selectors)\n'
      : '';

    const prompt = `You are an expert QA architect. Analyze this multi-page website dump and produce a structured site map of modules, user flows, and suggested test assertions.

Website: ${base_url} ${project_name ? '(' + project_name + ')' : ''}${ctx}

${pages.length} PAGES SCRAPED (only public-facing pages visible to the crawler):
${combinedContent.substring(0, 30000)}${authHint}

METADATA LANGUAGE: ${langName}. (titles, descriptions, assertion descriptions — all in ${langName})
CODE LANGUAGE: Playwright API calls always in English.

TASK — BUILD A COMPREHENSIVE REGRESSION SUITE:
This is a REGRESSION test suite, meaning full coverage is the goal — not just happy paths.

1. Identify 4-20 LOGICAL MODULES. Combine aggressively from MULTIPLE sources:
   - **GIT REPO FILES (HIGHEST PRIORITY when present)**: Router files, pages/, app/, and
     routes/ directories define the COMPLETE app topology. EVERY route is a module or
     feature. Parse React Router <Route>, Vue Router routes, Next.js pages, SvelteKit
     routes, etc. If you see "/dashboard/catalogue/:id", create a Catalog module with
     a "View product detail" flow. If you see "src/services/orders.service.ts", there's
     an Orders module.
   - What you DIRECTLY OBSERVE in the scraped HTML pages
   - EVERY item in business_context.key_flows is a MODULE (even if not observed)
   - Common SaaS patterns: Catalog, Cart, Checkout, Orders, Account, Profile, Search,
     Filters, Notifications, Settings, Admin Panel, Analytics, Billing, Invoices

   The repo source code is the GROUND TRUTH for what modules exist. Trust it above the
   crawler output.

2. For each module, list URLs. If auth-protected and not observed, leave urls as [] and set
   entry_url per flow to base_url (the tests will start at login and navigate after).

3. For each module, propose 5-10 FLOWS covering REGRESSION CATEGORIES. Every module MUST have:
   - 1-2 HAPPY PATH flows (normal successful usage)
   - 2-3 VALIDATION flows (required fields empty, format wrong, too short/long, special chars)
   - 1-2 EDGE CASES (boundary values, duplicate data, max limits)
   - 1 ERROR STATE flow (server 500, network failure, 404)
   - 1 EMPTY STATE flow when applicable (no data yet, empty list)
   - 1-2 PERMISSION flows if roles are hinted (admin-only actions, guest view)

4. For each flow, propose 3-5 SUGGESTED ASSERTIONS. Each assertion:
   - Has a short human description (${langName})
   - Uses playwright code per SELECTOR STRATEGY below
   - Focuses on OBSERVABLE STATE (URL, visible elements, text content, counts)
   - Prefer navigation + visibility asserts over text-equality asserts (more stable)

SELECTOR STRATEGY (mandatory — tests must be site-agnostic):
  1. CSS semantic: input[type="email"], input[type="password"], button[type="submit"], form
  2. CSS by name/id: input[name="..."], #id, [data-testid="..."]
  3. getByPlaceholder('exact text seen in page')
  4. getByRole('button', { name: /regex|with|alternations/i })
  5. getByLabel(/regex/i) — only if label text is observable
  6. NEVER hardcode English labels on a non-English page

Preferred assertion patterns (stable across any site):
  - await expect(page.locator('body')).toBeVisible()         // page loaded
  - await expect(page).toHaveURL(/regex/i)                   // navigation
  - await expect(page.locator('selector')).toBeVisible()     // element present
  - await expect(page.getByText(/regex/i)).toBeVisible()     // copy visible

RETURN ONLY valid JSON (no markdown fences, no prose):
{
  "site_summary": "1-2 sentence overview of what the site does, in ${langName}",
  "detected_language": "es" | "en" | "other",
  "modules": [
    {
      "id": "mod_auth",
      "name": "Module name in ${langName}",
      "description": "What this module covers, in ${langName}",
      "urls": ["url1", "url2"],
      "flows": [
        {
          "id": "flow_login_happy",
          "name": "Flow name in ${langName}",
          "description": "1 sentence in ${langName}",
          "priority": "high|medium|low",
          "entry_url": "${base_url}",
          "suggested_assertions": [
            {
              "id": "a1",
              "description": "Description in ${langName}",
              "code": "await expect(page.locator('input[type=\\"email\\"]')).toBeVisible();"
            }
          ]
        }
      ]
    }
  ]
}`;

    const gUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:streamGenerateContent?key=' + GEMINI_KEY + '&alt=sse';
    const gRes = await fetch(gUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        // Bumped from 8192 — regression suites with many modules/flows can
        // exceed 8k tokens and get truncated mid-JSON. 24k gives comfortable
        // headroom while staying within flash-lite limits.
        generationConfig: { temperature: 0.2, maxOutputTokens: 24576 },
      }),
    });

    if (!gRes.ok) {
      send('error', { message: 'Gemini error: ' + gRes.status });
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
            send('chunk', { text: t });
          }
        } catch {}
      }
    }

    // Parse structure
    send('status', { step: 'parsing', message: 'Finalizando estructura...' });

    const structure = parseLLMJson(full);
    if (!structure) {
      send('error', {
        message: 'No se pudo parsear la estructura del JSON generado por la IA (respuesta muy larga o mal formada). Intenta con menos URLs adicionales.',
        raw: full.substring(0, 500),
      });
      res.end();
      return;
    }

    send('complete', {
      structure: structure,
      pages_scraped: pages.length,
      urls_discovered: discovered.length,
      urls_user_provided: userUrls.length,
    });

    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message || 'Server error' });
    } else {
      try {
        res.write('event: error\ndata: ' + JSON.stringify({ message: err.message }) + '\n\n');
      } catch {}
      res.end();
    }
  }
};

/* ------------------------------------------------------------------ */
/*  Resilient LLM-JSON parser                                         */
/* ------------------------------------------------------------------ */

/**
 * Attempts to parse a JSON payload emitted by an LLM, applying a series
 * of repair passes. Each LLM quirk is handled independently so a single
 * mistake doesn't prevent extraction of an otherwise-valid structure.
 *
 * Repairs (in order):
 *   1. Strip markdown code fences (```json ... ```)
 *   2. Extract only the {...} block if prose wraps it
 *   3. Escape literal newlines/tabs/CRs INSIDE string values (state machine)
 *   4. Double any lone \X escape that isn't JSON-valid (\s, \d, \[, etc.)
 *   5. Remove control characters outside strings
 *   6. Remove trailing commas before } or ]
 *   7. If response was truncated mid-object, auto-close open brackets
 *
 * Returns the parsed object or null if all attempts fail.
 */
function parseLLMJson(raw) {
  if (!raw || typeof raw !== 'string') return null;

  // ── Step 1-2: strip fences, extract brace block ──
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '');
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    s = s.substring(firstBrace, lastBrace + 1);
  } else if (firstBrace >= 0) {
    // Truncated response — take from first { and we'll auto-close later
    s = s.substring(firstBrace);
  }

  // ── Step 3: escape newlines/tabs/CRs INSIDE string values ──
  // Walks character-by-character tracking whether we're in a string literal.
  // Literal newlines inside strings are invalid JSON — they must be \n.
  s = escapeNewlinesInStrings(s);

  // ── Step 4-5: backslash + control-char repair ──
  s = s.replace(/\\(?!["\\\/bfnrtu])/g, '\\\\');
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

  // Try parsing now
  const attempts = [
    (x) => x,                                  // repaired as-is
    (x) => x.replace(/,(\s*[}\]])/g, '$1'),    // strip trailing commas
    (x) => closeTruncatedJson(x),              // close unclosed brackets
    (x) => closeTruncatedJson(x.replace(/,(\s*[}\]])/g, '$1')),
  ];
  for (const fix of attempts) {
    try {
      return JSON.parse(fix(s));
    } catch (_e) {
      // try next repair
    }
  }
  return null;
}

/**
 * State-machine that walks a JSON string and escapes literal \n, \r, \t
 * when they appear INSIDE a JSON string literal (between unescaped quotes).
 * Leaves whitespace outside strings untouched (so formatting still works).
 */
function escapeNewlinesInStrings(s) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escaped) {
      out += c;
      escaped = false;
      continue;
    }
    if (c === '\\' && inString) {
      out += c;
      escaped = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      out += c;
      continue;
    }
    if (inString) {
      if (c === '\n') { out += '\\n'; continue; }
      if (c === '\r') { out += '\\r'; continue; }
      if (c === '\t') { out += '\\t'; continue; }
    }
    out += c;
  }
  return out;
}

/**
 * Repairs a JSON string that was truncated mid-structure (e.g. LLM hit
 * maxOutputTokens and stopped in the middle of an array). Closes any
 * unclosed strings, arrays, and objects in the correct nesting order.
 *
 * Also trims any partial value at the end (e.g. a half-written "code":
 * field) so the closing is clean.
 */
function closeTruncatedJson(s) {
  // Walk the whole string, tracking (a) current nesting stack,
  // (b) string state, (c) position of the last safe cut — a comma
  // at any depth that's OUTSIDE a string.
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

  // Already complete — nothing to repair
  if (!inString && openers.length === 0) return s;

  // Truncate at the last safe comma if available — drops any partial
  // element mid-way. Otherwise keep as much as we can and try to close.
  let out;
  if (lastSafeComma > 0) {
    out = s.substring(0, lastSafeComma); // note: drop the trailing comma itself
  } else {
    out = s;
    if (inString) out += '"'; // close dangling string
  }

  // Rebuild nesting stack for the truncated slice
  const stack2 = [];
  let inStr2 = false;
  let esc2 = false;
  for (let i = 0; i < out.length; i++) {
    const c = out[i];
    if (esc2) { esc2 = false; continue; }
    if (inStr2) {
      if (c === '\\') { esc2 = true; continue; }
      if (c === '"') { inStr2 = false; }
      continue;
    }
    if (c === '"') { inStr2 = true; continue; }
    if (c === '{' || c === '[') { stack2.push(c); continue; }
    if (c === '}' || c === ']') { stack2.pop(); }
  }
  if (inStr2) out += '"';

  // Clean up any trailing syntax fragments that remain
  out = out.replace(/[,:]\s*$/, ''); // drop trailing , or :
  out = out.replace(/,(\s*[}\]])/g, '$1');

  // Close every remaining opener in reverse
  while (stack2.length > 0) {
    const top = stack2.pop();
    out += top === '{' ? '}' : ']';
  }
  return out;
}

/* ------------------------------------------------------------------ */
/*  GitHub repo analyzer                                              */
/* ------------------------------------------------------------------ */

/**
 * Fetches router / page / service files from a GitHub repo via the
 * REST API + raw.githubusercontent.com. Returns concatenated content
 * that the AI can use to build a full module map.
 *
 * Supports both public and private repos (with user-provided PAT).
 *
 * File patterns detected across popular frameworks:
 *   • React Router:  src/router*, src/routes*, src/App.*
 *   • Next.js:       pages/**, app/**  (both pages dir and app dir)
 *   • Vue Router:    src/router/index.*, src/routes.*
 *   • Angular:       **\/app-routing.module.ts, **\/routes.ts
 *   • Nuxt:          pages/**
 *   • Remix:         app/routes/**
 *   • SvelteKit:     src/routes/**
 *   • Also pulls:    package.json, README.md, top-level services / api
 */
async function analyzeGitRepo(repoUrl, token, send) {
  // Parse GitHub URL — accepts various forms
  const m = repoUrl.match(/github\.com[/:]([^/]+)\/([^/\s]+?)(?:\.git|\/|$)/i);
  if (!m) throw new Error('URL no parece un repositorio de GitHub');
  const owner = m[1];
  const repo = m[2];

  const headers = { Accept: 'application/vnd.github.v3+json' };
  if (token) headers.Authorization = 'token ' + token;

  // 1) Get default branch
  const metaRes = await fetch(
    'https://api.github.com/repos/' + owner + '/' + repo,
    { headers, signal: AbortSignal.timeout(10000) },
  );
  if (metaRes.status === 404) {
    throw new Error('Repo no encontrado (404). Si es privado, incluye un token.');
  }
  if (metaRes.status === 401 || metaRes.status === 403) {
    throw new Error('Acceso denegado (' + metaRes.status + '). Token inválido o sin permisos.');
  }
  if (!metaRes.ok) throw new Error('GitHub ' + metaRes.status);
  const meta = await metaRes.json();
  const branch = meta.default_branch;

  if (send) send('repo_meta', { owner, repo, branch, description: meta.description, language: meta.language });

  // 2) Get full file tree (recursive)
  const treeRes = await fetch(
    'https://api.github.com/repos/' + owner + '/' + repo + '/git/trees/' + branch + '?recursive=1',
    { headers, signal: AbortSignal.timeout(15000) },
  );
  if (!treeRes.ok) throw new Error('No se pudo leer el árbol del repo: ' + treeRes.status);
  const treeData = await treeRes.json();
  const tree = Array.isArray(treeData.tree) ? treeData.tree : [];

  // 3) Filter to files likely to define modules/routes
  const RELEVANT = [
    // React / Vue / general
    /(^|\/)(router|routes)\.(ts|tsx|js|jsx)$/i,
    /(^|\/)router\/index\.(ts|tsx|js|jsx)$/i,
    /^(src\/)?App\.(ts|tsx|js|jsx|vue)$/i,
    /^(src\/)?main\.(ts|tsx|js|jsx)$/i,
    // Next.js — pages dir
    /^pages\/[^/]+\.(ts|tsx|js|jsx|mdx)$/,
    /^pages\/[^/]+\/index\.(ts|tsx|js|jsx)$/,
    /^src\/pages\/[^/]+\.(ts|tsx|js|jsx)$/,
    // Next.js 13+ app dir
    /^app\/.*\/page\.(ts|tsx|js|jsx)$/,
    /^src\/app\/.*\/page\.(ts|tsx|js|jsx)$/,
    // Nuxt / SvelteKit / Remix
    /^src\/routes\/.+\.(ts|tsx|js|jsx|svelte|vue)$/i,
    /^app\/routes\/.+\.(ts|tsx|js|jsx)$/,
    // Angular
    /app-routing\.module\.ts$/i,
    // Services / API layers
    /^src\/services\//,
    /^src\/api\//,
    /^app\/api\//,
    // Root meta
    /^package\.json$/,
    /^README\.md$/i,
  ];

  const interesting = tree
    .filter((f) => f && f.type === 'blob' && f.path && (!f.size || f.size < 80000))
    .filter((f) => RELEVANT.some((rx) => rx.test(f.path)));

  // Prioritize router files; cap at 25 files
  interesting.sort((a, b) => {
    const isRouterA = /router|routes|App\.|main\./i.test(a.path) ? 0 : 1;
    const isRouterB = /router|routes|App\.|main\./i.test(b.path) ? 0 : 1;
    return isRouterA - isRouterB;
  });
  const filesToFetch = interesting.slice(0, 25);

  if (send) send('repo_files', { count: filesToFetch.length, files: filesToFetch.map((f) => f.path) });

  // 4) Fetch contents of each relevant file (batched, parallel of 5)
  let body = '=== GIT REPO: ' + owner + '/' + repo + ' (branch ' + branch + ') ===\n';
  if (meta.description) body += 'Description: ' + meta.description + '\n';
  if (meta.language) body += 'Primary language: ' + meta.language + '\n';
  body += '\n';

  const rawBase = 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/' + branch + '/';
  const batchSize = 5;
  for (let i = 0; i < filesToFetch.length; i += batchSize) {
    const batch = filesToFetch.slice(i, i + batchSize);
    const results = await Promise.all(
      batch.map(async (f) => {
        try {
          const rawHeaders = {};
          if (token) rawHeaders.Authorization = 'token ' + token;
          const r = await fetch(rawBase + f.path, {
            headers: rawHeaders,
            signal: AbortSignal.timeout(8000),
          });
          if (!r.ok) return null;
          const text = await r.text();
          return { path: f.path, content: text.substring(0, 3000) };
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) {
      if (!r) continue;
      body += '=== FILE: ' + r.path + ' ===\n' + r.content + '\n\n';
      if (body.length > 50000) return body; // hard cap for Gemini context
    }
  }
  return body;
}
