#!/usr/bin/env node
/**
 * heal-loop.mjs — Self-healing test orchestrator.
 *
 * Flow:
 *   1. Patch the user's spec to import from ./qa-heal (DOM-capture fixture)
 *   2. Run Playwright
 *   3. If passed → done.
 *   4. If failed → read .qa-heal/failure-snapshot.json + failure-error.txt,
 *      POST to /api/ai/heal-iterate with the heal token, write the healed
 *      code, GOTO 2.
 *   5. After MAX_ITERATIONS (or two consecutive identical failures), give up.
 *
 * Designed to run on the user's machine (Mac/Linux/Windows-WSL) with only
 * Node 18+ and Playwright already installed. No npm dependencies — uses
 * built-in fetch, fs, child_process.
 *
 * Usage:
 *   node heal-loop.mjs --test-id=<uuid> --token=<heal-token> --backend=<url> [--file=<spec>]
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const MAX_ITERATIONS = 3;
const HEAL_DIR = '.qa-heal';

const args = parseArgs(process.argv.slice(2));
const TEST_FILE = args.file || 'generated-tests.spec.ts';
const TEST_ID = args['test-id'];
const HEAL_TOKEN = args.token;
const BACKEND = (args.backend || 'https://qa-backend-iota.vercel.app').replace(/\/$/, '');

if (!TEST_ID) {
  console.error('Usage: node heal-loop.mjs --test-id=<uuid> --token=<heal-token> [--backend=<url>] [--file=<spec>]');
  process.exit(2);
}
if (!HEAL_TOKEN) {
  console.error('❌ Missing --token. Genera el comando desde la app — el token se vence en 1 hora.');
  process.exit(2);
}
if (!existsSync(TEST_FILE)) {
  console.error(`Test file not found: ${TEST_FILE}`);
  process.exit(2);
}

console.log('🔬 Self-healing test loop activado');
console.log(`   Test:     ${TEST_FILE}`);
console.log(`   Test ID:  ${TEST_ID}`);
console.log(`   Backend:  ${BACKEND}`);
console.log(`   Máximo:   ${MAX_ITERATIONS} iteraciones de auto-arreglo`);
console.log('');

patchSpecToUseHealFixture(TEST_FILE);

const priorFailingSelectors = [];
let iteration = 0;

while (iteration <= MAX_ITERATIONS) {
  resetHealDir();

  const label = iteration === 0
    ? '▶️  Ejecutando test...'
    : `🔄 Reintentando con código auto-arreglado (intento ${iteration}/${MAX_ITERATIONS})...`;
  console.log(label);

  const result = runPlaywright();

  if (result.passed) {
    console.log('');
    console.log(iteration === 0
      ? '✅ Test pasó al primer intento.'
      : `✅ Test pasó tras ${iteration} iteración(es) de auto-arreglo.`);
    process.exit(0);
  }

  if (iteration === MAX_ITERATIONS) {
    console.log('');
    console.log(`❌ Test sigue fallando tras ${MAX_ITERATIONS} iteraciones.`);
    console.log('   Ya regeneré el código las veces permitidas. Revísalo manualmente.');
    console.log(`   Archivos de la última falla: ${HEAL_DIR}/`);
    process.exit(1);
  }

  const captured = readCapturedFailure();
  if (!captured.snapshot && !captured.dom) {
    console.log('');
    console.log('⚠️  Test falló pero no se pudo capturar nada del DOM.');
    console.log('   Probablemente el error ocurrió antes de llegar al fixture (ej. error de import).');
    console.log('   Sin DOM real, el auto-arreglo es menos efectivo. Llamando igual con el error...');
  } else {
    if (captured.snapshot) {
      const s = captured.snapshot;
      console.log(`   📸 DOM estructurado: ${(s.inputs || []).length} input(s), ${(s.buttons || []).length} botón(es), ${(s.forms || []).length} form(s) en ${captured.url || '(URL desconocida)'}`);
    } else {
      console.log(`   📸 DOM (raw): ${captured.dom.length} bytes desde ${captured.url || '(URL desconocida)'}`);
    }
  }

  const failingSelector = extractFailingSelector(result.errorOutput + '\n' + captured.error);
  if (failingSelector) {
    console.log(`   🎯 Selector que falló: ${failingSelector}`);
    // Early abort: same selector failing twice in a row → AI is stuck.
    if (priorFailingSelectors.length > 0 && priorFailingSelectors[priorFailingSelectors.length - 1] === failingSelector) {
      console.log('');
      console.log(`❌ El mismo selector falló dos iteraciones seguidas. Abortando para no quemar más cuota.`);
      console.log(`   Revisa manualmente — la IA no puede progresar con el contexto actual.`);
      process.exit(1);
    }
    priorFailingSelectors.push(failingSelector);
  }

  console.log('   📡 Pidiendo a la IA que regenere usando el DOM real...');

  const currentCode = readFileSync(TEST_FILE, 'utf8');
  let healed;
  try {
    healed = await callHealEndpoint({
      test_case_id: TEST_ID,
      heal_token: HEAL_TOKEN,
      current_code: stripHealImport(currentCode),
      iteration: iteration + 1,
      error_message: captured.error || result.errorOutput,
      failing_selector: failingSelector,
      dom_snapshot: captured.dom || '',
      structured_snapshot: captured.snapshot || undefined,
      failure_url: captured.url || undefined,
      prior_failed_selectors: [...priorFailingSelectors],
    });
  } catch (err) {
    console.log('');
    console.error('❌ Error llamando al endpoint de heal:', err.message);
    if (String(err.message).includes('401') || String(err.message).includes('expired') || String(err.message).includes('invalid')) {
      console.error('   El token expiró o es inválido. Vuelve a generar el comando desde la app.');
    } else {
      console.error('   Verifica que el backend está accesible:', BACKEND);
    }
    process.exit(1);
  }

  // Defense in depth: ensure the healed code has a Playwright import.
  // The backend is supposed to add it, but if Gemini ate the import line
  // and the backend's auto-inject didn't catch it for any reason, we add
  // it here so the next Playwright run doesn't crash with
  // `ReferenceError: test is not defined`.
  const healedWithImport = ensurePlaywrightImport(healed.healed_code);
  writeFileSync(TEST_FILE, healedWithImport);
  patchSpecToUseHealFixture(TEST_FILE);
  if (healed.changes_summary) {
    console.log('   ✏️  ' + healed.changes_summary);
  }
  console.log('');

  iteration += 1;
}

// --- helpers ---

function parseArgs(argv) {
  const out = {};
  for (const a of argv) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function patchSpecToUseHealFixture(file) {
  const src = readFileSync(file, 'utf8');
  if (src.includes("from './qa-heal'")) return;
  const patched = src.replace(
    /from\s+(['"`])@playwright\/test\1/g,
    `from './qa-heal'`,
  );
  if (patched !== src) writeFileSync(file, patched);
}

function stripHealImport(code) {
  return code.replace(/from\s+(['"`])\.\/qa-heal\1/g, `from '@playwright/test'`);
}

/**
 * Make sure the spec file starts with the @playwright/test import. If the
 * AI produced code without it (Gemini sometimes "forgets" the import line
 * even when the prompt insists), prepending it here saves the next run.
 */
