# E2E Testing Program – Phase 7 CI/CD Integration & Gating

> Note: This phase doc is a planning artifact. For current setup, see tests/e2e, playwright.config.ts, and devops/docker-compose.yml.


Phase 7 wires the hermetic Playwright suite into GitHub Actions so every PR/push exercises real browser flows before merging. The workflow mirrors local `pnpm dev:e2e` semantics, captures diagnostics, and publishes artifacts for triage.

## 1. GitHub Actions Workflow (`.github/workflows/e2e.yml`)
- Triggers on pushes and PRs targeting `main`.
- Steps:
  1. Checkout + Node 18 setup with pnpm cache.
  2. `corepack enable` + `pnpm install --frozen-lockfile`.
  3. `pnpm exec playwright install --with-deps` to preload browsers.
  4. `docker compose -f devops/docker-compose.yml up -d` to spin Postgres/MailHog/Twilio mock/LocalStack.
  5. `pnpm e2e:env` + `mkdir -p artifacts/e2e/logs` to ensure deterministic config and log dirs.
  6. `pnpm dev:e2e &` starts Site + API + worker with log teeing; workflow waits for `/api/healthz` on :3000/:3001 before proceeding.
  7. `pnpm test:e2e` runs the Playwright suite (which already seeds, bootstraps auth, and captures artifacts).
  8. Always upload `artifacts/e2e/**` (Playwright traces, videos, HTML report, service logs, docker logs) for debugging.
  9. Always kill the dev stack, collect `docker compose logs`, run `docker compose ... down`, and execute `pnpm cleanup:e2e` to leave the database clean.

## 2. Workflow-Aware Tooling
- `tests/e2e/test.ts` health checks ensure CI skips fast if a dependency failed to bootstrap, preventing 30‑minute timeouts.
- `tests/e2e/global-teardown.ts` runs `cleanup:e2e` locally and remotely; the workflow’s final step calls it again defensively.
- `package.json`’s `dev:e2e` already produces structured per-service logs, simplifying artifact gathering.

## 3. README Notes
- Documented that CI collects logs in `artifacts/e2e/logs` and that the suite issues clear skip messages when dependencies are down, so engineers know what to expect when browsing Actions logs.

## Next Steps
1. Hook the workflow into branch protection so PRs require `Playwright E2E` + lint/unit before merging.
2. Add a nightly cron job (matrix across browsers/devices) if runtime budgets allow to catch flaky tests off the PR path.
