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
  /** Optional project base URL — enables fresh DOM scan for smarter refine. */
  project_base_url?: string;
  /** Explicit URL or path to scan, overriding auto-detected page.goto(). */
  scan_url_override?: string;
}

export interface AIRefineResponse {
  refined_code: string;
  changes_summary: string;
  scan_status?: 'scanned' | 'no_base_url' | 'no_goto' | 'scan_failed';
  scan_url?: string;
  scan_elements?: {
    inputs: number;
    buttons: number;
    links: number;
    forms: number;
  };
}

export interface AICompleteTestRequest {
  project_id: string;
  suite_id: string;
  title?: string;
  description: string;
  test_type: TestType;
  priority?: TestPriority;
  base_url?: string;
  scan_url_override?: string;
}

export interface AICompleteTestResponse {
  test_case: AIGeneratedTestCase;
  scan_status?: 'scanned' | 'no_base_url' | 'scan_failed';
  scan_url?: string;
  scan_elements?: { inputs: number; buttons: number; links: number; forms: number };
}

/**
 * Structured snapshot of the page at the moment of failure. More useful per
 * byte than raw HTML because the AI can directly read attribute values
 * without parsing HTML.
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
 * DOM (not a static scan).
 */
export interface AIHealIterateRequest {
  test_case_id: string;
  /** Token issued by /ai/heal-token, scoped to this test_case_id. Required. */
  heal_token: string;
  current_code: string;
  iteration: number;
  error_message: string;
  failing_selector?: string;
  /**
   * Raw HTML of the page at the failure moment (truncated).
   * Used as fallback if structured snapshot is missing.
   */
  dom_snapshot: string;
  /** Structured DOM extracted by the heal fixture. Preferred over dom_snapshot. */
  structured_snapshot?: HealDomSnapshot;
  failure_url?: string;
  /** Selectors that already failed in previous iterations — AI must avoid them. */
  prior_failed_selectors?: string[];
}

export interface AIHealIterateResponse {
  healed_code: string;
  changes_summary: string;
  is_final_iteration: boolean;
}

/** Issued to authenticated users; consumed by the public heal endpoint. */
export interface AIHealTokenResponse {
  token: string;
  expires_at: number;
  /** Same value as request.test_case_id, echoed for convenience. */
  test_case_id: string;
}
