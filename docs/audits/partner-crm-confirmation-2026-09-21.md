# Partner request date and confirmation controls

The owner identified choosing the date and confirming service as the awkward part of an opened CRM Partner request. This release simplifies that panel and makes the saved result reliable when a subsequent detail read fails.

## User-visible result

- Client-requested dates are compact selectable choices. Repeated dates in the same time zone share one choice and retain every distinct time preference.
- Choose another date reveals the manual date field only when needed. Requests without usable date choices show the manual field immediately. Selecting a requested date focuses the start-time selector without choosing a time or submitting work.
- Start time uses explicit AM/PM half-hour choices, including overnight hours. Existing start times between those intervals retain their exact value. All scheduling controls remain usable touch targets in Chromium and WebKit.
- Optional crew, truck and equipment assignments remain collapsed. The final review distinguishes the planned start from the client's arrival window and sits directly above Confirm service.
- A successful confirmation immediately replaces the form with a saved result. A failed or stale detail refresh offers Retry details without reopening the confirmation form or repeating the scheduling mutation. Calendar and capacity warnings remain visible in that result.

The confirmation response must identify the correct appointment, confirmed status, submitted Eastern date/time and a valid version before the UI announces success. Invalid preview ranges cannot enable confirmation. Detail reads must match the selected company and request. Closing a request prevents a late callback from clearing another request's unsaved-edit state.

The existing scheduling transport, permission checks, client-approval rules, version checks and idempotency keys remain in use. This change contains no API, worker, database, customer-record or notification-setting changes. It is based on the already released capacity-warning change `6cf9ef75` and preserves that behavior. No live customer request is confirmed as part of testing.

## Verification

Source `08769da3d1b15d974d6cd92f50bc1b82cc758b53` passed the Site typecheck, all four actual CRM inbox browser cases (Chromium/WebKit at 1440px and 375px), and both shared scheduling resource browser cases. Desktop and phone screenshots were inspected, including WebKit's explicit 44px time selector. The inbox cases cover keyboard focus, custom and grouped dates, existing non-half-hour times, permissions, invalid acknowledgments, preview failures, and saved-result recovery with no duplicate confirmation.

The same source passed [required production release run 35658215561](https://github.com/TailoredAgents/StonegateOS/actions/runs/35658215561) in 15 minutes 8 seconds. All 1,710 counted tests passed without failures or skips: 1,052 API, 227 website, 41 focused API/auth/calendar, 44 browser recovery, 103 capacity-warning regressions, 239 PostgreSQL, two real activation journeys, and two full CRM handoff journeys. The handoff ran at 1440px and 375px against production builds and a disposable database; both result receipts verify that all submitted fields and the draft photo survived confirmation. Worker rendering/import checks passed with zero network attempts. Both production builds passed. Targeted UI lint reported zero errors and five existing-pattern hook/image warnings.

The API and outbox worker require no new deployment for this UI change. The exact tested application commit is used for Site deployment. Main additionally retains the independently published capacity-release audit through merge `8d6199ca`; the only difference from the tested source is that audit document. The rollout check verifies this before requesting the exact application commit, preventing an untested application change from entering the deployment.

## Live release

Site deployment `dep-daoqeltg1s2s7388qlr0` became live at **2026-09-21 21:57:16 UTC**, using the exact tested application commit `08769da3d1b15d974d6cd92f50bc1b82cc758b53`. The code and capacity-release notes were pushed to main before the deployment. No maintenance mode or credential changes were needed.

Post-deployment checks at 21:58:05 UTC passed with normal TLS verification: health and readiness on the canonical Site domain, Render Site domain and API; CRM and Partner sign-in pages on both Site domains; and an unauthenticated request to the exact LandL CRM request redirecting to normal team sign-in with its full return path preserved. The existing release checker separately verified effective portal configuration and database migration readiness.

The reviewed logs after the live rollout contained no Site application errors and no HTTP 500–599 responses on Site or API; neither query was truncated. These are bounded post-deployment checks, not a claim about future traffic or unrelated historical errors. Authenticated confirmation and photo preservation were tested on the controlled production builds and test database. No live customer booking or additional owner text was created by this release.
