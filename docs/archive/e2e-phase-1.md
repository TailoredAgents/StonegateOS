# E2E Testing Program – Phase 1 Architecture & Tooling Decisions

> Note: This phase doc is a planning artifact. For current setup, see tests/e2e, playwright.config.ts, and devops/docker-compose.yml.


This document captures the architecture and tooling blueprint for StonegateOS end-to-end testing. It converts the Phase 0 discovery outcomes into specific runner choices, environment orchestration steps, data-access patterns, and remote execution/diagnostics plans.

## 1. Test Runner & Repo Layout

- **Playwright + TypeScript**: Adopt Playwright as the unified runner (per guiding principles) with a Typescript config under `tests/e2e/playwright.config.ts`. Enable `@playwright/test` fixtures plus `@testing-library/playwright` (or `playwright-testing-library`) for semantic selectors that mirror user intent.
- **Project structure**:
  - `tests/e2e/` – feature suites grouped by journey (`lead-intake.spec.ts`, `quotes.spec.ts`, etc.).
  - `tests/e2e/support/` – auth helpers, API clients, selectors, data factories, and polling utilities.
  - `tests/e2e/global-setup.ts` – seeds the database, waits for health checks, primes auth sessions.
- **Playwright projects**: Start with `chromium-desktop` and `webkit-mobile` projects. Each project inherits common settings but overrides viewport, device scale, and storage state.
- **Global setup flow** (enforced via `globalSetup` export):
  1. Load `.env.e2e` (dotenv-safe) and ensure `.env.e2e.local` overrides are applied.
  2. Run `pnpm tsx scripts/seed-e2e.ts --suite default` to reset DB fixtures.
  3. Poll health endpoints (`http://localhost:3000/api/healthz`, `http://localhost:3001/api/healthz`) with retry/backoff.
  4. Bootstrap admin auth by calling `POST /api/admin/sessions` (or direct cookie injection helper) and write Playwright storage state files (`storage/admin.json`, `storage/customer.json`).
  5. Verify dependencies: MailHog API responds, Twilio sandbox webhook server available, stripe-cli listener healthy (if enabled via env flag).
- **Default reporter stack**: `["line", ["html", { open: "never" }], ["junit", { outputFile: "artifacts/e2e/junit.xml" }]]`. Ensure `use: { trace: "retain-on-failure", video: "retry-with-video", screenshot: "only-on-failure" }`.

## 2. Environment Orchestration Strategy

- **Single entrypoint (`pnpm -w dev:e2e`)**: Adds a workspace script that:
  1. Runs `docker compose -f devops/docker-compose.yml up -d postgres redis mailhog localstack twilio-sim` (Phase 2 expands compose to include missing services).
  2. Executes `pnpm -w dev` (site + api) and `pnpm outbox:worker` via `turbo run dev --parallel` or `concurrently` with prefixed logs (`[site]`, `[api]`, `[worker]`).
  3. Streams container logs to `logs/docker/*.log` for later attachment.
- **Hermetic config**: Both site and api process managers set `NODE_ENV=test` and `ENV_FILE=.env.e2e` so config drift cannot occur. `playwright.config.ts` exports `env` variables to tests (e.g., `process.env.ADMIN_API_KEY`).
- **Worker orchestration hook**: Provide a CLI (`pnpm tsx scripts/outbox-drain.ts`) that tests call to force-flush asynchronous jobs before assertions. Hook it into Playwright `test.step` wrappers to keep asynchronous flows deterministic.
- **Health management**: Add `scripts/e2e-watchdog.ts` to validate Docker + services are running before launching tests; exit early with actionable messages if prerequisites are missing (aligns with Phase 6 skip strategy).

## 3. Data Access & Seeding Helpers

