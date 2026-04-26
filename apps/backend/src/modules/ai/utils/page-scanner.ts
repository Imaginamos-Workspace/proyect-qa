/**
 * Page scanner for the AI refine flow.
 *
 * Design principles:
 *  1. AGNOSTIC — works for any URL, any framework including SPAs (React/Vue/
 *     Angular) because it uses Jina Reader API (r.jina.ai) as the primary
 *     fetcher. Jina renders JavaScript server-side and returns clean Markdown
 *     with real DOM content. No Chromium needed in the serverless function.
 *  2. BULLETPROOF — never throws. Strategy:
 *       a. Try Jina Reader (renders JS, handles SPAs) → returns Markdown
 *       b. If Jina fails → try plain HTML fetch + node-html-parser (static HTML)
 *       c. If both fail → return null
 *     The caller always falls back to code+feedback-only refine on null.
 *  3. SERVERLESS-SAFE — native fetch + node-html-parser. Fits Vercel limits.
 *
 * Note on auth-walled pages: Jina and direct fetch both see only the public
 * HTML. For login-protected pages, that's usually the login form itself —
 * which is exactly what most failing login tests need.
 */

import { parse, HTMLElement } from 'node-html-parser';

export interface DomElementSnapshot {
  tag: string;
  id?: string;
  name?: string;
  type?: string;
  role?: string;
  text?: string;
  placeholder?: string;
  ariaLabel?: string;
  labelText?: string;
  href?: string;
  testId?: string;
}

export interface DomFormSnapshot {
  action?: string;
  method?: string;
  fields: DomElementSnapshot[];
}

export interface DomSnapshot {
  url: string;
  title?: string;
  /** True when the page appears to be an empty SPA shell. */
  looksLikeSpaShell: boolean;
  inputs: DomElementSnapshot[];
  buttons: DomElementSnapshot[];
  links: DomElementSnapshot[];
  headings: { level: number; text: string }[];
  forms: DomFormSnapshot[];
  /** Raw labels + legends (for associating with inputs). */
  labels: { htmlFor?: string; text: string }[];
}

const JINA_TIMEOUT_MS = 15000; // Jina renders JS — needs more time
const FETCH_TIMEOUT_MS = 8000;  // Plain HTML fallback
const MAX_HTML_BYTES = 2_000_000; // 2MB cap
const MAX_ELEMENTS_PER_CATEGORY = 80;
const JINA_BASE = 'https://r.jina.ai/';

/**
 * Safely truncate + trim text content.
 */
function text(el: HTMLElement, max = 120): string | undefined {
  const t = (el.text || '').trim().replace(/\s+/g, ' ');
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) + '…' : t;
}

function attr(el: HTMLElement, name: string): string | undefined {
  const v = el.getAttribute(name);
  return v && v.trim() ? v.trim() : undefined;
}

/**
 * Extract path from the first `page.goto(...)` call in the playwright code.
 * Returns null if no valid path is found. Handles string literals (single,
 * double, template) and both absolute URLs and relative paths.
 */
