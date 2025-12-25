# E2E Testing Program – Phase 6 Diagnostics & Reliability

> Note: This phase doc is a planning artifact. For current setup, see tests/e2e, playwright.config.ts, and devops/docker-compose.yml.


Phase 6 focuses on making the suite trustworthy: deterministic dependency checks, structured logging, and automatic cleanup reduce flake risk and speed up triage.

## 1. Dependency Health & Skips
- New shared test harness (`tests/e2e/test.ts`) validates the site/API health endpoints plus MailHog and Twilio mock before each test. Missing services automatically call `testInfo.skip("Missing dependencies: …")`, surfacing actionable messages instead of mysterious failures.
- Health probes hit the configurable `.env.e2e` hosts, so CI or developers can point the suite at remote stacks while still benefiting from the guardrails.

## 2. Structured Logging + Artifacts
- `pnpm -w dev:e2e` now mirrors each service’s stdout/stderr into `artifacts/e2e/logs/{site,api,worker}.log` via `tee`, keeping the console readable while persisting raw logs.
- On any test failure, `tests/e2e/support/log-attachments.ts` tail-loads the last 200 log lines per service and attaches them directly to the Playwright report/test artifacts, so debugging doesn’t require reproducing locally.

## 3. Deterministic Cleanup & Watchdog
- Global teardown invokes `pnpm cleanup:e2e` to wipe tagged data even when tests abort midway, satisfying the “watchdog” requirement and preventing residue from polluting subsequent runs.
- Lead/quote specs now use `test.step` sections with explicit polling helpers (`tests/e2e/support/wait.ts`) instead of arbitrary sleeps, enabling Playwright’s retry mode to re-run only the failing steps with high-fidelity logs.

## 4. Developer Guidance
- README highlights the new log capture + health-skip behavior so engineers know where to look when runs fail.
- Existing helpers (`mailhog.ts`, `twilio.ts`, `outbox.ts`) were left untouched but now slot into clearly named `test.step` blocks for better trace readability and diagnostics.

### Next Steps
1. Phase 7: wire the suite into CI (GitHub Actions) using the deterministic scripts/log artifacts introduced here.
2. Extend diagnostics to include DB snapshots or `docker compose logs` attachments for especially tricky failures if needed.
