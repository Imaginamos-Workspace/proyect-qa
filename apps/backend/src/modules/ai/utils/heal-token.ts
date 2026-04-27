import * as crypto from 'crypto';

/**
 * Heal token = scoped, short-lived HMAC over a test_case_id. Issued by an
 * authenticated user (Supabase session) when they want to run the heal loop
 * on their machine; consumed by the public /ai/heal-iterate endpoint to
 * prove the request comes from someone who had session access.
 *
 * Why this exists:
 *  - The heal loop runs from a bash script on the user's laptop, which has
 *    no Supabase session token to send.
 *  - We don't want a fully open endpoint (anyone could burn Gemini quota).
 *  - A scoped token tied to one test_case_id, valid 1 hour, is the right
 *    tradeoff: minimal credential exposure, can't be reused for arbitrary
 *    test cases, expires fast.
 *
 * Format: "<test_case_id>.<exp_unix>.<hmac_hex>"
 *  - test_case_id: which case this token authorizes healing for
 *  - exp_unix: seconds since epoch when the token expires
 *  - hmac_hex: HMAC-SHA256 of "<test_case_id>.<exp_unix>" using the heal
 *    secret derived from the Supabase service role key
 *
 * Verification is constant-time and bound to the requested test_case_id —
 * a token issued for case A cannot be used to heal case B.
 */

const TOKEN_VERSION = 'v1';
const DEFAULT_TTL_SECONDS = 60 * 60; // 1 hour

/**
 * Derive a dedicated heal secret from the base Supabase secret. Using a
 * derived value means a leak of heal tokens cannot help an attacker recover
 * the underlying Supabase key.
 */
export function deriveHealSecret(baseSecret: string): string {
  if (!baseSecret) throw new Error('Cannot derive heal secret from empty base');
  return crypto
    .createHmac('sha256', baseSecret)
    .update(`qa-heal-token-derivation-${TOKEN_VERSION}`)
    .digest('hex');
}

export function signHealToken(
  secret: string,
  testCaseId: string,
  ttlSeconds: number = DEFAULT_TTL_SECONDS,
): { token: string; expires_at: number } {
  if (!testCaseId) throw new Error('test_case_id required');
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${testCaseId}.${exp}`;
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');
  return { token: `${payload}.${hmac}`, expires_at: exp };
}

/**
 * Verify a heal token. Returns true only if:
 *  - format is exactly 3 parts
 *  - test_case_id in the token matches the expected one
 *  - exp is in the future
 *  - hmac is a valid HMAC of the payload using `secret`
 *
 * Constant-time comparison on the HMAC prevents timing leaks.
 */
export function verifyHealToken(
  secret: string,
  token: string,
  expectedTestCaseId: string,
): boolean {
  if (!token || typeof token !== 'string') return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [testCaseId, expStr, providedHmacHex] = parts;
  if (testCaseId !== expectedTestCaseId) return false;
  const exp = parseInt(expStr, 10);
  if (!Number.isFinite(exp)) return false;
  if (exp < Math.floor(Date.now() / 1000)) return false;

  const payload = `${testCaseId}.${expStr}`;
  const expectedHmac = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(providedHmacHex, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expectedHmac.length) return false;
  return crypto.timingSafeEqual(provided, expectedHmac);
}
