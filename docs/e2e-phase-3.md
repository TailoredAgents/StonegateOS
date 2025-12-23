# E2E Testing Program – Phase 3 Playwright Scaffolding

> Note: This phase doc is a planning artifact. For current setup, see tests/e2e, playwright.config.ts, and devops/docker-compose.yml.


Phase 3 introduces a fully wired Playwright test harness with multi-project coverage, global setup hooks that seed/verify the environment, and a support layer for data + service helpers. This is the foundation for building the Phase 5 core journeys.

## 1. Runner Configuration
- Root `playwright.config.ts` defines two projects: `chromium-desktop` (Desktop Chrome) and `webkit-mobile` (iPhone 13 profile). Shared defaults include `trace: "retain-on-failure"`, `video: "retry-with-video"`, `screenshot: "only-on-failure"`, and `storageState: tests/e2e/storage/visitor.json`.
- Reporters: `list`, HTML (`artifacts/e2e/html-report`), and JUnit (`artifacts/e2e/junit/results.xml`). Output from all projects lands under `artifacts/e2e/test-results` for easy CI artifact upload.
- Global setup (`tests/e2e/global-setup.ts`) loads `.env.e2e`, runs `pnpm seed:e2e`, waits for `http://localhost:3000/api/healthz` + `:3001/api/healthz`, and materializes empty visitor/admin storage-state files.

## 2. Support Utilities (`tests/e2e/support/*`)
- `env.ts` centralizes `.env.e2e` loading plus helpers (`getEnvVar`, `getOptionalEnvVar`). The config and helpers all go through this layer to prevent missing secret surprises.
- `seed.ts`, `health.ts`, and `auth.ts` provide reusable primitives for future suites (manual re-seeds, health polling, storage-state authoring once admin bootstrap lands in Phase 4).
- `api-client.ts`, `mailhog.ts`, `twilio.ts`, and `data-factories.ts` offer zero-mock helpers for API orchestration, inbox/SMS inspection, and deterministic test data tags. These modules will back the Phase 5 journeys (lead intake, quote lifecycle, notifications).

## 3. Spec Layout & Sample Test
- Tests live in `tests/e2e/specs`. A smoke spec ships now to verify the wiring: it loads the home hero and hits the API health endpoint so we know browser + API contexts function end-to-end.
- `tests/e2e/tsconfig.json` gives editors/types strict linting with Node 18 + Playwright types.
- Storage seeds live under `tests/e2e/storage/` with `.gitkeep` so Playwright always has a deterministic path to write state.

## 4. Dev Ergonomics & Scripts
- New scripts in `package.json`: `pnpm test:e2e` (headless default) and `pnpm test:e2e:headed` (Chromium headed for debugging). These slot directly into future Turbo tasks + CI jobs.
- README now documents how to sync env, seed the DB, start the hermetic stack, and run the Playwright suite.

### Next Steps
1. Build auth helpers that generate real admin/customer storage state (Phase 4 requirement) using the `api-client` + session endpoints.
2. Flesh out data factories and support modules to cover quote creation + worker flush hooks (outbox draining CLI).
3. Start encoding the Phase 5 journeys (lead intake + quote lifecycle) atop this harness, tagging data for cleanup and asserting UI + DB + queue behavior.