- **Primary seeding via HTTP APIs**: Build `tests/e2e/support/api-client.ts` that wraps `fetch`/`undici` against `apps/api`. Helpers create leads, quotes, contacts, and admin sessions using published endpoints with `ADMIN_API_KEY`.
- **Fallback Drizzle client**: Expose `createDb()` utility inside `tests/e2e/support/db.ts` that imports `drizzle.config.ts` to run raw SQL for cleanup/truncation. Use only when HTTP endpoints would be too slow (e.g., truncating high-volume tables between tests).
- **Seed CLI**: Implement `scripts/seed-e2e.ts` (Phase 2 deliverable) which:
  - Drops/creates schema or truncates tables.
  - Inserts deterministic fixtures (services catalog, pricing contexts, baseline admin user).
  - Accepts `--with-quotes`, `--with-payments` flags so specialized suites can extend baseline data quickly.
- **Data tagging**: Shared utility `tests/e2e/support/data-tags.ts` exports `makeTestEmail("lead")` etc., ensuring every record is namespaced (`e2e+${suite}+timestamp@StonegateOS.test`). Cleanup script uses this tag to purge or verify isolation.
- **Auth helpers**: 
  - Customer flows: log in through UI for realism; optionally use MailHog API to capture magic-link tokens.
  - Admin flows: call `POST /api/admin/sessions` with `ADMIN_API_KEY` and set returned session cookie directly into Playwright storage state to bypass redundant UI steps while remaining zero-mock.

## 4. Diagnostics, Artifacts, & Tooling

- **Logging**: Pipe `apps/site`, `apps/api`, and worker stdout to `artifacts/e2e/logs/*.log` using `pino-multi-stream` or `concurrently`’s `--names` output capture. Attach these logs plus Docker service logs (Postgres, MailHog) to CI artifacts.
- **Tracing/video**: Configure `use: { trace: "on-first-retry" }` for local runs to limit noise, but override to `retain-on-failure` in CI via `PW_TRACE_MODE` env.
- **DB snapshotting**: Add optional toggle `E2E_DEBUG_SNAPSHOT=1` that triggers `pg_dump --schema-only StonegateOS > artifacts/e2e/db.sql` when tests fail to ease forensic analysis.
- **Telemetry hooks**: Wrap Playwright steps with `test.step` + structured logging so flakes show meaningful context (`await logStep("Wait for lead intake webhook", async () => { ... })`).
- **Package additions**: 
  - `@playwright/test`, `@testing-library/playwright`, `ts-node` for config, `dotenv-flow` or `dotenv-safe`.
  - Tooling for concurrency/logging: `concurrently`, `pino-pretty` (optional), `zx` for future scripts.

## 5. Remote Execution & Artifact Strategy

- **GitHub Actions workflow** (`.github/workflows/e2e.yml`, Phase 7 implementation) will:
  1. Use `runs-on: ubuntu-latest` with `container: mcr.microsoft.com/playwright:v1-ubuntu-jammy`.
  2. Cache `.pnpm-store` + `~/.cache/ms-playwright`.
  3. Run `pnpm install --frozen-lockfile`, `pnpm playwright install --with-deps`, `pnpm e2e:env`, `pnpm -w dev:e2e & ./scripts/wait-for-health.sh`, and finally `pnpm test:e2e`.
  4. Upload `artifacts/e2e/**` (traces, videos, logs, DB dumps) using `actions/upload-artifact`.
- **Matrix strategy**: Default PR workflow runs only `chromium-desktop`. Nightly workflow triggers on `main` with matrix `{ browser: [chromium, webkit], viewport: [desktop, mobile] }` and optional `stripe` flag to exercise payment suite.
- **Remote secret handling**: Use GitHub OIDC + 1Password Connect (or Doppler) to source `.env.e2e` secrets at runtime; never commit real credentials. CI job writes `.env` from template, while devs run `pnpm e2e:env` locally.
- **Future cloud execution**: Keep config compatible with Playwright Cloud/Grid by isolating environment assumptions in `globalSetup`. If remote grid is used later, `globalSetup` will short-circuit seeding when `REMOTE_ENV=true` and rely on already prepared staging DB.

---

These decisions unblock Phase 2 (Environment & Data Foundations), which will implement the compose extensions, seed CLI, and supporting scripts referenced above.
