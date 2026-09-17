# Partner request questions — 2026-09-16

## Change

Replaces the previous five-group Special requirements section with questions at the point where clients use them:

- Service details: two optional item choices (very heavy/oversized items; disassembly) and one compact materials disclosure with specific categories and an unknown-material option.
- Contact and access: stairs, elevator, and loading dock alongside existing contact/access instructions.
- Service address: optional additional addresses and stop order, using the existing staff-reviewed stop-notes model.
- Scheduling: an optional completion deadline, explicitly subject to Stonegate confirmation and distinct from preferred service dates.

Ordinary new requests no longer show general handling declarations, crew/equipment decisions, a separate item count, or a cubic-yard estimate. Existing lift-gate/demolition selections, numeric quantities (including zero), and general declarations remain editable in a conditional Saved request details disclosure. The catalog now preserves validated requiredScopeFields metadata; services that require a numeric quantity still display it, and server errors can reveal a missing quantity field even when older catalog responses omit the metadata.

Existing scope serialization, staff-confirmation rules, pricing, selected add-ons, contacts, proof requirements, upload behavior, and CRM projection remain intact. Removing a work/access selection only removes that specific array key. Old aggregate flags are retained rather than guessed from their children; a saved standalone flag remains available for clearing and undoing. No API, database migration, live account setting, payment, notification, or storage change is part of this release.

## Validation behavior

Multi-stop errors route to Service address; deadline errors route to Scheduling. Indexed equipment errors use the normalized full equipment array and a fixed checkbox-ID allowlist to open and focus the correct Work, Access, or saved-detail control. Native disclosures retain edits and reopen on validation errors.

Deadline edits invalidate availability and release any existing hold. Advancing from Scheduling revalidates the saved request and checks fresh availability before allowing Review. All step inputs are disabled while saving to advance, validating availability, choosing a hold, or submitting, preventing stale responses from racing with edits.

Error-summary links share the normal navigation guard: they cannot leave Service details with unattached selected photos, navigate during a busy request, or bypass an uncertain submission. Same-step error correction remains available. Quantities revealed by a server error stay mounted while the user clears and corrects them, including when older catalog metadata omitted the requirement.

## Verification

- Site typechecking, scoped lint, formatting, and diff checks passed.
- Twenty-four focused tests passed for catalog validation, scope serialization, CRM parsing, and field routing/focus.
- The full local Site portal suite passed 210 tests. Four focused API suites passed 71 tests for request details, scheduling, approval resolution, and requestability.
- All ten actual-component browser cases passed: six Wizard cases across Chromium/WebKit and 1440px/375px viewports, plus four staff-panel cases. They cover moved-field error routing, exact outgoing scope, photo attachment, legacy flags and quantity preservation, missing catalog metadata, required quantities, changed-deadline revalidation, and the fresh arrival-window guard. Logs: /tmp/stonegate-partner-request-questions-wizard-final.log and /tmp/stonegate-partner-request-questions-staff.log.
- Desktop and phone renders were visually reviewed. Browser artifacts are retained locally in artifacts/partner-request-questions.
- A follow-up six-case browser run passed the photo-navigation regression: an autosave error for a moved Address field cannot discard a selected File when its error link is clicked. Existing upload/retry assertions still pass. Log: /tmp/stonegate-partner-moved-error-photo-guard.log.

## Release

