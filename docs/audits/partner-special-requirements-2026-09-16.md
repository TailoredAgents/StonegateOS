# Partner Special requirements — 2026-09-16

## Change

The expanded Special requirements section previously showed quantity fields, both long materials/equipment lists, deadline fields, and multiple-stop controls together. It now presents five compact, optional rows:

- Handling and access.
- Materials needing review.
- Completion deadline.
- Additional stops.
- Quantity estimate.

Each row opens independently and shows a summary of saved values when closed. Native keyboard navigation and 44px-or-larger checkbox targets are retained. Closing a row does not clear its fields. The deadline remains subject to Stonegate review and is distinguished from preferred service dates in Scheduling.

Existing scope keys, allowed option values, normalization, autosave, staff-confirmation rules, and CRM projections are unchanged. Both general handling declarations are retained: material categories imply restricted handling, and equipment/additional stops imply non-standard work. No API, database, price, company-setting, or storage change is required.

Validation opens the relevant nested row and error links focus its field or checkbox group. Browser tests exposed an existing WebKit race in the outer controlled disclosure: a delayed native toggle could undo an error-driven open. Native disclosure state now owns expansion, with a ref effect that only reveals validation errors. Repeating the same invalid submission also reopens the row.

## Verification

- Eleven focused tests passed for error routing/focus, scope serialization, and staff request parsing.
- Ten actual-component browser cases passed in Chromium/WebKit at desktop and phone widths. They cover compact initial state, keyboard navigation, exact outgoing scope, retained collapsed values, repeated nested validation reveal and focus, CRM rendering, and responsive bounds.
- Actual rendered desktop/phone screenshots were visually reviewed. Files are retained in `artifacts/partner-special-requirements`; browser log: `/tmp/stonegate-special-requirements-browser-final.log`.
- Scoped lint, formatting, and diff checks passed. Site typechecking passed in the isolated release worktree, independent of concurrent unrelated local work.
- The existing full database/production-build CRM journey was updated only to open the new groups and locate the shorter multiple-stop label; all existing data assertions remain.

## Release

- Source: `95b6a22c` on main.
- Exact release: `c260e2a920b19c8a2f9994e7ac2321024dd629e6`, branch `release/partner-special-requirements-20260916`.
- Release baseline: live Site `79f57dcb5e93bc2b5f8a7bc2256d2865071b77b5`, preserving the latest contractor-page changes and prior photo-upload fix.
- Required exact release gate: https://github.com/TailoredAgents/StonegateOS/actions/runs/35108492127. Matching main gate: https://github.com/TailoredAgents/StonegateOS/actions/runs/35108494379. Both passed for their exact committed SHAs. The release gate completed at 14:38:54 UTC.
- Exact release counts: API 139 suites / 999 tests; Site 203 tests; focused API 3 suites / 14 tests; browser/config 35 checks; PostgreSQL 41 suites / 223 tests. Worker checks made zero network attempts. Both production builds and all four real empty-company/CRM journeys passed. Full log: `/tmp/stonegate-special-requirements-release-ci-full.log`.
- Site deployment `dep-dalcvaf40ujc73dj43og` started at 17:19:37 UTC after a guarded check of the exact successful gate, unchanged live baseline, and configured private-media origin. It became live at 17:23:46 UTC with exact SHA `c260e2a920b19c8a2f9994e7ac2321024dd629e6`.
- The separate general E2E workflow, https://github.com/TailoredAgents/StonegateOS/actions/runs/35108494467, stopped at broad API unit tests. Comparison with previous main run `35039105866` found the same 129 failing suites and 207 unique failure headings, with no added or removed failure. Both runs reported 330 passing suites / 3,368 passing tests and 61 skipped suites / 269 skipped tests. Current general typecheck, lint ratchet, and quote/expense database jobs passed. These preexisting repository failures were not changed as part of this portal design update.

Live verification passed after deployment:

- At 17:24:12–13 UTC, a fresh Chromium browser with normal certificate verification reached canonical health (200), Billing (normal sign-in redirect with unchanged restrictive storage policy), and the saved-request sign-in redirect with its draft ID preserved.
- At 17:24:18 UTC, provider-host checks passed for API/Site health, portal readiness, database/migrations/worker health, unauthorized catalog protection, saved-request redirection, and the private-photo storage policy. The outbox had zero dispatchable events.
- No API/Site application errors or portal-path HTTP 5xx responses appeared in the observed 17:23:46–17:24:19 UTC log window.
- Live evidence: `/tmp/stonegate-canonical-partner-postdeploy-result.json` and `/tmp/stonegate-requirements-provider-live-checks.json`.

Authenticated write journeys ran against controlled production builds and a disposable database; live checks were unauthenticated and read-only. Only controlled local test records were used for writes. No production customer request or upload was created for this design change.
