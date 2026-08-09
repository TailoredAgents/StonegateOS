# `/team` CRM audit evidence index

Captured 2026-08-05 from commit `116339d` on `main`.

## Available evidence

- `baseline-results.json` — command outcomes, environment, durations, test/build/lint counts, and runtime blockers.
- `route-inventory.csv` — canonical 23 tabs, auth routes, aliases, auxiliary instant-quote route, and classic compatibility path.
- `surface-inventory.csv` — 33 source-backed surfaces with subviews, intended roles, actions, proxies/server actions, upstream endpoints, entities, and evidence.
- `role-tab-access-matrix.csv` — all 23 canonical tabs across owner, office, sales, crew, read-only, and custom effective-permission expectations versus current behavior.
- `sensitive-action-matrix.csv` — 35 authorization, upstream permission, attribution, and runtime-gap records spanning every canonical tab plus auth/compatibility surfaces.
- `findings.json` — 25 machine-readable findings using the requested `AuditFinding` fields.
- `tab-scorecards.csv` — all 23 requested scorecards using the requested weights.
- `auxiliary-scorecards.csv` — dimension-level scorecards for login, callback, modern shell, aliases, instant quotes, and classic.
- `coverage-matrix.csv` — executed static coverage and explicitly blocked runtime cells.
- `journey-results.csv` — the seven critical journeys, all marked not run with their exact prerequisites.
- `staff-session-guide.md` — script and measures for the five required think-aloud sessions.
- `playwright.team-audit.config.ts` and `tests/e2e/audit/` — separate audit-only role, viewport, theme, shell, alias, and security suite.

## Evidence confidence

`high-static` means two source paths independently establish the behavior or a single path is mechanically definitive. It does not claim a browser or deployed exploit was executed. `medium-static` identifies a strongly evidenced risk whose user/provider outcome still depends on runtime configuration.

No production mutations, customer sends, payment actions, advertising changes, publishing actions, or destructive database operations were performed.

## Evidence not captured

The following directories/files are intentionally absent rather than fabricated:

- Redacted screenshots and videos: no browser test reached an application page.
- Console/network captures: the local Site and API were unavailable.
- Core Web Vitals/trace files: Chrome DevTools MCP is not configured.
- Database before/after and provider-mock assertions: Docker is absent and PostgreSQL refused the E2E seed.
- Staff recordings and utility scores: no representative participants were available in the repository session.

## Runtime prerequisite and command

Provide the repository's isolated E2E services or a sanitized staging clone, sandbox provider credentials, and Chrome DevTools MCP. The active `DATABASE_URL` must exactly match `.env.e2e`; a remote disposable clone also requires the explicit destructive acknowledgement documented in `tests/e2e/audit/db-safety.ts`. Never acknowledge a production or shared database. Then run in separate terminals:

```bash
corepack pnpm dev:e2e:team-audit
corepack pnpm test:e2e:team-audit
```

The audit suite expresses desired authorization behavior. It is expected to fail on the confirmed P0/P1 findings until remediation is completed; those failures should remain evidence, not be weakened to match current behavior.

After the security gate passes, add fixture-backed implementations for the seven `test.fixme` critical journeys, provider timeout/partial-failure injection, database/audit assertions, axe scans, and screenshot comparisons.
