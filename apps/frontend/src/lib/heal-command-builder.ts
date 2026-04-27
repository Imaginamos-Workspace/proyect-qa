/**
 * heal-command-builder — produces the copy-paste bash/PowerShell command
 * that runs the self-healing test loop on the user's machine.
 *
 * Strategy: same pattern as the existing TestRunnerPage commands. Embed
 * three artefacts as base64 in the command so the user pastes ONE line:
 *   1. playwright.config.ts (configures baseURL, headed mode, traces)
 *   2. qa-heal.ts            (custom fixture that captures DOM on failure)
 *   3. heal-loop.mjs         (orchestrator: run → on fail call API → retry)
 *
 * The user's spec file (generated-tests.spec.ts) must already be in
 * ~/Downloads, exactly like the existing run flow. The heal-loop.mjs
 * patches its imports to use ./qa-heal automatically.
 */

// Vite raw imports — these resolve to the file contents as strings at
// build time. No runtime fetch, no extra deps.
import healLoopSource from '../scripts/heal-loop.mjs?raw';
import qaHealFixtureSource from '../scripts/qa-heal-fixture.ts?raw';

/** UTF-8-safe base64 encoder (btoa() only handles Latin-1). */
function utf8ToBase64(str: string): string {
  return btoa(
    new TextEncoder()
      .encode(str)
      .reduce((acc, byte) => acc + String.fromCharCode(byte), ''),
  );
}

interface HealCommandConfig {
  /** UUID of the test case (sent to /ai/heal-iterate). */
  testCaseId: string;
  /** Scoped HMAC token issued by /ai/heal-token; valid 1 hour. */
  healToken: string;
  /** Backend URL (e.g., https://qa-backend-iota.vercel.app). */
  backendUrl: string;
  /** Project base URL for Playwright config. */
  projectBaseUrl: string;
  /** Browser to install + run with. */
  browser?: 'chromium' | 'firefox' | 'webkit';
  /** Run with --headed so the user can watch the heal happen. */
  headed?: boolean;
}

function buildPlaywrightConfig(cfg: HealCommandConfig): string {
  return `import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: '.',
  reporter: [['html', { open: 'never' }], ['list']],
  timeout: 60000,
  use: {
    baseURL: '${cfg.projectBaseUrl}',
    headless: ${cfg.headed === false},
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: 'retain-on-failure',
    actionTimeout: 15000,
    navigationTimeout: 30000,
  },
  projects: [{
    name: '${cfg.browser || 'chromium'}',
    use: { ...devices['Desktop ${cfg.browser === 'firefox' ? 'Firefox' : cfg.browser === 'webkit' ? 'Safari' : 'Chrome'}'] },
  }],
});
`;
}

export function buildHealMacCommand(cfg: HealCommandConfig): string {
  const browser = cfg.browser || 'chromium';
  const configB64 = utf8ToBase64(buildPlaywrightConfig(cfg));
  const fixtureB64 = utf8ToBase64(qaHealFixtureSource);
  const loopB64 = utf8ToBase64(healLoopSource);

  return [
    `command -v node >/dev/null 2>&1 || { echo "Instala Node.js primero: https://nodejs.org"; exit 1; }`,
    `cd ~/Downloads`,
    `mkdir -p qa-tests`,
    `mv -f generated-tests.spec.ts qa-tests/ 2>/dev/null || true`,
    `cd qa-tests`,
    `[ -f package.json ] || npm init -y >/dev/null 2>&1`,
    `[ -d node_modules/@playwright/test ] || npm i -D @playwright/test >/dev/null 2>&1`,
    `npx -y playwright install ${browser} >/dev/null 2>&1`,
    `echo ${configB64} | base64 -d > playwright.config.ts`,
    `echo ${fixtureB64} | base64 -d > qa-heal.ts`,
    `echo ${loopB64} | base64 -d > heal-loop.mjs`,
    `node heal-loop.mjs --test-id=${cfg.testCaseId} --token=${cfg.healToken} --backend=${cfg.backendUrl} --file=generated-tests.spec.ts`,
    `lsof -ti:9323 | xargs kill -9 2>/dev/null || true`,
    `npx playwright show-report`,
  ].join(' && ');
}

export function buildHealWindowsCommand(cfg: HealCommandConfig): string {
  const browser = cfg.browser || 'chromium';
  const configB64 = utf8ToBase64(buildPlaywrightConfig(cfg));
  const fixtureB64 = utf8ToBase64(qaHealFixtureSource);
  const loopB64 = utf8ToBase64(healLoopSource);

  return [
    `if (!(Get-Command node -ErrorAction SilentlyContinue)) { Write-Host 'Instala Node.js primero: https://nodejs.org'; exit 1 }`,
    `cd $env:USERPROFILE\\Downloads`,
    `New-Item -ItemType Directory -Force qa-tests | Out-Null`,
    `Move-Item -Force generated-tests.spec.ts qa-tests\\ -ErrorAction SilentlyContinue`,
    `cd qa-tests`,
    `if (!(Test-Path package.json)) { npm init -y 2>$null | Out-Null }`,
    `if (!(Test-Path node_modules\\@playwright\\test)) { npm i -D @playwright/test 2>$null | Out-Null }`,
    `npx -y playwright install ${browser} 2>$null | Out-Null`,
    `[IO.File]::WriteAllBytes('playwright.config.ts', [Convert]::FromBase64String('${configB64}'))`,
    `[IO.File]::WriteAllBytes('qa-heal.ts', [Convert]::FromBase64String('${fixtureB64}'))`,
    `[IO.File]::WriteAllBytes('heal-loop.mjs', [Convert]::FromBase64String('${loopB64}'))`,
    `node heal-loop.mjs --test-id=${cfg.testCaseId} --token=${cfg.healToken} --backend=${cfg.backendUrl} --file=generated-tests.spec.ts`,
    `Get-NetTCPConnection -LocalPort 9323 -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
    `npx playwright show-report`,
  ].join('; ');
}
