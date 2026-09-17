# Partner work order and billing — 2026-09-17

## Change

Work order and billing now keeps the optional work order/PO number visible, with project/cost-center references and the billing contact in two compact native disclosures. Saved values appear in summaries. All inputs remain mounted when collapsed so editing state and error-link navigation are preserved. Billing copy records a contact for questions about the job without promising automatic invoice delivery.

PO number, cost center, and project reference remain separate fields in the existing draft, request, and CRM mappings. PO and cost-center presence can participate in approval-rule matching; this update does not change those rules. Partial billing contacts can still autosave while editing, but continuing requires both a name and valid email or both fields blank. Validation now points to the specific missing/invalid billing field, and editing clears the corresponding nested commercial errors.

Existing field limits, saved blank values, permission boundaries, payment availability, and staff confirmation remain unchanged. No API, database, or live account-setting change is included.

## Verification and release

- Site typechecking, scoped ESLint, formatting, diff checks, and all 218 website portal tests passed.
- Independent review confirmed unchanged draft serialization/restoration, approval inputs, CRM field mappings, and financial-permission boundaries. The real CRM fixture opens the new rows before editing/reloading and adds restored-value assertions without removing any existing checks.
- Desktop and phone compact layouts were visually inspected. Previews are in artifacts/partner-work-order-billing.

- All six actual-Wizard browser cases passed across Chromium/WebKit and desktop/phone. Checks cover compact and expanded layouts, keyboard use, nested billing/reference error routing, exact saved commercial fields, restored values, clearing all fields and reopening the empty draft, and the existing photo/scheduling flows. Log: /tmp/stonegate-partner-work-order-billing-browser-final.log.
- One existing photo-navigation test raced the existing animation-frame focus after blocked navigation. The test now waits for the photo container to receive focus after both blocked Back/progress clicks before using the next keyboard disclosure. All original file-preservation and keyboard open/close assertions remain. No photo component or navigation behavior changed.

Source committed and pushed to main: 8c55db33a4a8eecb8b122daf48670d656b80a9ec. Only the four relevant source/test files were included; unrelated concurrent workspace changes were excluded.

Required production journey: https://github.com/TailoredAgents/StonegateOS/actions/runs/35279055757.

The separate general E2E run, https://github.com/TailoredAgents/StonegateOS/actions/runs/35279055758, passed typechecking, the lint ratchet, and Quote/Expense PostgreSQL jobs. Its broad API unit step has exactly the canonical c3 baseline failure set: 129 failing suites and 207 unique failure headings, with no additions or removals; 330 passing suites / 3,368 passing tests and 61 skipped suites / 269 skipped tests. The previously diagnosed random no-op tamper assertion did not fail in this run. Evidence: /tmp/stonegate-work-order-billing-general-e2e-comparison.json and /tmp/stonegate-work-order-billing-general-e2e-failed.log.

The required production journey passed at the exact source SHA. Counts: 139 API suites / 998 tests; Site 218 tests; three additional API contract suites / 14 tests; browser/configuration 35 checks; 41 PostgreSQL suites / 223 tests. Worker rendering/import checks passed with zero network attempts. Both production builds and all four actual desktop/phone journeys passed: two first-company journeys and two complete CRM handoffs. Full log: /tmp/stonegate-work-order-billing-required.log; summary: /tmp/stonegate-work-order-billing-required-summary.json.

Site deployment dep-dam68ngu01pc73eggej0 was triggered at 22:06:22 UTC for exact source 8c55db33a4a8eecb8b122daf48670d656b80a9ec after verifying the successful required gate, unchanged live baseline 6eacb0bf, no competing deployment, and the configured private-media origin.

The deployment became live at 22:09:46 UTC with the exact tested source SHA.

## Live verification

- At 22:10:29 UTC, provider-host checks passed for Site/API health, effective portal availability, database/migrations/worker readiness, protected catalog access, saved-draft sign-in redirection, and restrictive private-photo policy. There were zero dispatchable outbox events.
- At 22:10:30–31 UTC, fresh Chromium with normal certificate verification passed canonical-domain health and sign-in checks. Billing and the saved request redirected normally; the user's original draft ID remained in the sign-in return path. Private-media policy remained limited to its intended image/connect directives.
- No API/Site application errors or portal HTTP 5xx responses appeared in the observed 22:09:46–22:10:42 UTC post-deployment log window.
- Evidence: /tmp/stonegate-work-order-billing-provider-live.json, /tmp/stonegate-work-order-billing-canonical.json, and /tmp/stonegate-work-order-billing-live-logs.json.

Authenticated write journeys used production builds with a disposable database. Live checks used normal unauthenticated browsing and read-only requests. No production customer job, upload, or account setting was created or changed for this update.