function ensurePlaywrightImport(code) {
  if (/from\s+['"](@playwright\/test|\.\/qa-heal)['"]/.test(code)) return code;
  return `import { test, expect } from '@playwright/test';\n${code}`;
}

function resetHealDir() {
  try { rmSync(HEAL_DIR, { recursive: true, force: true }); } catch {}
  try { mkdirSync(HEAL_DIR, { recursive: true }); } catch {}
}

function readCapturedFailure() {
  const out = { dom: '', url: '', error: '', snapshot: null };
  const domPath = join(HEAL_DIR, 'failure-dom.html');
  const urlPath = join(HEAL_DIR, 'failure-url.txt');
  const errPath = join(HEAL_DIR, 'failure-error.txt');
  const snapPath = join(HEAL_DIR, 'failure-snapshot.json');
  if (existsSync(domPath)) out.dom = readFileSync(domPath, 'utf8');
  if (existsSync(urlPath)) out.url = readFileSync(urlPath, 'utf8').trim();
  if (existsSync(errPath)) out.error = readFileSync(errPath, 'utf8');
  if (existsSync(snapPath)) {
    try {
      out.snapshot = JSON.parse(readFileSync(snapPath, 'utf8'));
    } catch {
      out.snapshot = null;
    }
  }
  return out;
}

function runPlaywright() {
  const r = spawnSync(
    'npx',
    ['playwright', 'test', TEST_FILE, '--project=chromium', '--reporter=list'],
    { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] },
  );
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);

  const passed = r.status === 0;
  return {
    passed,
    errorOutput: ((r.stdout || '') + '\n' + (r.stderr || '')).slice(0, 8000),
  };
}

function extractFailingSelector(text) {
  if (!text) return undefined;
  const patterns = [
    /locator\((['"`])([^'"`]+)\1[^)]*\)/,
    /getByRole\([^)]*\)/,
    /getByText\([^)]*\)/,
    /getByPlaceholder\([^)]*\)/,
    /getByLabel\([^)]*\)/,
    /getByTestId\([^)]*\)/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m[2] || m[0];
  }
  return undefined;
}

async function callHealEndpoint(body) {
  const url = `${BACKEND}/api/ai/heal-iterate`;
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error(`network error: ${e.message}`);
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`HTTP ${response.status}: ${text.slice(0, 300)}`);
  }
  return response.json();
}
