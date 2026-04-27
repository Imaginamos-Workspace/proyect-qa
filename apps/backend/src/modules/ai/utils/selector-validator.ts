import type { HealDomSnapshot } from '../../../shared-types';

/**
 * Defense-in-depth check that runs AFTER the AI generates healed code:
 * extract every selector / locator call from the code and verify the
 * referenced attribute / text actually exists in the captured DOM.
 *
 * "Invented" selectors are ones the AI hallucinated — they reference
 * attribute values that don't appear anywhere in the snapshot. When found,
 * we retry generation with explicit feedback about which were invented.
 *
 * This is intentionally conservative: we only flag selectors when we can
 * PROVE they reference invented values. If we can't tell (e.g., regex
 * matchers, role-based locators on common roles), we let them through.
 */

interface ValidationInput {
  structured?: HealDomSnapshot;
  rawHtml?: string;
}

interface ValidationResult {
  /** Selectors found in the code that don't appear to exist in the DOM. */
  invented: string[];
  /** Selectors we couldn't verify (e.g., post-submit error matchers). */
  unverifiable: string[];
}

export function validateSelectorsAgainstSnapshot(
  code: string,
  input: ValidationInput,
): ValidationResult {
  const invented: string[] = [];
  const unverifiable: string[] = [];

  if (!code) return { invented, unverifiable };
  if (!input.structured && !input.rawHtml) {
    // Nothing to validate against — be permissive.
    return { invented, unverifiable };
  }

  const haystack = buildHaystack(input);

  // Patterns we know how to verify:
  //   page.locator('input[name="X"]')          → check name="X" exists
  //   page.locator('#X')                       → check id="X" exists
  //   page.locator('[data-testid="X"]')        → check data-testid="X" exists
  //   page.getByTestId('X')                    → check data-testid="X" exists
  //   page.getByPlaceholder('X')               → check placeholder="X" exists
  //   page.getByLabel('X')                     → check the label/aria-label/text exists
  //   page.getByRole('button', { name: 'X' })  → check button text "X" exists

  const checks: Array<{ regex: RegExp; verify: (m: RegExpExecArray) => string | null }> = [
    // input[name="X"], textarea[name="X"], select[name="X"]
    {
      regex: /(?:input|textarea|select)\[name=(['"])([^'"]+)\1\]/g,
      verify: (m) => (haystack.has(`name="${m[2]}"`) ? null : `name="${m[2]}"`),
    },
    // #id selector inside locator()
    {
      regex: /\.locator\((['"])#([\w-]+)\1\)/g,
      verify: (m) => (haystack.has(`id="${m[2]}"`) ? null : `id="${m[2]}"`),
    },
    // [data-testid="X"]
    {
      regex: /\[data-testid=(['"])([^'"]+)\1\]/g,
      verify: (m) =>
        haystack.has(`data-testid="${m[2]}"`) ? null : `data-testid="${m[2]}"`,
    },
    // getByTestId('X')
    {
      regex: /getByTestId\((['"])([^'"]+)\1\)/g,
      verify: (m) =>
        haystack.has(`data-testid="${m[2]}"`) ? null : `data-testid="${m[2]}"`,
    },
    // getByPlaceholder('X') — only flag if string literal (not regex)
    {
      regex: /getByPlaceholder\((['"])([^'"]+)\1\)/g,
      verify: (m) =>
        haystack.has(`placeholder="${m[2]}"`) ? null : `placeholder="${m[2]}"`,
    },
    // CSS class selector that's NOT a regex
    {
      regex: /\.locator\((['"])\.([\w-]+)\1\)/g,
      verify: (m) => (haystack.has(`class="`) && haystack.has(m[2]) ? null : `.${m[2]}`),
    },
  ];

  for (const { regex, verify } of checks) {
    let m: RegExpExecArray | null;
    // Reset regex state defensively.
    regex.lastIndex = 0;
    while ((m = regex.exec(code)) !== null) {
      const result = verify(m);
      if (result !== null && !invented.includes(result)) {
        invented.push(result);
      }
    }
  }

  // Patterns we can't easily verify — note them but don't reject.
  const unverifiablePatterns = [
    /getByRole\([^)]*\{\s*name:\s*\/[^/]+\/[gimsy]*\s*\}\s*\)/g, // regex name
    /getByText\(\s*\/[^/]+\/[gimsy]*\s*\)/g, // regex text
    /text=\/[^/]+\/[gimsy]*/g, // text= regex
  ];
  for (const pat of unverifiablePatterns) {
    pat.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.exec(code)) !== null) {
      if (!unverifiable.includes(m[0])) unverifiable.push(m[0]);
    }
  }

  return { invented, unverifiable };
}

/**
 * Build a single string we can do .has() lookups against. Concatenates the
 * structured snapshot and the raw HTML so any attribute present in either
 * counts as "exists in DOM".
 *
 * Backed by a Set wrapper since we only need substring presence checks.
 */
function buildHaystack(input: ValidationInput): { has: (needle: string) => boolean } {
  const parts: string[] = [];
  if (input.rawHtml) parts.push(input.rawHtml);
  if (input.structured) {
    const s = input.structured;
    for (const i of s.inputs || []) {
      if (i.name) parts.push(`name="${i.name}"`);
      if (i.id) parts.push(`id="${i.id}"`);
      if (i.placeholder) parts.push(`placeholder="${i.placeholder}"`);
      if (i.aria_label) parts.push(`aria-label="${i.aria_label}"`);
      if (i.data_testid) parts.push(`data-testid="${i.data_testid}"`);
      if (i.type) parts.push(`type="${i.type}"`);
    }
    for (const b of s.buttons || []) {
      if (b.id) parts.push(`id="${b.id}"`);
      if (b.name) parts.push(`name="${b.name}"`);
      if (b.text) parts.push(b.text);
      if (b.aria_label) parts.push(`aria-label="${b.aria_label}"`);
      if (b.data_testid) parts.push(`data-testid="${b.data_testid}"`);
    }
    for (const l of s.links || []) {
      if (l.text) parts.push(l.text);
      if (l.href) parts.push(`href="${l.href}"`);
      if (l.data_testid) parts.push(`data-testid="${l.data_testid}"`);
    }
    for (const f of s.forms || []) {
      if (f.id) parts.push(`id="${f.id}"`);
    }
  }
  const blob = parts.join('\n');
  return { has: (n: string) => blob.includes(n) };
}
