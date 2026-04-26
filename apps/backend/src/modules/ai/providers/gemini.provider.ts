import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { AIProvider } from './ai-provider.interface';
import {
  AIGenerateRequest,
  AIGeneratedTestCase,
  AICompleteTestRequest,
} from '../../../shared-types';
import {
  buildTestGenerationPrompt,
  buildRefinePrompt,
  buildAnalyzePrompt,
} from '../prompts/test-generation.prompt';
import { validateAndFixTestCode } from '../utils/test-validator';

@Injectable()
export class GeminiProvider implements AIProvider {
  private readonly model;

  constructor(private readonly configService: ConfigService) {
    const apiKey = this.configService.getOrThrow('GEMINI_API_KEY');
    const genAI = new GoogleGenerativeAI(apiKey);
    // gemini-2.5-flash — full flash model, much better code quality than
    // flash-lite and still on the free tier. Upgrade path: gemini-2.5-pro
    // (lower quota) or Claude Haiku via Anthropic API (paid, best quality).
    this.model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  }

  async generateTestCases(
    request: AIGenerateRequest,
  ): Promise<AIGeneratedTestCase[]> {
    const prompt = buildTestGenerationPrompt(request);

    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 8192,
        responseMimeType: 'application/json',
      },
    });

    const responseText = result.response.text();

    try {
      const parsed = JSON.parse(responseText);
      const testCases: AIGeneratedTestCase[] = Array.isArray(parsed)
        ? parsed
        : parsed.test_cases || [];

      // Validate + auto-fix every generated snippet. Drop any that still
      // don't compile after sanitization so the user never downloads a
      // spec that will throw SyntaxError.
      const validated: AIGeneratedTestCase[] = [];
      for (const tc of testCases) {
        const result = validateAndFixTestCode(tc.playwright_code || '');
        if (result.valid && result.fixed) {
          validated.push({ ...tc, playwright_code: result.fixed });
        } else {
          console.warn(
            `[AI] Dropping invalid test "${tc.title}": ${result.errors.join('; ')}`,
          );
        }
      }
      return validated;
    } catch {
      throw new Error(
        `Failed to parse AI response as JSON: ${responseText.substring(0, 200)}`,
      );
    }
  }

  async refineTestCase(
    currentCode: string,
    feedback: string,
    liveDomSnapshot?: string,
  ): Promise<string> {
    const prompt = buildRefinePrompt(currentCode, feedback, liveDomSnapshot);

    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 4096 },
    });

    const raw = result.response.text();
    // Validate with the TS compiler — a refined test with syntax errors
    // is worse than no refinement. If invalid, keep the original code.
    const validation = validateAndFixTestCode(raw);
    if (!validation.valid) {
      throw new Error(
        `Refined test has syntax errors: ${validation.errors.join('; ')}`,
      );
    }
    return validation.fixed!;
  }

  async completeSingleTest(
    request: AICompleteTestRequest,
  ): Promise<AIGeneratedTestCase> {
    const prompt = `You are an expert QA automation engineer. Generate ONE complete Playwright TypeScript test case.

USER REQUEST:
- Description: ${request.description}
- Test type: ${request.test_type}
- Priority: ${request.priority || 'medium'}
${request.title ? `- Suggested title: ${request.title}` : ''}
${request.base_url ? `- Base URL: ${request.base_url}` : ''}

SYNTAX RULES (MUST FOLLOW — parsed by TypeScript compiler; invalid tests are DROPPED):
- Regex literals: ONLY valid JavaScript regex. NEVER put characters after the closing /. WRONG: /.*foo/.*/  CORRECT: /.*foo.*/
- Escape forward slashes inside regex patterns. WRONG: /path/to/ CORRECT: /path\\/to/
- Balance every quote, backtick, paren, brace, bracket. Never leave \${ unclosed.
- No markdown fences, no triple-backtick blocks in playwright_code.
- No export statements. No imports other than @playwright/test.
- The playwright_code MUST contain at least one test(...) call.
- Prefer plain strings or getByRole over regex whenever possible.
- NAVIGATION: Always use RELATIVE paths in page.goto() calls (e.g., page.goto('/'), page.goto('/login')). NEVER hardcode absolute URLs like 'http://localhost:3000'. The baseURL is set in playwright.config.ts and prepended automatically.

OUTPUT FORMAT:
Return a single JSON object (NOT an array) with this exact shape:
{
  "title": "concise test title",
  "description": "what this test verifies",
  "test_type": "${request.test_type}",
  "priority": "${request.priority || 'medium'}",
  "tags": ["tag1", "tag2"],
  "playwright_code": "import { test, expect } from '@playwright/test';\\n\\ntest('...', async ({ page }) => {\\n  // ...\\n});",
  "browser_targets": ["chromium"]
}`;

    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4096,
        responseMimeType: 'application/json',
      },
    });

    const responseText = result.response.text();
    let parsed: AIGeneratedTestCase;
    try {
      parsed = JSON.parse(responseText);
    } catch {
      throw new Error(
        `AI returned invalid JSON: ${responseText.substring(0, 200)}`,
      );
    }

    const validation = validateAndFixTestCode(parsed.playwright_code || '');
    if (!validation.valid) {
      throw new Error(
        `Generated test has syntax errors: ${validation.errors.join('; ')}`,
      );
    }

    return { ...parsed, playwright_code: validation.fixed! };
  }

  async analyzeUrl(url: string, pageData: string): Promise<string> {
    const prompt = buildAnalyzePrompt(url, pageData);

    const result = await this.model.generateContent({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.1, maxOutputTokens: 4096 },
    });

    return result.response.text();
  }
}
