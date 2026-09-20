# Simpler partner request review

The owner reported that the new CRM request screen was still crowded and difficult to navigate. The user also confirmed that the previously authorized TEST text arrived on the phone ending 8806. This release changes the website presentation; it does not change alert settings, send another test, migrate the database, or change scheduling decisions.

## Result

Opening a request now shows a focused, full-width review. The request list and filters remain mounted but hidden, and Back to requests restores the search, request type, and scroll position. Requests retains the three main workspace links without an extra Partners introduction, company navigation strip, or Add partner action. Company-scoped links retain their actual account filter and verified company name.

The review starts with service, company/requester, address, status, and received time. Requested work, a quick on-site phone link, important instructions, and customer photos sit together. Supplied photos open automatically. Three supporting disclosures retain contact/access, work order/billing, and job requirements; the last includes special handling and completion-photo preferences. Existing Calendar/Mobile booking cards keep their original presentation and all submitted fields.

The separate scheduling panel shows every client preference and follow-up request, then Service date, Planned start time, the verified two-hour arrival window, and Confirm service. Planned start time deliberately differs from the arrival-window boundary: an internal 10:30 start can correspond to a 10–12 client window. On phones, Set schedule moves focus directly to this panel. Optional crew/truck/equipment choices remain mounted when collapsed, retain selections, and reopen on actionable errors.

No required approvals, permission checks, capacity checks, version checks, idempotency behavior, or arrival-preview gating were removed. A request blocked from initial scheduling is not described as handled; client approval is not described as Stonegate confirmation. A follow-up preference of `none` does not become a callback request. Actual owner openings retain the existing successful/visible/detail-or-complete-group requirements.

## Validation

- Website typecheck passed.
- Scoped component lint passed with no errors; existing hook/image warnings remain.
- Request inbox browser matrix passed in Chromium and WebKit at 1440px and 375px. It uses the real components, structured request DTO, workspace navigation, and theme; only server-action boundaries are mocked. It checks focused review, preserved filters/scroll, owner opening rules, failed/malformed reads, dirty forms, preview failures, manual resource selection, callback/waitlist/none copy, and requested versus confirmed timing.
- Shared request-details browser matrix passed 4/4, including all submitted fields, financial/photo permissions, keyboard access, and photo-refresh recovery.
- Navigation checks passed 15/15, including default Requests, Companies, scoped bookmarks, restricted roles, error/malformed responses, keyboard access, and overflow. The harness contained stale assumptions from before the previous Requests release; these were updated without weakening permission or company-isolation checks.
- Existing non-partner resource browser checks and additional partner resource checks passed in Chromium and WebKit, including collapsed selection retention and guarded retry.

The production CRM journey still verifies every saved field, photos, normal sign-in, confirmation, and resulting Calendar/Mobile records. Its Inbox assertions now match the focused review; its original booking-card assertions remain intact. The required exact-commit production gate and live deployment evidence are recorded after rollout below.

## Required production gate

Source `7171083fda1cf5a87ede1c41614a44a6b7eb67ba` passed [release run 35543654273](https://github.com/TailoredAgents/StonegateOS/actions/runs/35543654273) before being pushed to main and deployed:

- API: 144 suites / 1,052 tests.
- Website: 227 tests.
- Compatibility: 7 suites / 41 tests.
- Browser, authentication, and content-security checks: 44 tests.
- PostgreSQL: 43 suites / 239 tests.
- Production API and Site builds passed.
- Real empty-company desktop/phone journeys: 2/2.
- Real CRM details, photos, confirmation, Calendar, and Mobile journeys: 2/2.
- Production worker dispatch/finalization/reminder/replay and PDF/import checks passed with zero network attempts.

All reported tests in this required gate passed without skips. This is the required Partner Portal release gate, not a claim that every unrelated repository test lane is green.

## Live rollout

Before deployment, API/Site health and readiness returned 200; the API reported migration 0175, a healthy worker, and zero dispatchable events. A TLS-verified, read-only database check found LandL's single request still `under_review`, owner alert settings still enabled at revision 2 for 8806, and exactly one prior TEST operation with one provider attempt.

Only Site was updated. API and worker remain on verified source `7a721e5516983049e707ef1e35f405bcafd9ac35`. Site deployment `dep-dao6ktugekts73b3br00` became live at `2026-09-20T23:25:31.865577Z` on the exact tested source `7171083fda1cf5a87ede1c41614a44a6b7eb67ba`. Deployment was guarded against a changed live baseline or competing deployment. The existing automatic-deploy settings are unchanged; the source commit uses `[skip render]` for this controlled rollout.

After deployment, all four API/Site health and readiness checks returned 200 at `2026-09-20T23:25:53Z`. LandL's single existing request remained `under_review`; alert settings remained at revision 2 for 8806; the TEST operation count and attempt count remained one. Verification created no customer work, scheduled no live request, and sent no additional text.

The local network still has the previously documented custom-domain TLS filtering problem, so a separate read-only Render job checked the public domain with normal certificate validation. Job `job-dao6n0h42hec738lo0ug` succeeded at `2026-09-20T23:26:42Z`: public health and sign-in returned 200, and the protected request URL returned 307 to sign-in with its exact request destination preserved. The hosting-domain request URL independently passed the same redirect check. No authenticated production session or owner-opening record was manufactured.

Post-deployment Site/API application-log review found no warning or error records between `2026-09-20T23:25:32Z` and `2026-09-20T23:27:48Z`. These are point-in-time checks; full authenticated interactions and all submitted fields were verified against the real controlled database in the production-build release journeys.
