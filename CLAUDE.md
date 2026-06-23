# Project: proyect-qa

Monorepo. Three apps: `apps/backend` (NestJS), `apps/frontend` (Vite+React), `apps/agent` (Node CLI). Shared types in `packages/shared-types` via workspace.

## Golden rules for AI-generated Playwright tests

The platform generates Playwright tests via Gemini. Every test that reaches the user **must** compile and run. These rules are enforced in three layers — do not weaken any of them:

### Layer 1 — Prompt (LLM is told what's valid)
Files: `apps/backend/src/modules/ai/prompts/test-generation.prompt.ts`, `apps/agent/src/ai/gemini-client.ts` (buildGeneratePrompt).

Every generation prompt must include a **SYNTAX RULES** block that covers at minimum:
- Regex literals: only valid JavaScript. Never put characters after the closing `/`. Wrong `/.*foo/.*/` correct `/.*foo.*/`.
- Escape forward slashes inside regex patterns.
- Balance every quote, backtick, paren, brace, bracket. Never leave `${` unclosed.
- No markdown fences / triple-backtick blocks.
- No `export` statements; imports other than `@playwright/test` are dropped.
- Each `playwright_code` must contain at least one `test(...)` call.
- Prefer plain strings or `getByRole` over regex whenever possible.

### Layer 2 — Validator (code that doesn't compile gets dropped)
Files: `apps/backend/src/modules/ai/utils/test-validator.ts`, `apps/agent/src/ai/utils/test-validator.ts`.

`validateAndFixTestCode(raw)` returns `{ valid, errors, fixed }`. It:
1. Sanitizes markdown fences, stray imports/exports, known broken regex patterns.
2. Parses the snippet with the real TypeScript compiler (`ts.createSourceFile`) and checks `parseDiagnostics`.
3. Constructs every regex literal via `new RegExp()` to catch runtime-invalid patterns.
4. Confirms a `test(...)` call exists and braces are balanced.

Both Gemini providers call this validator and **drop** any test that doesn't pass. Never bypass this.

### Layer 3 — Frontend spec bundler (defence in depth)
File: `apps/frontend/src/pages/TestRunner/TestRunnerPage.tsx` — `sanitizeTestCode` + `looksLikeValidTest`.

Same-shape sanitizer re-runs on the client as a last line of defense, including runtime regex validation with `new RegExp()`. Strings, template literals, regex literals and comments are skipped when balancing braces/parens/brackets.

## Run-command rules (generated bash/powershell that the user pastes)

`buildMacCommand` / `buildWindowsCommand` in TestRunnerPage. Every modification must:
- Kill any process on port 9323 **before** `npx playwright show-report` (Mac: `lsof -ti:9323 | xargs kill -9`; Win: `Get-NetTCPConnection -LocalPort 9323 | Stop-Process`).
- Never assume previous invocations exited cleanly.
- Keep the command agnostic to the user's project — no hard-coded URLs, paths, or project names.

## What NOT to commit
- `apps/frontend/.env.production` — contains `GEMINI_API_KEY` and Supabase keys. Vercel injects these at build time.
- `tsconfig.tsbuildinfo` files — incremental build artifacts. Add to gitignore if not already.

## Deployment
- Frontend: Vercel (project `qa-frontend`, org `viviana-qas-projects`).
- Backend: Vercel (project `qa-backend`, URL `https://qa-backend-theta.vercel.app/api`).
- Database: Supabase (`tsnqqmsrydsfuaezkfkr`).

## Commit convention
Conventional commits with scope per app: `fix(backend):`, `feat(frontend):`, `fix(agent):`. When a change spans multiple apps, split into one commit per app.
