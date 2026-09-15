# CRM unit/building address release — September 15, 2026

Status: deployed and verified at 21:07 UTC.

## Behavior

Saved second-address-line details now appear in appointment/calendar responses, CRM property labels, inbox addresses, and calendar/notification output. Mobile booking exposes new-address fields only when adding a new address. Mixed saved-property and new-address submissions are rejected instead of silently discarding entered details.

Property storage already preserved these values. This release adds no migration, changes no environment settings, and does not backfill values that were never submitted.

## Release source

- Production revision: `95462512792dfe4643ce6fe2705300052c66f6d9`, branch `release/unit-building-20260915`.
- Based on the previously live Site revision `e5616004`, with the address patch and its test-only lint correction. The separate partner design preview on development main is excluded.
- The same address patch and test correction are integrated on main in `8af1268e` and `691e89ab`.
- Added `workflow_dispatch` to the existing production journey workflow so an isolated release branch can run its complete gate.

## Validation

- API and Site production builds passed, including TypeScript validation.
- Three focused API suites: 11 tests passed.
- Mobile booking/action and Team Inbox browser suites: 13 tests passed, including 44 mobile action assertions.
- Focused ESLint and the three downstream address tests passed after the test-only correction.
- [Full production journey for the deployed revision](https://github.com/TailoredAgents/StonegateOS/actions/runs/35022869648) passed: API/Site regressions, browser recovery, worker rendering, PostgreSQL integration, production builds, and the real activation/location/request journey against disposable services.
- This report does not claim that the separate general repository E2E workflow passed.

## Deployments

All services were verified live at the production revision above.

| Service | Deploy | Live at (UTC) |
| --- | --- | --- |
| API | `dep-dakr37afngtc73du6c00` | 21:04:34 |
| Outbox worker | `dep-dakr3dlbedkc73c6v4mg` | 21:01:41 |
| Site | `dep-dakr4qnqj5pc73cq5nbg` | 21:06:38 |

## Live verification

- Custom-domain Site, Render Site, and API health endpoints returned HTTP 200.
- API readiness returned HTTP 200: configuration, portal, database, migrations, worker heartbeat, and outbox queue all healthy. Schema remained `0174_dynamic_crew_labor`; the final queue check had zero dispatchable events.
- Anonymous `/mobile` and `/team` requests retained their normal login redirects. Anonymous appointment API access remained HTTP 401.
- No API or Site error-level logs appeared between their deployment completion and final verification.
- No production appointment, contact, or message was created for verification; booking behavior was exercised through the local/browser and disposable-service release tests.

Worker logs continue to report an existing OpenAI `insufficient_quota` error for call transcription. The same failure was observed before this deployment, at 20:44 UTC. This address release does not change that integration or its billing.
