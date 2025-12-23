# E2E Testing Program – Phase 8 Expansion & Maintenance

> Note: This phase doc is a planning artifact. For current setup, see tests/e2e, playwright.config.ts, and devops/docker-compose.yml.


Phase 8 ensures the suite keeps pace with feature growth and stays observable. It introduces a shared "testing SDK", regression-pack scaffolding, and flake-metrics tooling so future journeys plug in quickly.

## 1. Testing SDK (`tests/e2e/support/sdk.ts`)
- Centralizes exports for API helpers, notification utilities, data factories, DB lookups, and wait helpers. Suites now import from a single module, minimizing brittle relative paths and making it trivial to share helpers with future regression packs.
- Existing specs were refactored to use the SDK, demonstrating the intended consumption pattern.

## 2. Flake & Runtime Metrics
- Playwright now emits a JSON report (`artifacts/e2e/json-report.json`) alongside HTML/JUnit outputs.
- `pnpm report:e2e` (backed by `scripts/e2e-metrics.ts`) parses the JSON to summarize pass/fail/flake counts and total duration. This allows nightly jobs or engineers to spot regressions quickly without manually opening the HTML report.

## 3. Regression Pack Guidance
- README references the growing regression suite and how logs/artifacts are captured. With the SDK + metrics in place, teams can add feature-specific specs (appointments board, billing, chat) with consistent diagnostics and reporting.

## 4. Maintenance Playbook
- Monthly flake reviews can now rely on the structured JSON report + metrics script.
- Helpers live under `tests/e2e/support/` and should be the only abstraction layer new tests import from, ensuring consistent tagging, cleanup, and dependency checks.

### Next Steps
1. Add targeted regression specs (appointments board, payments, chat) atop the SDK for full coverage.
2. Pipe `pnpm report:e2e` output into CI annotations or Slack to keep flake discussions visible.
3. Consider publishing the SDK as a workspace package if non-Playwright consumers emerge.
