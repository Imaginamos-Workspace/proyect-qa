// @ts-nocheck
// This file is bundled as raw text and shipped to the user's machine where
// it runs as `qa-heal.ts` alongside their Playwright tests. It imports
// '@playwright/test' which is installed in THAT environment, not in the
// frontend bundle. Skip type-checking here — Playwright's TS compiler will
// type-check it on the user's side at test time.
/**
 * qa-heal.ts — Custom Playwright fixture that captures the live DOM (both
 * structured and raw) and the page URL when a test fails. The heal-loop
 * orchestrator reads these files and forwards them to /ai/heal-iterate so
 * the AI regenerates the test using REAL selectors from the failure moment.
 *
 * Why structured + raw:
 *  - Structured (JSON): compact, easy for the AI to read, contains every
 *    real attribute (name, id, data-testid, placeholder, type, button text,
 *    aria-label) — the kind of values it would otherwise hallucinate.
 *  - Raw HTML (truncated): fallback when our extractor missed something
 *    unusual (web components, shadow DOM root, etc.).
 */
import { test as base, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const HEAL_DIR = path.join(process.cwd(), '.qa-heal');
const MAX_INPUTS = 100;
const MAX_BUTTONS = 100;
const MAX_LINKS = 60;
const MAX_FORMS = 20;
const RAW_HTML_LIMIT = 60_000;

export const test = base.extend({
  page: async ({ page }, use, testInfo) => {
    await use(page);

    const failed =
      testInfo.status === 'failed' || testInfo.status === 'timedOut';
    if (!failed) return;

    try {
      if (!fs.existsSync(HEAL_DIR)) fs.mkdirSync(HEAL_DIR, { recursive: true });

      // Extract a structured snapshot from the live DOM. This runs INSIDE
      // the page context, so we get real attribute values — no parsing,
      // no guessing.
      const snapshot = await page
        .evaluate(
          ({ MAX_INPUTS, MAX_BUTTONS, MAX_LINKS, MAX_FORMS }) => {
            const isVisible = (el) => {
              if (!el || !el.getBoundingClientRect) return true;
              const r = el.getBoundingClientRect();
              const style = window.getComputedStyle(el);
              if (style.display === 'none' || style.visibility === 'hidden') return false;
              return r.width > 0 && r.height > 0;
            };
            const txt = (el) => (el.innerText || el.textContent || '').trim().slice(0, 80);

            const inputs = [...document.querySelectorAll('input, textarea, select')]
              .slice(0, MAX_INPUTS)
              .map((el) => ({
                name: el.getAttribute('name') || undefined,
                id: el.id || undefined,
                type: el.getAttribute('type') || el.tagName.toLowerCase(),
                placeholder: el.getAttribute('placeholder') || undefined,
                aria_label: el.getAttribute('aria-label') || undefined,
                data_testid:
                  el.getAttribute('data-testid') ||
                  el.getAttribute('data-test') ||
                  el.getAttribute('data-test-id') ||
                  undefined,
                required: el.hasAttribute('required') || undefined,
                visible: isVisible(el),
              }));

            const buttons = [
              ...document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]'),
            ]
              .slice(0, MAX_BUTTONS)
              .map((el) => ({
                text: txt(el) || el.getAttribute('value') || undefined,
                id: el.id || undefined,
                name: el.getAttribute('name') || undefined,
                type: el.getAttribute('type') || undefined,
                aria_label: el.getAttribute('aria-label') || undefined,
                data_testid:
                  el.getAttribute('data-testid') ||
                  el.getAttribute('data-test') ||
                  el.getAttribute('data-test-id') ||
                  undefined,
                visible: isVisible(el),
              }));

            const links = [...document.querySelectorAll('a[href]')]
              .slice(0, MAX_LINKS)
              .map((el) => ({
                text: txt(el),
                href: el.getAttribute('href') || undefined,
                data_testid: el.getAttribute('data-testid') || undefined,
              }));

            const forms = [...document.querySelectorAll('form')]
              .slice(0, MAX_FORMS)
              .map((el) => ({
                id: el.id || undefined,
                action: el.getAttribute('action') || undefined,
                method: el.getAttribute('method') || undefined,
              }));

            // Visible alert / error / live-region messages — the AI needs
            // these for regex-based assertion locators.
            const messageNodes = [
              ...document.querySelectorAll(
                '[role="alert"], [role="status"], [aria-live], .error, .alert, .invalid-feedback, .help-block, .help-text, .form-error, .form-message',
              ),
            ];
            const visible_messages = messageNodes
              .map((el) => txt(el))
              .filter((s) => s.length > 0)
              .slice(0, 10);

            const headings = [...document.querySelectorAll('h1, h2, h3')]
              .slice(0, 5)
              .map((el) => txt(el))
              .filter((s) => s.length > 0);

            return {
              inputs,
              buttons,
              links,
              forms,
              visible_messages,
              headings,
              title: document.title || undefined,
            };
          },
          { MAX_INPUTS, MAX_BUTTONS, MAX_LINKS, MAX_FORMS },
        )
        .catch(() => null);

      const html = await page.content().catch(() => '');
      const url = page.url();

      const trimmedHtml =
        html.length > RAW_HTML_LIMIT ? html.slice(0, RAW_HTML_LIMIT) : html;

      fs.writeFileSync(path.join(HEAL_DIR, 'failure-dom.html'), trimmedHtml);
      fs.writeFileSync(path.join(HEAL_DIR, 'failure-url.txt'), url);
      if (snapshot) {
        fs.writeFileSync(
          path.join(HEAL_DIR, 'failure-snapshot.json'),
          JSON.stringify(snapshot),
        );
      }

      const errors = (testInfo.errors || [])
        .map((e) => `${e.message || ''}\n${e.stack || ''}`)
        .join('\n---\n');
      fs.writeFileSync(path.join(HEAL_DIR, 'failure-error.txt'), errors);

      fs.writeFileSync(path.join(HEAL_DIR, 'failure-marker'), Date.now().toString());
    } catch (e) {
      try {
        fs.writeFileSync(path.join(HEAL_DIR, 'capture-error.txt'), String(e));
      } catch {
        /* swallow */
      }
    }
  },
});

export { expect };
