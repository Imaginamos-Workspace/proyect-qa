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
}

export interface AICompleteTestResponse {
  test_case: AIGeneratedTestCase;
}
