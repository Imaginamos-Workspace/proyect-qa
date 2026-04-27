import { TestType, TestPriority, ViewportConfig } from './test-case.types';

export interface AIGenerateRequest {
  project_id: string;
  base_url: string;
  test_types: TestType[];
  page_analysis?: PageAnalysis;
  additional_context?: string;
}

export interface PageAnalysis {
  url: string;
  title: string;
  meta_description: string | null;
  headings: { level: number; text: string }[];
  interactive_elements: InteractiveElement[];
  navigation_links: { text: string; href: string }[];
  forms: FormAnalysis[];
  aria_landmarks: { role: string; label: string | null }[];
  api_endpoints: { method: string; url: string }[];
  page_routes: string[];
  accessibility_tree?: any;
  meta_tags?: { name: string; content: string }[];
  detected_frameworks?: string[];
  performance_data?: {
    domContentLoaded: number;
    load: number;
    firstPaint: number;
  };
  console_errors?: string[];
}

export interface InteractiveElement {
  tag: string;
  type?: string;
  role?: string;
  text?: string;
  label?: string;
  placeholder?: string;
  name?: string;
  id?: string;
  selector: string;
}

export interface FormAnalysis {
  action: string | null;
  method: string;
  fields: {
    name: string;
    type: string;
    label: string | null;
    required: boolean;
    placeholder: string | null;
  }[];
}

export interface AIGeneratedTestCase {
  title: string;
  description: string;
  test_type: TestType;
  priority: TestPriority;
  tags: string[];
  playwright_code: string;
  browser_targets: string[];
  viewport_config?: ViewportConfig;
}

export interface AIGenerateResponse {
  test_cases: AIGeneratedTestCase[];
  analysis_summary: string;
  suggestions: string[];
}

export interface AIRefineRequest {
  test_case_id: string;
  current_code: string;
  feedback: string;
  /**
   * Optional: if provided, the backend will try to re-scan this URL (or the
   * specific path extracted from the test's page.goto()) to give the AI a
   * fresh DOM snapshot. If the scan fails for any reason (network error,
   * auth wall, JS-only SPA, timeout, etc.), the refine gracefully falls back
   * to code+feedback-only mode.
   */
  project_base_url?: string;
  /**
   * Optional: explicit URL or path to scan, overriding the auto-detected
   * page.goto() in the test code. Accepts:
   *   - Absolute URL: 'https://example.com/checkout' (host must match base)
   *   - Path:         '/checkout', '/cart?step=2'
   * The backend resolves this against project_base_url. Use when a test
   * navigates between multiple pages and you want to scan a specific one.
   */
  scan_url_override?: string;
}

export interface AIRefineResponse {
  refined_code: string;
  changes_summary: string;
  /** Whether the live page scan ran and what happened. Useful for UI feedback. */
  scan_status?: 'scanned' | 'no_base_url' | 'no_goto' | 'scan_failed';
  /** The URL that was scanned (for display). */
  scan_url?: string;
  /** Element counts found in the scan — proves to the user it ran. */
  scan_elements?: {
    inputs: number;
    buttons: number;
    links: number;
    forms: number;
  };
}

/** Single test-case completion: user describes what to test, AI returns a full case. */
export interface AICompleteTestRequest {
  project_id: string;
  suite_id: string;
  title?: string;
  description: string;
  test_type: TestType;
  priority?: TestPriority;
  /** Project base URL — used both for the prompt context AND to scan the DOM. */
  base_url?: string;
  /**
   * Optional explicit URL or path to scan, overriding the default (which is
   * the base URL). Same semantics as AIRefineRequest.scan_url_override:
   *   - Absolute URL: 'https://example.com/checkout' (host must match base)
   *   - Path:         '/checkout'
   */
  scan_url_override?: string;
}

export interface AICompleteTestResponse {
  test_case: AIGeneratedTestCase;
  /** Whether a live scan ran and what happened. */
  scan_status?: 'scanned' | 'no_base_url' | 'scan_failed';
  scan_url?: string;
  scan_elements?: { inputs: number; buttons: number; links: number; forms: number };
}

/**
 * Structured snapshot of the page at the moment of failure. Far more useful
 * per byte than raw HTML — the AI can read real attribute values without
 * having to parse HTML or guess what's relevant.
 */
export interface HealDomSnapshot {
  inputs: Array<{
    name?: string;
    id?: string;
    type?: string;
    placeholder?: string;
    aria_label?: string;
    data_testid?: string;
    required?: boolean;
    visible?: boolean;
  }>;
  buttons: Array<{
    text?: string;
    id?: string;
    name?: string;
    type?: string;
    aria_label?: string;
    data_testid?: string;
    visible?: boolean;
  }>;
  links: Array<{ text?: string; href?: string; data_testid?: string }>;
  forms: Array<{ action?: string; method?: string; id?: string }>;
  /** Visible text content of [role="alert"], .error, [aria-live], etc. */
  visible_messages: string[];
  /** First 5 headings on the page (h1-h3). */
  headings: string[];
  /** Page title. */
  title?: string;
}

/**
 * Self-healing test loop — the user's machine ran the test, captured the DOM
 * at the failure point, and is asking the AI to regenerate using the REAL
 * DOM (not a static scan). This is more reliable than scan-based refine
 * because the DOM is captured by the SAME Playwright engine that runs the
 * test, so what the AI sees == what the test will see on retry.
 */
export interface AIHealIterateRequest {
  /** Test case being healed (used to update DB if attempt succeeds). */
  test_case_id: string;
  /** Scoped HMAC token issued by /ai/heal-token. Required. */
  heal_token: string;
  /** The code that just failed. */
  current_code: string;
  /** Iteration number — backend uses this to cap retries. 1-based. */
  iteration: number;
  /** Truncated error message + stack from Playwright. */
  error_message: string;
  /** Selector or call that failed (e.g., "input[name='email']"). */
  failing_selector?: string;
  /** Truncated HTML of page.content() at the failure moment. ~30KB max. */
  dom_snapshot: string;
  /** Structured DOM (preferred). Backend uses this when present. */
  structured_snapshot?: HealDomSnapshot;
  /** Optional: full page URL at the moment of failure. */
  failure_url?: string;
  /** Selectors that already failed earlier in this heal session. */
  prior_failed_selectors?: string[];
}

export interface AIHealIterateResponse {
  /** New test code, validated by the TS compiler. */
  healed_code: string;
  /** Human-readable summary of what changed. */
  changes_summary: string;
  /** True if this is the last allowed iteration (no more retries). */
  is_final_iteration: boolean;
}

/** Returned by /ai/heal-token. Token is scoped to one test_case_id. */
export interface AIHealTokenResponse {
  token: string;
  expires_at: number;
  test_case_id: string;
}
