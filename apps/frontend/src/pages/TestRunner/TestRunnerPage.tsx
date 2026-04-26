import { useState, useMemo, useCallback } from 'react';
import { useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import { useTestRuns } from '@/hooks/use-test-runs';
import { useTestSuites, useTestCases, useDeleteTestSuite } from '@/hooks/use-test-cases';
import { useProject } from '@/hooks/use-projects';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { TestCase, TestSuite } from '@qa/shared-types';
import {
  CheckCircle2,
  XCircle,
  Clock,
  Loader2,
  ChevronDown,
  ChevronRight,
  ArrowUp,
  ArrowDown,
  Download,
  Copy,
  Check,
  Terminal,
  FileCode,
  ListChecks,
  Tag,
  Trash2,
  Eye,
  EyeOff,
  Video,
  Camera,
  Activity,
  Globe,
  MousePointerClick,
  Keyboard,
  Hourglass,
  Pencil,
  AlertCircle,
} from 'lucide-react';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface GroupedTests {
  suite: TestSuite;
  cases: TestCase[];
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

const PRIORITY_VARIANT: Record<string, 'destructive' | 'warning' | 'info' | 'secondary'> = {
  critical: 'destructive',
  high: 'warning',
  medium: 'info',
  low: 'secondary',
};

const TYPE_LABELS: Record<string, string> = {
  e2e: 'E2E',
  regression: 'Regression',
  visual: 'Visual',
  accessibility: 'A11y',
  performance: 'Perf',
  api: 'API',
  cross_browser: 'Cross-Browser',
  responsive: 'Responsive',
};

function codeSummary(code: string, maxLines = 8): string {
  return code.split('\n').slice(0, maxLines).join('\n');
}

/**
 * Sanitize a single test's playwright_code block.
 * - Strip markdown code fences (``` / ```typescript) that LLMs sometimes emit
 * - Strip per-case `import ... from '@playwright/test'` (one global import
 *   is added to the bundled file instead)
 * - Strip stray `export {}` / `export default` at the end that don't belong
 *   inside a test spec
 * - Trim whitespace
 */
function sanitizeTestCode(raw: string): string {
  let code = raw || '';
  code = code.replace(/^```(?:typescript|ts|javascript|js)?\s*\n?/gim, '');
  code = code.replace(/\n?```\s*$/gim, '');
  code = code.replace(
    /^\s*import\s*\{[^}]*\}\s*from\s*['"]@playwright\/test['"];?\s*$/gim,
    '',
  );
  code = code.replace(/^\s*export\s+(default\s+)?.*$/gim, '');
  // Fix broken regex literals like /pattern/.*/ → /pattern.*/ (LLM sometimes
  // puts content after the closing slash instead of before it)
  code = code.replace(/\/((?:[^/\n\\]|\\.)+)\/(\.?\*)\//g, (_, p, suffix) => `/${p}${suffix}/`);
  // Runtime-validate every regex literal. If `new RegExp()` rejects it,
  // replace with a permissive fallback so the spec still parses.
  code = code.replace(
    /(?<![A-Za-z0-9_)\]])\/((?:[^/\n\\]|\\.)+)\/([gimsuy]*)/g,
    (match, pattern: string, flags: string) => {
      try {
        new RegExp(pattern, flags);
        return match;
      } catch {
        return `/.*/${flags}`;
      }
    },
  );
  return code.trim();
}

/**
 * Quick structural check: does this block look like a valid Playwright test?
 * We require a top-level `test(` or `test.describe(` call and balanced braces.
 * Not a full parser — just a sanity filter so one broken case doesn't prevent
 * the other cases from running.
 */
function looksLikeValidTest(code: string): boolean {
  if (!/\btest(?:\.describe|\.only|\.skip)?\s*\(/.test(code)) return false;
  // Balance braces, parens and brackets, skipping content inside strings,
  // template literals, regex literals and comments. This catches the vast
  // majority of malformed LLM output without a full TS parser.
  let brace = 0, paren = 0, bracket = 0;
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];
    // Line comment
    if (ch === '/' && next === '/') {
      while (i < n && code[i] !== '\n') i++;
      continue;
    }
    // Block comment
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < n && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // String literal
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      while (i < n && code[i] !== quote) {
        if (code[i] === '\\') i += 2; else i++;
      }
      i++;
      continue;
    }
    // Template literal (no nested ${} balance — good enough)
    if (ch === '`') {
      i++;
      while (i < n && code[i] !== '`') {
        if (code[i] === '\\') i += 2; else i++;
      }
      i++;
      continue;
    }
    if (ch === '{') brace++;
    else if (ch === '}') brace--;
    else if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
    if (brace < 0 || paren < 0 || bracket < 0) return false;
    i++;
  }
  return brace === 0 && paren === 0 && bracket === 0;
}

/**
 * Bundle every selected test into a single spec file.
 * Resilient: broken blocks are skipped with a comment, so remaining tests
 * still execute. Works for 1 test or 100.
 */
/**
 * Rewrite every relative `page.goto('/...')` to an absolute URL using the
 * project's base_url. This is the bulletproof guarantee: even if the
 * playwright.config.ts has no baseURL (cached old version, project without
 * base_url, etc.), the test still runs because every navigation is already
 * absolute. Idempotent — already-absolute URLs are left alone.
 */
