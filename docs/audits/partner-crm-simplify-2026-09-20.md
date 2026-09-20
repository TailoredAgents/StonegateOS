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
