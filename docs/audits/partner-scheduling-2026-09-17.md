# Partner scheduling — 2026-09-17

## Change

Scheduling now starts with one preferred date and time. Alternative dates, the completion deadline, and scheduling help are optional collapsed rows. Each backup date has its own time preference. Saved choices appear in row summaries; the review page shows each date and its corresponding time. The timezone uses a readable name such as Eastern Time, and the call link stays visible without opening the help row.

Removed the large warning-colored preference panel, duplicate recommended-window/date suggestions, and three oversized follow-up cards. Eligible accounts with actual available windows use one date selector and one arrival-window grid. Refresh appears only for that branch; availability failures offer Try again and retain the support reference and saved preferences. The normal staff-review path clearly says Stonegate confirms the appointment.

The previous implementation applied the first date's time to every saved date. Restoration and serialization now preserve each date's individual preference using the existing API contract. Local validation requires the primary date, distinct real calendar dates, and dates within the existing tomorrow-to-30-day range in the service location's timezone. Error links map compact server indices correctly when an optional date is blank. Optional inputs remain mounted while collapsed, and invalid fields open their containing row.

Autosave, revision checks, temporary hold release/expiry, uncertain-submission protection, and staff confirmation remain in place. No API, database, customer-setting, or payment change is included.

## Verification

- Site typechecking, scoped ESLint, formatting, and diff checks passed. All 227 Site portal unit tests passed, including individual date/time restoration, serialization, date validation, and error navigation.
- Independent review found no concrete regression in save/validation failures, availability recovery, hold lifecycle, compact server-index mapping, or staff-confirmed submission.
- Browser checks exposed two product issues during implementation: select options were included in their enclosing labels' accessible names, and advancing into Scheduling cleared the availability failure notice. The labels are now correctly associated and the notice survives advancement. Exact-label and support-reference assertions remain.
- A previous source-text-only assertion for the removed recommendation cards was replaced by actual browser checks for follow-up selection, the call link, and confirmation wording. Existing behavioral helper tests remain.

- All six actual-Wizard browser cases passed across desktop/phone Chromium and WebKit. Checks include compact/expanded layouts, keyboard navigation, exact accessible labels, the always-visible call link, independently saved time preferences, missing/duplicate/past dates, server-index gaps, correlated availability failures and retries, temporary hold rejection/retry/release, and existing contact, billing, photo, and deadline behavior. Log: /tmp/stonegate-partner-scheduling-browser-final.log. Visually reviewed previews: artifacts/partner-scheduling.
- The production CRM fixture now opens the optional rows and explicitly chooses all three time preferences. Existing API, database, CRM, and security assertions are preserved.

## Release

Source committed and pushed to main: b99a99bfa13d5b69fb07b13ac58df54c8eef6a54. The ten relevant source/test files were copied into an isolated worktree based on latest main a5a5a19c, preserving concurrent commercial-page changes and excluding unrelated working-copy edits. The current live commercial release f1e1de44 and a5a5a19c have identical Git trees.

Required gate: https://github.com/TailoredAgents/StonegateOS/actions/runs/35296210320.

The separate general E2E run, https://github.com/TailoredAgents/StonegateOS/actions/runs/35296210354, passed typechecking, the lint ratchet, and Quote/Expense PostgreSQL jobs. Its broad API unit step has exactly the same failure set as both immediate a5a5a19c and canonical 8c55 baselines: 129 failing suites and 207 unique failure headings, with no additions or removals; 330 passing suites / 3,368 passing tests and 61 skipped suites / 269 skipped tests. Evidence: /tmp/stonegate-scheduling-general-e2e-comparison.json and /tmp/stonegate-scheduling-general-e2e-failed.log.

The required gate passed at the exact source SHA: 139 portal API suites / 998 tests; Site 227 tests; three additional API contract suites / 14 tests; browser/CSP 35 checks; and 41 PostgreSQL suites / 223 tests. Worker import/render checks made zero network attempts. API and Site production builds passed. All four real production-build journeys passed: desktop and phone first-company journeys, plus desktop and phone complete-field CRM handoffs. Full log: /tmp/stonegate-scheduling-required.log. Summary: /tmp/stonegate-scheduling-required-summary.json.

Site deployment dep-dam9j96k1f9s73eof9fg was triggered at 2026-09-18 01:53:40 UTC for exact source b99a99bfa13d5b69fb07b13ac58df54c8eef6a54 after verifying the successful required gate, unchanged live baseline f1e1de44, no competing deployment, and the configured private-media origin.

The deployment became live at 2026-09-18 01:56:50 UTC with the exact tested source SHA.

## Live verification

- At 01:57:25 UTC, provider-host checks passed for Site/API health, effective portal availability, database/migrations/worker readiness, protected catalog access, saved-draft sign-in redirection, and the private-photo policy. There were zero dispatchable outbox events.
- At 01:57:26–27 UTC, fresh Chromium with normal certificate verification passed canonical-domain health and sign-in checks. Billing and the saved request redirected normally; the original draft ID remained in the sign-in return path. The private-media policy remained limited to its intended image/connect directives.
- No API/Site application errors or portal HTTP 5xx responses appeared in the observed 01:56:50–01:57:38 UTC post-deployment log window.
- Evidence: /tmp/stonegate-scheduling-provider-live.json, /tmp/stonegate-scheduling-canonical.json, and /tmp/stonegate-scheduling-live-logs.json.

Authenticated write journeys used production builds with a disposable database. Live checks used normal unauthenticated browsing and read-only requests. No production customer job, upload, or account setting was created or changed for this update.