- Source committed and pushed to main: 9a0f12cc9a3499f0dcb6961802e570dbf3680613. Only the eleven relevant source/test files were included; concurrent unrelated workspace edits were excluded.
- First required gate: https://github.com/TailoredAgents/StonegateOS/actions/runs/35166223582. API 998, Site 210, route 14, browser 35, PostgreSQL 223, both production builds, both empty-company journeys, and phone CRM handoff passed. Desktop CRM stopped in controlled legacy-fixture setup because its ETag was stale (HTTP 412); it had read the draft while the form was still mounted. No production deployment was attempted from this failed gate.
- Follow-up commit 1496367cfbe57fff12e5e91319103f22e3a87a16 changes only that fixture: leave the form first, read the current draft through the existing authenticated portal boundary, and retry only an HTTP 412 with a fresh GET, up to three attempts. All success and CRM assertions remain. Its gate 35167158318 passed API/Site/browser stages before being canceled when the final recovery protections superseded it.
- Final source c3ed2e882c90e2e6776c7c88722c029e2b537bb0 adds the photo/busy navigation guard and keeps recovered quantity inputs mounted. Typechecking, scoped lint, the six-case photo-guard browser matrix, and both engine cases for clearing/refilling a recovered quantity passed. Final exact gate: https://github.com/TailoredAgents/StonegateOS/actions/runs/35167640536.
- During implementation, an independent manual Site deployment changed the live baseline from 74c11dca9001cd27280a661ffb03dbd1f484eb26 to main 6f6721a08b37328c43ef79517a1dc5c2d7b6dead (deployment dep-dalj1eqjnfac739oglb0, live at 2026-09-17 00:17:43 UTC). This portal release is a direct child of that current baseline. It does not bundle unrelated local changes or reverse that manual deployment.
- The separate general E2E workflow, https://github.com/TailoredAgents/StonegateOS/actions/runs/35166223675, passed typechecking, lint ratchet, and Quote/Expense PostgreSQL jobs. Its broad API unit step has the same preexisting failure set as run 35108494467: 129 failing suites and 207 unique failure headings, with no additions or removals. Both runs have 330 passing suites / 3,368 passing tests and 61 skipped suites / 269 skipped tests. Comparison evidence: /tmp/stonegate-request-questions-general-e2e-comparison.json; full failed-step log: /tmp/stonegate-request-questions-general-e2e-failed.log.
- Final-commit general E2E https://github.com/TailoredAgents/StonegateOS/actions/runs/35167640517 has that identical failure set and all the same counts; typecheck, lint, and both database jobs passed again. Final comparison: /tmp/stonegate-request-questions-final-general-e2e-comparison.json. No broad API failures were introduced by this UI change.

The final required gate completed successfully at 2026-09-17 00:55:40 UTC on exact c3ed2e88. Counts: API 139 suites / 998 tests; Site 210 tests; focused route regressions 3 suites / 14 tests; browser/config 35 checks; PostgreSQL 41 suites / 223 tests. Worker rendering/import checks made zero network attempts. Both production builds, both fresh-company journeys, and both desktop/phone CRM handoff journeys passed. Full log: /tmp/stonegate-request-questions-required-final.log.

Site deployment dep-daljl83l550s73bgobhg was triggered at 2026-09-17 00:56:00 UTC for that exact SHA, after verifying the successful gate, unchanged live baseline, no competing rollout, and the configured private-media origin. It became live at 00:59:45 UTC with exact c3ed2e882c90e2e6776c7c88722c029e2b537bb0.

## Live verification

- At 01:00:20 UTC, provider-host checks passed for Site/API health, portal availability, database/migrations/worker readiness, protected catalog access, saved-draft sign-in redirection, and restrictive private-photo policy. There were zero dispatchable outbox events.
- At 01:00:21–22 UTC, fresh Chromium with normal certificate verification passed canonical-domain health and sign-in checks. Billing and the saved request redirected normally; the user's original draft ID remained in the sign-in return path. Private-media policy remained limited to the intended image/connect directives.
- No API/Site application errors or portal HTTP 5xx responses appeared in the observed 00:59:45–01:00:38 UTC post-deployment log window.
- Evidence: /tmp/stonegate-request-questions-provider-live.json, /tmp/stonegate-request-questions-canonical.json, and /tmp/stonegate-request-questions-live-logs.json.

Authenticated write journeys ran against production builds with a disposable database. Live checks used normal unauthenticated browsing and read-only requests. No production customer job, upload, or account setting was created or changed for this design update.