function rewriteRelativeGotos(code: string, baseUrl: string): string {
  if (!baseUrl) return code;
  const cleanBase = baseUrl.replace(/\/+$/, '');
  // Step 1: page.goto with relative path → make absolute.
  let out = code.replace(
    /(\bpage\.goto\s*\(\s*)(['"`])(\/[^'"`]*?)\2/g,
    (_match, prefix, quote, path) => `${prefix}${quote}${cleanBase}${path}${quote}`,
  );

  // Step 2: page.goto with absolute URL on ANY host → strip to path, then
  //         re-prefix with the project base. This guarantees the test always
  //         hits the project the user configured, even if the AI guessed a
  //         different host (e.g. localhost, staging.example.com).
  out = out.replace(
    /(\bpage\.goto\s*\(\s*)(['"`])(https?:\/\/[^'"`]+)\2/g,
    (_match, prefix, quote, fullUrl) => {
      try {
        const u = new URL(fullUrl);
        const path = u.pathname + u.search + u.hash;
        return `${prefix}${quote}${cleanBase}${path}${quote}`;
      } catch {
        return _match;
      }
    },
  );

  // Step 3: expect(page).toHaveURL('https://...') with absolute URL →
  //         convert to a regex that matches the PATH only. Trailing slashes
  //         are tolerated. Avoids false failures when the host or trailing
  //         slash differs from what the AI guessed.
  out = out.replace(
    /(\bexpect\s*\(\s*page\s*\)\s*\.\s*toHaveURL\s*\(\s*)(['"`])(https?:\/\/[^'"`]+)\2(\s*\))/g,
    (_match, prefix, _quote, fullUrl, suffix) => {
      try {
        const u = new URL(fullUrl);
        const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
        // Escape regex special chars in the path
        const escaped = path.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
        return `${prefix}new RegExp('^${escaped}\\\\/?(\\\\?.*)?$')${suffix}`;
      } catch {
        return _match;
      }
    },
  );

  // Step 4: expect(page).toHaveURL('/login') with relative path → convert
  //         to anchored regex that tolerates trailing slash + query string.
  out = out.replace(
    /(\bexpect\s*\(\s*page\s*\)\s*\.\s*toHaveURL\s*\(\s*)(['"`])(\/[^'"`]*?)\2(\s*\))/g,
    (_match, prefix, _quote, path, suffix) => {
      const trimmed = path.replace(/\/+$/, '') || '/';
      const escaped = trimmed.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      return `${prefix}new RegExp('${escaped}\\\\/?(\\\\?.*)?$')${suffix}`;
    },
  );

  return out;
}

function generatePlaywrightFile(tests: TestCase[], baseUrl: string): string {
  const blocks: string[] = [];
  for (const tc of tests) {
    let cleaned = sanitizeTestCode(tc.playwright_code);
    if (!cleaned) continue;
    if (!looksLikeValidTest(cleaned)) {
      blocks.push(
        `// ⚠️ SKIPPED (syntax issue) — "${tc.title.replace(/"/g, '\\"')}"\n`
          + `//   Fix in the UI editor, then re-download this spec.\n`,
      );
      continue;
    }
    // Bulletproof: make every navigation absolute using the project base URL.
    cleaned = rewriteRelativeGotos(cleaned, baseUrl);
    blocks.push(`// ═══ ${tc.title} ═══\n${cleaned}`);
  }

  const header = [
    `// Generated by QA Platform — ${new Date().toISOString()}`,
    `// ${tests.length} test case(s) bundled`,
    baseUrl ? `// Base URL: ${baseUrl}` : `// ⚠️ No base URL configured for this project`,
    `import { test, expect } from '@playwright/test';`,
    '',
  ].join('\n');

  return header + '\n' + blocks.join('\n\n') + '\n';
}

function downloadBlob(content: string, filename: string, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/* ------------------------------------------------------------------ */
/*  Reactive Playwright config + command builders                      */
/* ------------------------------------------------------------------ */

type BrowserId = 'chromium' | 'firefox' | 'webkit';
type VideoMode = 'off' | 'on' | 'retain-on-failure';
type ScreenshotMode = 'off' | 'only-on-failure' | 'on';
type TraceMode = 'off' | 'on-first-retry' | 'on' | 'retain-on-failure';

interface RunConfig {
  browser: BrowserId;
  headed: boolean;       // true = visible browser window
  video: VideoMode;
  screenshot: ScreenshotMode;
  trace: TraceMode;
  slowMo: number;        // ms — 0 = normal speed, 250+ = easier to watch
  baseUrl: string;       // project base URL for playwright baseURL
}

const DEVICE_BY_BROWSER: Record<BrowserId, string> = {
  chromium: 'Desktop Chrome',
  firefox: 'Desktop Firefox',
  webkit: 'Desktop Safari',
};

/** Generates playwright.config.ts content as a string based on run options. */
function buildPlaywrightConfig(cfg: RunConfig): string {
  // Only emit baseURL when truthy. An empty string makes Playwright reject
  // relative paths like '/login' with "Cannot navigate to invalid URL".
  const baseUrlLine = cfg.baseUrl ? `\n    baseURL: '${cfg.baseUrl}',` : '';
  return `import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  reporter: [['html', { open: 'never' }], ['list']],
  timeout: 60000,
  use: {${baseUrlLine}
    headless: ${!cfg.headed},
    trace: '${cfg.trace}',
    screenshot: '${cfg.screenshot}',
    video: '${cfg.video}',
    actionTimeout: 15000,
    navigationTimeout: 30000,${cfg.slowMo > 0 ? `\n    launchOptions: { slowMo: ${cfg.slowMo} },` : ''}
  },
  projects: [{
    name: '${cfg.browser}',
    use: { ...devices['${DEVICE_BY_BROWSER[cfg.browser]}'] },
  }],
});
`;
}

/** UTF-8-safe base64 encoder (btoa() only handles Latin-1). */
function utf8ToBase64(str: string): string {
  return btoa(
    new TextEncoder()
      .encode(str)
      .reduce((acc, byte) => acc + String.fromCharCode(byte), ''),
  );
}

function buildMacCommand(cfg: RunConfig, configB64: string): string {
  return [
    `command -v node >/dev/null 2>&1 || { echo "Instala Node.js primero: https://nodejs.org"; exit 1; }`,
    `cd ~/Downloads`,
    `mkdir -p qa-tests`,
    `mv -f generated-tests.spec.ts qa-tests/ 2>/dev/null || true`,
    `cd qa-tests`,
    `[ -f package.json ] || npm init -y >/dev/null 2>&1`,
    `[ -d node_modules/@playwright/test ] || npm i -D @playwright/test >/dev/null 2>&1`,
    `npx -y playwright install ${cfg.browser} >/dev/null 2>&1`,
    `echo ${configB64} | base64 -d > playwright.config.ts`,
    `(npx playwright test generated-tests.spec.ts --project=${cfg.browser}${cfg.headed ? ' --headed' : ''} --reporter=html || true)`,
    `lsof -ti:9323 | xargs kill -9 2>/dev/null || true`,
    `npx playwright show-report`,
  ].join(' && ');
}

function buildWindowsCommand(cfg: RunConfig, configB64: string): string {
  return [
    `if (!(Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Instala Node.js primero: https://nodejs.org'; exit 1 }`,
    `cd $env:USERPROFILE\\Downloads`,
    `New-Item -ItemType Directory -Force qa-tests | Out-Null`,
    `Move-Item -Force generated-tests.spec.ts qa-tests\\ -ErrorAction SilentlyContinue`,
    `cd qa-tests`,
    `if (!(Test-Path package.json)) { npm init -y 2>$null | Out-Null }`,
    `if (!(Test-Path node_modules\\@playwright\\test)) { npm i -D @playwright/test 2>$null | Out-Null }`,
    `npx -y playwright install ${cfg.browser} 2>$null | Out-Null`,
    `[IO.File]::WriteAllBytes('playwright.config.ts', [Convert]::FromBase64String('${configB64}'))`,
    `npx playwright test generated-tests.spec.ts --project=${cfg.browser}${cfg.headed ? ' --headed' : ''} --reporter=html`,
    `Get-NetTCPConnection -LocalPort 9323 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
    `npx playwright show-report`,
  ].join('; ');
}

/* ------------------------------------------------------------------ */
/*  Human-readable action extractor                                    */
/* ------------------------------------------------------------------ */

type ActionKind =
  | 'navigate'
  | 'click'
  | 'fill'
  | 'press'
  | 'assert'
  | 'wait'
  | 'screenshot'
  | 'other';

interface TestAction {
  kind: ActionKind;
  description: string;
  rawLine: string;
}

/**
 * Extract a human-readable step list from playwright code. Best-effort parser
 * — recognizes the most common patterns and falls back to the raw line if it
 * doesn't match. Purpose: let the user see at a glance WHAT each test does
 * and WHAT is being asserted, without reading the code.
 */
function parseTestActions(code: string): TestAction[] {
  const actions: TestAction[] = [];
  const lines = code.split('\n');

  // Helper to pull the first string literal out of a line as the "target"
  const firstString = (s: string): string | null => {
    const m = s.match(/['"`]([^'"`]+)['"`]/);
    return m ? m[1] : null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('//') || line.startsWith('*')) continue;
    if (/^(import|export|test\s*\(|test\.describe|\}\)|\{|\}|const|let|var)/.test(line)) continue;

    // Navigation
    let m = line.match(/page\.goto\(\s*['"`]([^'"`]+)['"`]/);
    if (m) {
      actions.push({ kind: 'navigate', description: `Navega a ${m[1]}`, rawLine: raw });
      continue;
    }

    // Click
    if (/\.click\s*\(/.test(line)) {
      const selector = firstString(line) ?? 'un elemento';
      actions.push({ kind: 'click', description: `Hace clic en "${selector}"`, rawLine: raw });
      continue;
    }

    // Fill / type
    m = line.match(/\.(?:fill|type)\(\s*['"`]([^'"`]*)['"`]/);
    if (m) {
      const selector = firstString(line.split('.fill')[0].split('.type')[0]) ?? 'un campo';
      const value = m[1];
      actions.push({
        kind: 'fill',
        description: `Escribe "${value}" en "${selector}"`,
        rawLine: raw,
      });
      continue;
    }

    // Press key
    m = line.match(/\.press\(\s*['"`]([^'"`]+)['"`]/);
    if (m) {
      actions.push({ kind: 'press', description: `Presiona ${m[1]}`, rawLine: raw });
      continue;
    }

    // Screenshot
    if (/\.screenshot\s*\(/.test(line)) {
      actions.push({ kind: 'screenshot', description: 'Toma captura de pantalla', rawLine: raw });
      continue;
    }

    // Waits
    if (/waitForTimeout|waitForLoadState|waitForURL|waitForSelector/.test(line)) {
      const target = firstString(line);
      actions.push({
        kind: 'wait',
        description: target ? `Espera por "${target}"` : 'Espera',
        rawLine: raw,
      });
      continue;
    }

    // Expect / assertions
    if (/\bexpect\s*\(/.test(line)) {
      let desc = 'Verifica condición';
      if (/toHaveURL/.test(line)) {
        const url = firstString(line);
        desc = url ? `Verifica URL ≈ "${url}"` : 'Verifica URL';
      } else if (/toHaveTitle/.test(line)) {
        const title = firstString(line);
        desc = title ? `Verifica título = "${title}"` : 'Verifica título';
      } else if (/toHaveText|toContainText/.test(line)) {
        const text = line.match(/to(?:Have|Contain)Text\(\s*['"`]([^'"`]+)['"`]/)?.[1];
        desc = text ? `Verifica texto ≈ "${text}"` : 'Verifica texto';
      } else if (/toHaveValue/.test(line)) {
        const val = line.match(/toHaveValue\(\s*['"`]([^'"`]+)['"`]/)?.[1];
        desc = val ? `Verifica valor = "${val}"` : 'Verifica valor';
      } else if (/toBeVisible/.test(line)) {
        const sel = firstString(line) ?? 'elemento';
        desc = `Verifica que "${sel}" es visible`;
      } else if (/toBeHidden/.test(line)) {
        const sel = firstString(line) ?? 'elemento';
        desc = `Verifica que "${sel}" está oculto`;
      } else if (/toBeEnabled/.test(line)) {
        const sel = firstString(line) ?? 'elemento';
        desc = `Verifica que "${sel}" está habilitado`;
      } else if (/toBeDisabled/.test(line)) {
        const sel = firstString(line) ?? 'elemento';
        desc = `Verifica que "${sel}" está deshabilitado`;
      } else if (/toBeChecked/.test(line)) {
        desc = 'Verifica que está marcado';
      } else if (/toHaveCount/.test(line)) {
        const n = line.match(/toHaveCount\(\s*(\d+)/)?.[1];
        desc = n ? `Verifica que hay ${n} elementos` : 'Verifica cantidad';
      }
      actions.push({ kind: 'assert', description: desc, rawLine: raw });
      continue;
    }
  }

  return actions;
}

function iconForAction(kind: ActionKind) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  switch (kind) {
    case 'navigate':
      return <Globe className={`${cls} text-[#3b82f6]`} />;
    case 'click':
      return <MousePointerClick className={`${cls} text-[#8b5cf6]`} />;
    case 'fill':
      return <Pencil className={`${cls} text-[#0ea5e9]`} />;
    case 'press':
      return <Keyboard className={`${cls} text-[#64748b]`} />;
    case 'assert':
      return <CheckCircle2 className={`${cls} text-[#10b981]`} />;
    case 'wait':
      return <Hourglass className={`${cls} text-[#f59e0b]`} />;
    case 'screenshot':
      return <Camera className={`${cls} text-[#ec4899]`} />;
    default:
      return <AlertCircle className={`${cls} text-muted-foreground`} />;
  }
}

/* ------------------------------------------------------------------ */
/*  Main Component                                                     */
/* ------------------------------------------------------------------ */

export function TestRunnerPage() {
  const { t } = useTranslation();
  const { projectId } = useParams<{ projectId: string }>();

  /* Data fetching */
  const { data: project } = useProject(projectId!);
  const { data: suites } = useTestSuites(projectId!);
  const { data: allCases } = useTestCases(projectId!, { status: 'active' });
  const { data: runs, isLoading: runsLoading } = useTestRuns(projectId!);

  /* Mutations */
  const deleteTestSuite = useDeleteTestSuite(projectId!);

  /* Local state */
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedTests, setExpandedTests] = useState<Set<string>>(new Set());
  const [collapsedSuites, setCollapsedSuites] = useState<Set<string>>(new Set());

  /* Run config — all reactive. Changing any of these rebuilds the snippet */
  const [browser, setBrowser] = useState<BrowserId>('chromium');
  const [headed, setHeaded] = useState(true);               // visible browser by default
  const [video, setVideo] = useState<VideoMode>('retain-on-failure');
  const [screenshot, setScreenshot] = useState<ScreenshotMode>('only-on-failure');
  const [trace, setTrace] = useState<TraceMode>('retain-on-failure');
  const [slowMo, setSlowMo] = useState<number>(0);          // ms

  const [copiedCli, setCopiedCli] = useState(false);
  const [activeTab, setActiveTab] = useState<'mac' | 'windows'>('mac');
  const [copiedHowTo, setCopiedHowTo] = useState(false);

  /* Reactive playwright config + commands — rebuild whenever options change */
  const runConfig = useMemo<RunConfig>(
    () => ({ browser, headed, video, screenshot, trace, slowMo, baseUrl: project?.base_url ?? '' }),
    [browser, headed, video, screenshot, trace, slowMo, project?.base_url],
  );
  const pwConfigString = useMemo(() => buildPlaywrightConfig(runConfig), [runConfig]);
  const pwConfigB64 = useMemo(() => utf8ToBase64(pwConfigString), [pwConfigString]);
  const macCommand = useMemo(
    () => buildMacCommand(runConfig, pwConfigB64),
    [runConfig, pwConfigB64],
  );
  const winCommand = useMemo(
    () => buildWindowsCommand(runConfig, pwConfigB64),
    [runConfig, pwConfigB64],
  );
  const activeCommand = activeTab === 'mac' ? macCommand : winCommand;

  /* Group test cases by suite */
  const grouped = useMemo<GroupedTests[]>(() => {
    if (!suites || !allCases) return [];
    return suites
      .map((suite) => ({
        suite,
        cases: allCases.filter((tc) => tc.suite_id === suite.id),
      }))
      .filter((g) => g.cases.length > 0);
  }, [suites, allCases]);

  /* Derived counts */
  const totalTests = allCases?.length ?? 0;
  const selectedCount = selectedIds.size;

  /* Ordered selection for export (maintain insertion order) */
  const [selectionOrder, setSelectionOrder] = useState<string[]>([]);

  const selectedTests = useMemo(() => {
    if (!allCases) return [];
    const ordered = selectionOrder.filter((id) => selectedIds.has(id));
    return ordered.map((id) => allCases.find((tc) => tc.id === id)!).filter(Boolean);
  }, [allCases, selectedIds, selectionOrder]);

  /* ---- Selection helpers ---- */

  const toggleTest = useCallback(
    (id: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
      setSelectionOrder((prev) => {
        if (prev.includes(id)) return prev.filter((x) => x !== id);
        return [...prev, id];
      });
    },
    [],
  );

  const toggleSuiteAll = useCallback(
    (suiteId: string, cases: TestCase[]) => {
      const ids = cases.map((c) => c.id);
      const allSelected = ids.every((id) => selectedIds.has(id));

      setSelectedIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => {
          if (allSelected) {
            next.delete(id);
          } else {
            next.add(id);
          }
        });
        return next;
      });
      setSelectionOrder((prev) => {
        if (allSelected) return prev.filter((id) => !ids.includes(id));
        const newIds = ids.filter((id) => !prev.includes(id));
        return [...prev, ...newIds];
      });
    },
    [selectedIds],
  );

  /* ---- Expand / collapse helpers ---- */

  const toggleTestExpand = useCallback((id: string) => {
    setExpandedTests((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSuiteCollapse = useCallback((id: string) => {
    setCollapsedSuites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  /* ---- Reorder helpers ---- */

  const moveTest = useCallback(
    (id: string, direction: 'up' | 'down') => {
      setSelectionOrder((prev) => {
        const idx = prev.indexOf(id);
        if (idx === -1) return prev;
        const swapIdx = direction === 'up' ? idx - 1 : idx + 1;
        if (swapIdx < 0 || swapIdx >= prev.length) return prev;
        const next = [...prev];
        [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
        return next;
      });
    },
    [],
  );

  /* ---- Delete helpers ---- */

  const handleDeleteSuite = (suiteId: string) => {
    if (confirm(t('runner.confirmDeleteSuite'))) {
      deleteTestSuite.mutate(suiteId);
    }
  };

  const handleDeleteAll = () => {
    if (!suites || suites.length === 0) return;
    if (confirm(t('runner.confirmDeleteAll'))) {
      suites.forEach((suite) => {
        deleteTestSuite.mutate(suite.id);
      });
    }
  };

  /* ---- Export & CLI ---- */

  // Short CLI command for the small "Copy Command" button (reflects options)
  const cliCommand = useMemo(
    () =>
      `npx playwright test generated-tests.spec.ts --project=${browser}${headed ? ' --headed' : ''}`,
    [browser, headed],
  );

  const handleExport = () => {
    if (selectedTests.length === 0) return;
    const content = generatePlaywrightFile(selectedTests, project?.base_url ?? '');
    downloadBlob(content, 'generated-tests.spec.ts');
  };

  const handleCopyCli = async () => {
    await navigator.clipboard.writeText(cliCommand);
    setCopiedCli(true);
    setTimeout(() => setCopiedCli(false), 2000);
  };

  const handleCopyHowTo = async (command: string) => {
    await navigator.clipboard.writeText(command);
    setCopiedHowTo(true);
    setTimeout(() => setCopiedHowTo(false), 2000);
  };

  /* ------------------------------------------------------------------ */
  /*  Render                                                             */
  /* ------------------------------------------------------------------ */

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold text-[#1e1b4b]">{t('runner.title')}</h1>
          <p className="mt-1 text-muted-foreground">
            {t('runner.subtitle')}
          </p>
        </div>
        {grouped.length > 0 && (
          <Button
            variant="outline"
            onClick={handleDeleteAll}
            disabled={deleteTestSuite.isPending}
            className="gap-2 border-red-300 text-red-600 hover:bg-red-50 hover:text-red-700"
          >
            <Trash2 className="h-4 w-4" />
            {t('runner.deleteAll')}
          </Button>
        )}
      </div>

      {/* ------------------------------------------------------------ */}
      {/*  Test Selection by Module / Suite                              */}
      {/* ------------------------------------------------------------ */}
      <div className="space-y-3">
        {grouped.length === 0 && (
          <Card>
            <CardContent className="py-12 text-center text-muted-foreground">
              <ListChecks className="mx-auto mb-3 h-10 w-10 text-muted-foreground/50" />
              <p>{t('runner.noTests')}</p>
            </CardContent>
          </Card>
        )}

        {grouped.map(({ suite, cases }) => {
          const isCollapsed = collapsedSuites.has(suite.id);
          const allSelected = cases.every((c) => selectedIds.has(c.id));
          const someSelected = cases.some((c) => selectedIds.has(c.id));
          const selectedInSuite = cases.filter((c) => selectedIds.has(c.id)).length;

          return (
            <Card key={suite.id} className="overflow-hidden border-[#7c3aed]/20">
              {/* Suite header */}
              <div className="flex w-full items-center justify-between bg-[#f5f3ff] px-4 py-3 hover:bg-[#ede9fe] transition-colors">
                <button
                  type="button"
                  onClick={() => toggleSuiteCollapse(suite.id)}
                  className="flex items-center gap-3 text-left flex-1"
                >
                  {isCollapsed ? (
                    <ChevronRight className="h-4 w-4 text-[#7c3aed]" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-[#7c3aed]" />
                  )}
                  <span className="font-semibold text-[#1e1b4b]">{suite.name}</span>
                  <Badge variant="info">{TYPE_LABELS[suite.test_type] ?? suite.test_type}</Badge>
                  <span className="text-sm text-muted-foreground">
                    ({selectedInSuite}/{cases.length} {t('runner.selected')})
                  </span>
                </button>
                <div className="flex items-center gap-3">
                  <div
                    className="flex items-center gap-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <Checkbox
                      checked={allSelected}
                      data-indeterminate={someSelected && !allSelected ? true : undefined}
                      onCheckedChange={() => toggleSuiteAll(suite.id, cases)}
                      className="border-[#7c3aed] data-[state=checked]:bg-[#7c3aed]"
                    />
                    <span className="text-xs text-muted-foreground">
                      {t('runner.selectAll')}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteSuite(suite.id);
                    }}
                    className="rounded p-1.5 text-muted-foreground hover:text-red-600 hover:bg-red-50 transition-colors"
                    title={t('runner.deleteSuite')}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>

              {/* Test case list */}
              {!isCollapsed && (
                <div className="divide-y">
                  {cases.map((tc) => {
                    const isSelected = selectedIds.has(tc.id);
                    const isExpanded = expandedTests.has(tc.id);
                    const orderIdx = selectionOrder.indexOf(tc.id);

                    return (
                      <div key={tc.id} className="group">
                        {/* Test row */}
                        <div className="flex items-center gap-3 px-4 py-3 hover:bg-[#f5f3ff]/50 transition-colors">
                          <div onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={isSelected}
                              onCheckedChange={() => toggleTest(tc.id)}
                              className="border-[#7c3aed] data-[state=checked]:bg-[#7c3aed]"
                            />
                          </div>

                          <button
                            type="button"
                            onClick={() => toggleTestExpand(tc.id)}
                            className="flex flex-1 items-center gap-2 text-left"
                          >
                            {isExpanded ? (
                              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                            ) : (
                              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                            )}
                            <span className="font-medium text-sm">{tc.title}</span>
                          </button>

                          {/* Badges */}
                          <Badge variant={PRIORITY_VARIANT[tc.priority] ?? 'secondary'} className="text-[10px]">
                            {t(`priority.${tc.priority}`, tc.priority)}
                          </Badge>

                          {/* Reorder buttons (visible when selected) */}
                          {isSelected && (
                            <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                              <button
                                type="button"
                                onClick={() => moveTest(tc.id, 'up')}
                                disabled={orderIdx <= 0}
                                className="rounded p-1 text-muted-foreground hover:text-[#7c3aed] hover:bg-[#f5f3ff] disabled:opacity-30"
                                title={t('testRunner.moveUp', 'Move up')}
                              >
                                <ArrowUp className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                onClick={() => moveTest(tc.id, 'down')}
                                disabled={orderIdx >= selectionOrder.length - 1}
                                className="rounded p-1 text-muted-foreground hover:text-[#7c3aed] hover:bg-[#f5f3ff] disabled:opacity-30"
                                title={t('testRunner.moveDown', 'Move down')}
                              >
                                <ArrowDown className="h-3.5 w-3.5" />
                              </button>
                            </div>
                          )}
                        </div>

                        {/* Expanded detail: readable actions + raw code */}
                        {isExpanded && (
                          <div className="border-t bg-[#f5f3ff]/30 px-12 py-4 space-y-4">
                            {tc.description && (
                              <p className="text-sm text-muted-foreground">{tc.description}</p>
                            )}

                            {tc.tags.length > 0 && (
                              <div className="flex items-center gap-2 flex-wrap">
                                <Tag className="h-3.5 w-3.5 text-muted-foreground" />
                                {tc.tags.map((tag) => (
                                  <Badge key={tag} variant="outline" className="text-[10px]">
                                    {tag}
                                  </Badge>
                                ))}
                              </div>
                            )}

                            {/* Human-readable actions & assertions */}
                            {(() => {
                              const actions = parseTestActions(tc.playwright_code);
                              if (actions.length === 0) return null;
                              const assertCount = actions.filter((a) => a.kind === 'assert').length;
                              const stepCount = actions.length - assertCount;
                              return (
                                <div className="rounded-md border border-[#7c3aed]/20 bg-white p-4">
                                  <div className="mb-3 flex items-center justify-between">
                                    <p className="text-xs font-semibold uppercase tracking-wider text-[#7c3aed]">
                                      Qué hace esta prueba
                                    </p>
                                    <div className="flex gap-2 text-[10px]">
                                      <Badge variant="info" className="text-[10px]">
                                        {stepCount} pasos
                                      </Badge>
                                      <Badge variant="success" className="text-[10px]">
                                        {assertCount} validaciones
                                      </Badge>
                                    </div>
                                  </div>
                                  <ol className="space-y-1.5">
                                    {actions.map((a, i) => (
                                      <li
                                        key={i}
                                        className="flex items-start gap-2 text-xs leading-relaxed"
                                      >
                                        <span className="mt-0.5 w-5 shrink-0 text-right font-mono text-muted-foreground">
                                          {i + 1}.
                                        </span>
                                        {iconForAction(a.kind)}
                                        <span
                                          className={
                                            a.kind === 'assert'
                                              ? 'font-medium text-[#065f46]'
                                              : 'text-[#1e1b4b]'
                                          }
                                        >
                                          {a.description}
                                        </span>
                                      </li>
                                    ))}
                                  </ol>
                                </div>
                              );
                            })()}

                            {/* Raw code preview (collapsible feel via max-height) */}
                            <details className="rounded-md bg-[#1e1b4b] overflow-hidden">
                              <summary className="cursor-pointer px-4 py-2 text-xs font-medium text-purple-200 hover:bg-white/5">
                                Ver código Playwright
                              </summary>
                              <pre className="border-t border-white/10 p-4 text-xs text-green-300 font-mono whitespace-pre overflow-auto max-h-80">
                                {tc.playwright_code}
                              </pre>
                            </details>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </Card>
          );
        })}
      </div>

      {/* Selection summary */}
      {totalTests > 0 && (
        <p className="text-sm font-medium text-[#7c3aed]">
          {t('runner.selectedCount', {
            count: selectedCount,
            total: totalTests,
          })}
        </p>
      )}

      {/* ------------------------------------------------------------ */}
      {/*  Run Options & Export — reactive: snippet rebuilds on change   */}
      {/* ------------------------------------------------------------ */}
      <Card className="border-[#7c3aed]/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg text-[#1e1b4b]">
            <FileCode className="h-5 w-5 text-[#7c3aed]" />
            Opciones de ejecución
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Cada cambio actualiza el comando de abajo en tiempo real.
          </p>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Row 1: Browser + Visibility */}
          <div className="grid gap-4 sm:grid-cols-2">
            {/* Browser segmented */}
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Navegador
              </label>
              <div className="grid grid-cols-3 gap-1 rounded-md bg-muted p-1">
                {(['chromium', 'firefox', 'webkit'] as BrowserId[]).map((b) => (
                  <button
                    key={b}
                    type="button"
                    onClick={() => setBrowser(b)}
                    className={`rounded-sm px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
                      browser === b
                        ? 'bg-white text-[#7c3aed] shadow-sm'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {b === 'webkit' ? 'Safari' : b}
                  </button>
                ))}
              </div>
            </div>

            {/* Visibility toggle (Headed vs Headless) */}
            <div className="space-y-2">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Ventana del navegador
              </label>
              <div className="grid grid-cols-2 gap-1 rounded-md bg-muted p-1">
                <button
                  type="button"
                  onClick={() => setHeaded(true)}
                  className={`flex items-center justify-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition-colors ${
                    headed
                      ? 'bg-white text-[#7c3aed] shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Eye className="h-3.5 w-3.5" />
                  Visible
                </button>
                <button
                  type="button"
                  onClick={() => setHeaded(false)}
                  className={`flex items-center justify-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition-colors ${
                    !headed
                      ? 'bg-white text-[#7c3aed] shadow-sm'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <EyeOff className="h-3.5 w-3.5" />
                  Invisible (headless)
                </button>
              </div>
            </div>
          </div>

          {/* Row 2: Video + Screenshot + Trace */}
          <div className="grid gap-4 md:grid-cols-3">
            {/* Video */}
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Video className="h-3.5 w-3.5" />
                Grabación de video
              </label>
              <select
                value={video}
                onChange={(e) => setVideo(e.target.value as VideoMode)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs focus:ring-2 focus:ring-[#7c3aed]/30 focus:border-[#7c3aed]"
              >
                <option value="off">Desactivado</option>
                <option value="retain-on-failure">Solo si falla (recomendado)</option>
                <option value="on">Siempre</option>
              </select>
            </div>

            {/* Screenshot */}
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Camera className="h-3.5 w-3.5" />
                Capturas de pantalla
              </label>
              <select
                value={screenshot}
                onChange={(e) => setScreenshot(e.target.value as ScreenshotMode)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs focus:ring-2 focus:ring-[#7c3aed]/30 focus:border-[#7c3aed]"
              >
                <option value="off">Desactivadas</option>
                <option value="only-on-failure">Solo si falla (recomendado)</option>
                <option value="on">En cada paso</option>
              </select>
            </div>

            {/* Trace */}
            <div className="space-y-2">
              <label className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <Activity className="h-3.5 w-3.5" />
                Trace (inspector)
              </label>
              <select
                value={trace}
                onChange={(e) => setTrace(e.target.value as TraceMode)}
                className="flex h-9 w-full rounded-md border border-input bg-background px-3 py-1.5 text-xs focus:ring-2 focus:ring-[#7c3aed]/30 focus:border-[#7c3aed]"
              >
                <option value="off">Desactivado</option>
                <option value="retain-on-failure">Solo si falla (recomendado)</option>
                <option value="on-first-retry">En reintento</option>
                <option value="on">Siempre</option>
              </select>
            </div>
          </div>

          {/* Row 3: SlowMo slider (only relevant when headed) */}
          {headed && (
            <div className="space-y-2">
              <label className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <Hourglass className="h-3.5 w-3.5" />
                  Velocidad (slow-motion)
                </span>
                <span className="font-mono text-[#7c3aed]">
                  {slowMo === 0 ? 'Normal' : `${slowMo}ms por acción`}
                </span>
              </label>
              <input
                type="range"
                min={0}
                max={1000}
                step={50}
                value={slowMo}
                onChange={(e) => setSlowMo(Number(e.target.value))}
                className="w-full accent-[#7c3aed]"
              />
              <p className="text-[11px] text-muted-foreground">
                Útil para seguir visualmente lo que hace el test. 250ms es cómodo para observar.
              </p>
            </div>
          )}

          {/* Summary chips — what will happen when the user runs this */}
          <div className="flex flex-wrap gap-2 rounded-md bg-[#f5f3ff] p-3">
            <Badge variant="info" className="gap-1">
              <Globe className="h-3 w-3" />
              {browser}
            </Badge>
            <Badge variant={headed ? 'success' : 'secondary'} className="gap-1">
              {headed ? <Eye className="h-3 w-3" /> : <EyeOff className="h-3 w-3" />}
              {headed ? 'Visible' : 'Headless'}
            </Badge>
            {video !== 'off' && (
              <Badge variant="warning" className="gap-1">
                <Video className="h-3 w-3" />
                Video: {video === 'on' ? 'siempre' : 'al fallar'}
              </Badge>
            )}
            {screenshot !== 'off' && (
              <Badge variant="warning" className="gap-1">
                <Camera className="h-3 w-3" />
                Screenshots: {screenshot === 'on' ? 'siempre' : 'al fallar'}
              </Badge>
            )}
            {trace !== 'off' && (
              <Badge variant="info" className="gap-1">
                <Activity className="h-3 w-3" />
                Trace: {trace === 'on' ? 'siempre' : trace === 'on-first-retry' ? 'en reintento' : 'al fallar'}
              </Badge>
            )}
            {slowMo > 0 && (
              <Badge variant="secondary" className="gap-1">
                <Hourglass className="h-3 w-3" />
                SlowMo {slowMo}ms
              </Badge>
            )}
          </div>

          {/* Base URL status banner — surfaces project misconfig before the user runs */}
          {project && !project.base_url && (
            <div className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
              <div>
                <p className="font-medium">URL base del proyecto no configurada</p>
                <p className="text-xs mt-0.5 text-amber-800">
                  Las pruebas con rutas relativas (ej. <code className="bg-amber-100 px-1 rounded">page.goto('/login')</code>) no podrán ejecutarse. Configura la URL base en Ajustes del proyecto.
                </p>
              </div>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-wrap gap-3 border-t pt-4">
            <Button
              onClick={handleExport}
              disabled={selectedCount === 0}
              size="lg"
              className="gap-2 bg-[#7c3aed] hover:bg-[#6d28d9] text-white text-base px-6 py-3"
            >
              <Download className="h-5 w-5" />
              Descargar archivo de pruebas
            </Button>
            <Button
              variant="outline"
              onClick={handleCopyCli}
              disabled={selectedCount === 0}
              className="border-[#7c3aed]/30 text-[#7c3aed] hover:bg-[#f5f3ff]"
            >
              {copiedCli ? (
                <Check className="mr-2 h-4 w-4" />
              ) : (
                <Copy className="mr-2 h-4 w-4" />
              )}
              {copiedCli ? 'Copiado' : 'Copiar CLI corto'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------ */}
      {/*  How to Run Your Tests                                        */}
      {/* ------------------------------------------------------------ */}
      <Card className="border-[#7c3aed]/20">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg text-[#1e1b4b]">
            <Terminal className="h-5 w-5 text-[#7c3aed]" />
            {t('runner.howToRun')}
          </CardTitle>
          <p className="text-sm text-muted-foreground">
            {t('runner.howToRunDesc')}
          </p>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Steps */}
          <div className="space-y-2">
            <p className="text-sm font-medium text-[#1e1b4b]">
              {t('runner.step1')}
            </p>
            <p className="text-sm font-medium text-[#1e1b4b]">
              {t('runner.step2')}
            </p>
          </div>

          {/* OS Tabs */}
          <div className="flex gap-1 rounded-lg bg-muted p-1 w-fit">
            <button
              type="button"
              onClick={() => setActiveTab('mac')}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                activeTab === 'mac'
                  ? 'bg-white text-[#7c3aed] shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('runner.mac')}
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('windows')}
              className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                activeTab === 'windows'
                  ? 'bg-white text-[#7c3aed] shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {t('runner.windows')}
            </button>
          </div>

          {/* Command block — reactive: reflects current run options */}
          <div className="rounded-md bg-[#1e1b4b] p-4">
            <div className="flex items-start justify-between gap-4">
              <code className="text-sm text-green-300 font-mono break-all whitespace-pre-wrap leading-relaxed">
                $ {activeCommand}
              </code>
              <button
                type="button"
                onClick={() => handleCopyHowTo(activeCommand)}
                className="shrink-0 rounded p-2 text-purple-300 hover:bg-white/10 transition-colors"
                title={t('runner.copyCli')}
              >
                {copiedHowTo ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </button>
            </div>
            <p className="mt-2 text-[11px] text-purple-300/70">
              💡 Este comando refleja tus opciones de arriba. Al cambiar una opción, el comando se actualiza automáticamente.
            </p>
          </div>

          {/* How to read the Playwright HTML report */}
          <details className="rounded-md border border-[#7c3aed]/20 bg-[#f5f3ff]/50 open:bg-[#f5f3ff]">
            <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-[#1e1b4b] hover:bg-[#ede9fe] rounded-md">
              📖 Cómo leer el reporte de Playwright
            </summary>
            <div className="space-y-3 border-t border-[#7c3aed]/10 p-4 text-sm">
              <p className="text-[#1e1b4b]">
                Al terminar los tests, se abre un reporte en{' '}
                <code className="rounded bg-white px-1.5 py-0.5 text-xs font-mono text-[#7c3aed]">http://localhost:9323</code>.
                Así navegar:
              </p>
              <div className="grid gap-2 md:grid-cols-2">
                <div className="rounded-md bg-white p-3">
                  <p className="mb-1 text-xs font-semibold text-[#1e1b4b]">🟢 Verde = pasó</p>
                  <p className="text-xs text-muted-foreground">
                    El test corrió y todas sus asserciones pasaron.
                  </p>
                </div>
                <div className="rounded-md bg-white p-3">
                  <p className="mb-1 text-xs font-semibold text-[#ef4444]">🔴 Rojo = falló</p>
                  <p className="text-xs text-muted-foreground">
                    Una assertion no pasó o un locator no encontró el elemento. Ver siguiente paso.
                  </p>
                </div>
              </div>
              <div className="space-y-2">
                <p className="text-xs font-semibold text-[#1e1b4b]">Para cada test fallido:</p>
                <ol className="list-decimal space-y-1.5 pl-5 text-xs text-muted-foreground">
                  <li>
                    <strong>Click en el nombre del test</strong> — se expande mostrando el error exacto y la línea de código.
                  </li>
                  <li>
                    <strong>▶ Icono play</strong> al lado del nombre — reproduce el <em>video</em> de la ejecución.
                  </li>
                  <li>
                    <strong>"View Trace"</strong> — abre un inspector interactivo con snapshots paso a paso, network, consola. <em>La herramienta más poderosa para debugging.</em>
                  </li>
                  <li>
                    <strong>Screenshots</strong> — aparecen inline dentro del test expandido, capturadas en el momento del fallo.
                  </li>
                </ol>
              </div>
              <div className="rounded-md border-l-4 border-[#f59e0b] bg-[#fffbeb] p-3">
                <p className="text-xs font-semibold text-[#92400e]">
                  ⚠️ ¿Test falló con "Timeout waiting for..." o "locator not found"?
                </p>
                <p className="mt-1 text-xs text-[#92400e]/90">
                  Significa que <strong>el selector del test no encontró el elemento en la página</strong>. Causas comunes:
                </p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-xs text-[#92400e]/90">
                  <li>El sitio cambió (ej: el botón "Login" ahora dice "Iniciar Sesión")</li>
                  <li>El selector está en otro idioma que la página</li>
                  <li>El elemento se renderiza después de algún evento que el test no espera</li>
                  <li>El sitio está caído o redirige a otra URL</li>
                </ul>
                <p className="mt-2 text-xs text-[#92400e]/90">
                  Edita el test en "Casos de Prueba" y vuelve a descargar el archivo.
                </p>
              </div>
            </div>
          </details>
        </CardContent>
      </Card>

      {/* ------------------------------------------------------------ */}
      {/*  Run History                                                   */}
      {/* ------------------------------------------------------------ */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">{t('runner.runHistory')}</CardTitle>
        </CardHeader>
        <CardContent>
          {runsLoading ? (
            <p className="text-muted-foreground">{t('testRunner.loading')}</p>
          ) : !runs?.length ? (
            <p className="text-sm text-muted-foreground">{t('runner.noRuns')}</p>
          ) : (
            <div className="space-y-3">
              {runs.map((run) => (
                <div
                  key={run.id}
                  className="flex items-center justify-between rounded-lg border p-4"
                >
                  <div className="flex items-center gap-4">
                    <RunStatusIcon status={run.status} />
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{run.browser}</span>
                        <Badge variant="secondary">{t(`status.${run.status}`, run.status)}</Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {new Date(run.created_at).toLocaleString()}
                        {run.duration_ms && ` - ${(run.duration_ms / 1000).toFixed(1)}s`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    <span className="text-green-600">
                      {t('testRunner.passed', { count: run.passed })}
                    </span>
                    <span className="text-red-600">
                      {t('testRunner.failed', { count: run.failed })}
                    </span>
                    <span className="text-muted-foreground">
                      {t('testRunner.skipped', { count: run.skipped })}
                    </span>
                    <span className="font-medium">
                      {t('testRunner.total', { count: run.total_tests })}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Small helper component (kept from original)                        */
/* ------------------------------------------------------------------ */

function RunStatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="h-5 w-5 text-green-500" />;
    case 'failed':
      return <XCircle className="h-5 w-5 text-red-500" />;
    case 'running':
      return <Loader2 className="h-5 w-5 animate-spin text-yellow-500" />;
    default:
      return <Clock className="h-5 w-5 text-muted-foreground" />;
  }
}