export function extractGotoPath(code: string): string | null {
  if (!code) return null;
  // Match page.goto('...'), page.goto("..."), page.goto(`...`)
  const match = code.match(/page\.goto\s*\(\s*['"`]([^'"`]+)['"`]/);
  if (!match) return null;
  const raw = match[1].trim();
  if (!raw) return null;
  // Absolute URL → return the pathname + search + hash
  if (/^https?:\/\//i.test(raw)) {
    try {
      const u = new URL(raw);
      return u.pathname + u.search + u.hash;
    } catch {
      return null;
    }
  }
  // Already a relative path
  return raw.startsWith('/') ? raw : '/' + raw;
}

/**
 * Build the URL to scan by joining project_base_url + path. Returns null if
 * the resulting URL is invalid.
 */
export function buildScanUrl(
  baseUrl: string | undefined,
  path: string | null,
): string | null {
  if (!baseUrl) return null;
  try {
    // URL constructor handles trailing slashes and relative/absolute correctly
    const resolved = new URL(path || '/', baseUrl);
    // Only http/https — protect against file://, javascript:, etc.
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
      return null;
    }
    return resolved.toString();
  } catch {
    return null;
  }
}

/**
 * Tier 1a: Fetch via Jina Reader API in **HTML mode**.
 * Jina renders JavaScript server-side. Setting `X-Return-Format: html` makes
 * Jina return the RENDERED HTML (post-JS execution) so we get every real
 * attribute: placeholder, name, id, type, aria-label, data-testid.
 *
 * This is the gold standard: real DOM after JS, with full attribute fidelity.
 * Markdown mode (Tier 1b) loses these attributes — the AI then guesses.
 */
async function fetchViaJinaHtml(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JINA_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'Accept': 'text/html',
      'X-Return-Format': 'html',
    };
    const apiKey = process.env.JINA_API_KEY;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(JINA_BASE + url, {
      method: 'GET',
      signal: controller.signal,
      headers,
    });
    if (!res.ok) return null;
    const html = await res.text();
    if (!html || html.length < 200) return null; // sanity check
    return html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tier 1b: Fetch via Jina Reader API in Markdown mode (legacy fallback).
 * Used if HTML mode fails. Returns markdown text or null.
 */
async function fetchViaJina(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), JINA_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { 'Accept': 'text/markdown' };
    const apiKey = process.env.JINA_API_KEY;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

    const res = await fetch(JINA_BASE + url, {
      method: 'GET',
      signal: controller.signal,
      headers,
    });
    if (!res.ok) return null;
    const md = await res.text();
    return md.length > MAX_HTML_BYTES ? md.slice(0, MAX_HTML_BYTES) : md;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tier 2: Plain HTML fetch fallback.
 * Used when Jina is unavailable. Works well for SSR/SSG sites.
 * Returns the HTML string, or null on any failure.
 */
async function fetchHtmlDirect(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; QA-Platform-Scanner/1.0) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,es;q=0.8',
      },
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('html') && !contentType.includes('xml')) return null;
    const contentLength = Number(res.headers.get('content-length') || 0);
    if (contentLength > MAX_HTML_BYTES) return null;
    const html = await res.text();
    return html.length > MAX_HTML_BYTES ? html.slice(0, MAX_HTML_BYTES) : html;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build a DomSnapshot from Jina Reader's Markdown output.
 *
 * Jina returns a structured Markdown with:
 *  - Page title in the first H1/heading line
 *  - All visible text content rendered (including JS-rendered SPAs)
 *  - Links as [text](href)
 *  - Input placeholders, button labels, form labels preserved as text
 *
 * We extract what we can from the Markdown text to feed the AI.
 * The snapshot is marked `looksLikeSpaShell: false` since Jina always
 * renders the JS — what we get IS the real page content.
 */
function buildSnapshotFromMarkdown(url: string, markdown: string): DomSnapshot {
  const lines = markdown.split('\n');

  // Title: first non-empty line or first H1
  let title: string | undefined;
  const h1 = lines.find((l) => l.startsWith('# '));
  if (h1) title = h1.replace(/^#+\s*/, '').trim();
  if (!title) {
    const urlMatch = markdown.match(/Title:\s*(.+)/i);
    if (urlMatch) title = urlMatch[1].trim();
  }

  // Headings
  const headings: DomSnapshot['headings'] = [];
  lines.forEach((l) => {
    const m = l.match(/^(#{1,6})\s+(.+)/);
    if (m) {
      headings.push({ level: m[1].length, text: m[2].trim().slice(0, 120) });
    }
  });

  // Links: [text](href)
  const links: DomElementSnapshot[] = [];
  const linkRe = /\[([^\]]+)\]\((https?:\/\/[^)]+|\/[^)]*)\)/g;
  let lm: RegExpExecArray | null;
  while ((lm = linkRe.exec(markdown)) !== null && links.length < MAX_ELEMENTS_PER_CATEGORY) {
    links.push({ tag: 'a', text: lm[1].trim().slice(0, 80), href: lm[2] });
  }

  // Inputs: Jina preserves placeholder text in various forms.
  // Look for patterns like: "Email", "Password", placeholder=... in the markdown.
  // Also scan for input-like label patterns.
  const inputs: DomElementSnapshot[] = [];
  const inputPatterns = [
    // Jina often renders inputs as form field descriptors
    /(?:input|field|placeholder)[:\s]+["']?([^"'\n,]+)["']?/gi,
    // Label: value patterns
    /^[\s-]*([A-Z][^:\n]{2,30}):\s*$/gm,
  ];
  for (const re of inputPatterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(markdown)) !== null && inputs.length < 20) {
      const placeholder = m[1].trim();
      if (placeholder.length > 2 && placeholder.length < 60) {
        inputs.push({ tag: 'input', placeholder });
      }
    }
  }

  // Buttons: lines with button-like text patterns
  const buttons: DomElementSnapshot[] = [];
  const buttonRe = /\[?(submit|login|sign\s*in|register|search|send|save|continue|next|confirm|cancel|close|ok|aceptar|iniciar|ingresar|entrar|guardar|enviar|buscar|continuar|siguiente)[^\n]*/gi;
  let bm: RegExpExecArray | null;
  while ((bm = buttonRe.exec(markdown)) !== null && buttons.length < 20) {
    buttons.push({ tag: 'button', text: bm[0].replace(/[\[\]]/g, '').trim().slice(0, 80) });
  }

  // The raw markdown IS the page snapshot for the AI — pass it directly in
  // the summary rather than trying to reconstruct the full DOM.
  // We store it as a special field that summarizeSnapshotForPrompt will use.
  return {
    url,
    title,
    looksLikeSpaShell: false, // Jina renders JS — real content guaranteed
    inputs,
    buttons,
    links,
    headings,
    forms: [],
    labels: [],
    _jinaMarkdown: markdown.slice(0, 8000), // cap to keep prompt size bounded
  } as DomSnapshot & { _jinaMarkdown: string };
}

/**
 * Heuristic: does this HTML look like an empty SPA shell (React/Vue/Angular
 * root with no meaningful content)?
 * We check body content length and presence of interactive elements.
 */
function detectSpaShell(root: HTMLElement): boolean {
  const body = root.querySelector('body');
  if (!body) return true;
  const bodyText = (body.text || '').trim();
  const inputs = body.querySelectorAll('input').length;
  const buttons = body.querySelectorAll('button').length;
  const forms = body.querySelectorAll('form').length;
  // If almost no content AND no interactive elements, it's an SPA shell.
  if (bodyText.length < 100 && inputs === 0 && buttons === 0 && forms === 0) {
    return true;
  }
  return false;
}

function snapshotElement(el: HTMLElement): DomElementSnapshot {
  return {
    tag: el.tagName.toLowerCase(),
    id: attr(el, 'id'),
    name: attr(el, 'name'),
    type: attr(el, 'type'),
    role: attr(el, 'role'),
    text: text(el, 80),
    placeholder: attr(el, 'placeholder'),
    ariaLabel: attr(el, 'aria-label'),
    href: attr(el, 'href'),
    testId: attr(el, 'data-testid') || attr(el, 'data-test-id') || attr(el, 'data-test'),
  };
}

/**
 * Build a structured DomSnapshot from rendered HTML using node-html-parser.
 * Extracts real attributes for every input, button, link, and form.
 * This is the FIDELITY-PRESERVING path — used by both Jina HTML and plain
 * HTML tiers.
 */
function buildSnapshotFromHtml(url: string, html: string): DomSnapshot | null {
  let root: HTMLElement;
  try {
    root = parse(html, { blockTextElements: { script: false, style: false } });
  } catch {
    return null;
  }

  const looksLikeSpaShell = detectSpaShell(root);

  const titleEl = root.querySelector('title');
  const title = titleEl ? text(titleEl, 200) : undefined;

  const labels: DomSnapshot['labels'] = [];
  root.querySelectorAll('label').forEach((el) => {
    const t = text(el, 80);
    if (!t) return;
    labels.push({ htmlFor: attr(el, 'for'), text: t });
  });

  const inputs: DomElementSnapshot[] = [];
  root
    .querySelectorAll('input, select, textarea')
    .slice(0, MAX_ELEMENTS_PER_CATEGORY)
    .forEach((el) => {
      const snap = snapshotElement(el);
      if (snap.type === 'hidden') return;
      if (snap.id) {
        const lbl = labels.find((l) => l.htmlFor === snap.id);
        if (lbl) snap.labelText = lbl.text;
      }
      inputs.push(snap);
    });

  const buttons: DomElementSnapshot[] = [];
  root
    .querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')
    .slice(0, MAX_ELEMENTS_PER_CATEGORY)
    .forEach((el) => {
      buttons.push(snapshotElement(el));
    });

  const links: DomElementSnapshot[] = [];
  root
    .querySelectorAll('a[href]')
    .slice(0, MAX_ELEMENTS_PER_CATEGORY)
    .forEach((el) => {
      const href = attr(el, 'href');
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
      links.push(snapshotElement(el));
    });

  const headings: DomSnapshot['headings'] = [];
  root.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach((el) => {
    const t = text(el, 120);
    if (!t) return;
    headings.push({ level: parseInt(el.tagName[1]), text: t });
  });

  const forms: DomFormSnapshot[] = [];
  root.querySelectorAll('form').forEach((form) => {
    const fields: DomElementSnapshot[] = [];
    form.querySelectorAll('input, select, textarea').forEach((el) => {
      const snap = snapshotElement(el);
      if (snap.type === 'hidden') return;
      if (snap.id) {
        const lbl = labels.find((l) => l.htmlFor === snap.id);
        if (lbl) snap.labelText = lbl.text;
      }
      fields.push(snap);
    });
    forms.push({
      action: attr(form, 'action'),
      method: (attr(form, 'method') || 'get').toLowerCase(),
      fields,
    });
  });

  return { url, title, looksLikeSpaShell, inputs, buttons, links, headings, forms, labels };
}

/**
 * Main entry. Returns a DomSnapshot on success, null on any failure.
 * Guaranteed not to throw. Strategy (in priority order):
 *   1. Jina Reader in HTML mode (JS-rendered + REAL attributes) ← BEST
 *   2. Plain HTML fetch (works for SSR/SSG, real attributes)
 *   3. Jina Reader in Markdown mode (last resort, attributes lost)
 *   4. Return null → caller falls back gracefully
 */
export async function scanPage(url: string): Promise<DomSnapshot | null> {
  try {
    // --- Tier 1: Jina Reader HTML mode (rendered JS + full attributes) ---
    const jinaHtml = await fetchViaJinaHtml(url);
    if (jinaHtml) {
      const snap = buildSnapshotFromHtml(url, jinaHtml);
      if (snap && (snap.inputs.length > 0 || snap.buttons.length > 0 || snap.forms.length > 0)) {
        return snap;
      }
      // If snap was empty (rare — pre-render returned blank shell), keep falling through
    }

    // --- Tier 2: Plain HTML fallback (SSR/SSG sites) ---
    const html = await fetchHtmlDirect(url);
    if (html) {
      const snap = buildSnapshotFromHtml(url, html);
      if (snap && (snap.inputs.length > 0 || snap.buttons.length > 0 || snap.forms.length > 0)) {
        return snap;
      }
    }

    // --- Tier 3: Jina Markdown (last resort — attributes are guessed) ---
    const jinaMarkdown = await fetchViaJina(url);
    if (jinaMarkdown) {
      return buildSnapshotFromMarkdown(url, jinaMarkdown);
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Summarize a DomSnapshot into a compact text block for the prompt.
 * When the snapshot came from Jina (has _jinaMarkdown), we pass the
 * Markdown directly — it's richer than any structured extraction we could do.
 * Keeps the token count bounded.
 */
export function summarizeSnapshotForPrompt(snap: DomSnapshot): string {
  // If we have a Jina Markdown snapshot, use it directly — it's the real
  // JS-rendered page content, which is more useful for the AI than our
  // structured extraction.
  const jinaSnap = snap as DomSnapshot & { _jinaMarkdown?: string };
  if (jinaSnap._jinaMarkdown) {
    return [
      `URL: ${snap.url}`,
      snap.title ? `Title: ${snap.title}` : '',
      'Source: Jina Reader (JavaScript-rendered — real DOM content):',
      '---',
      jinaSnap._jinaMarkdown,
      '---',
    ].filter(Boolean).join('\n');
  }

  const lines: string[] = [];
  lines.push(`URL: ${snap.url}`);
  if (snap.title) lines.push(`Title: ${snap.title}`);
  if (snap.looksLikeSpaShell) {
    lines.push(
      'WARNING: The fetched HTML looks like an empty SPA shell — the page probably renders content via JavaScript. The DOM info below is what was available in the static HTML. Use it as a hint, but trust the existing test code where the snapshot is empty.',
    );
  }

  if (snap.headings.length) {
    lines.push('Headings:');
    snap.headings.slice(0, 10).forEach((h) =>
      lines.push(`  - H${h.level}: ${h.text}`),
    );
  }

  if (snap.forms.length) {
    lines.push('Forms:');
    snap.forms.slice(0, 5).forEach((f, i) => {
      lines.push(`  Form ${i + 1} (method=${f.method}${f.action ? `, action=${f.action}` : ''}):`);
      f.fields.slice(0, 15).forEach((fld) => {
        lines.push(
          `    - ${fld.tag}${fld.type ? `[type=${fld.type}]` : ''} ${fieldDescriptors(fld)}`,
        );
      });
    });
  }

  if (snap.inputs.length && !snap.forms.length) {
    lines.push('Inputs (no enclosing form):');
    snap.inputs.slice(0, 20).forEach((el) =>
      lines.push(`  - ${el.tag}${el.type ? `[type=${el.type}]` : ''} ${fieldDescriptors(el)}`),
    );
  }

  if (snap.buttons.length) {
    lines.push('Buttons:');
    snap.buttons.slice(0, 20).forEach((el) =>
      lines.push(`  - ${buttonDescriptors(el)}`),
    );
  }

  if (snap.links.length) {
    lines.push('Links:');
    snap.links.slice(0, 15).forEach((el) =>
      lines.push(`  - "${el.text || '(no text)'}" → ${el.href}`),
    );
  }

  return lines.join('\n');
}

function fieldDescriptors(el: DomElementSnapshot): string {
  const parts: string[] = [];
  if (el.name) parts.push(`name="${el.name}"`);
  if (el.id) parts.push(`id="${el.id}"`);
  if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
  if (el.labelText) parts.push(`label="${el.labelText}"`);
  if (el.ariaLabel) parts.push(`aria-label="${el.ariaLabel}"`);
  if (el.testId) parts.push(`data-testid="${el.testId}"`);
  return parts.join(' ');
}

function buttonDescriptors(el: DomElementSnapshot): string {
  const parts: string[] = [];
  if (el.text) parts.push(`text="${el.text}"`);
  if (el.type && el.type !== 'button') parts.push(`type="${el.type}"`);
  if (el.id) parts.push(`id="${el.id}"`);
  if (el.name) parts.push(`name="${el.name}"`);
  if (el.ariaLabel) parts.push(`aria-label="${el.ariaLabel}"`);
  if (el.testId) parts.push(`data-testid="${el.testId}"`);
  return parts.join(' ') || '(unlabeled button)';
}
