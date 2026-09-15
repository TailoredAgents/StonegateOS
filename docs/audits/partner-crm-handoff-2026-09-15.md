# Partner Portal → CRM request handoff — September 15, 2026

Status: implementation and local production-build browser journeys complete; required CI and deployment checks in progress. No production customer work is created by these checks.

## Required information

The submitted request remains the source of the client's instructions. Staff scheduling adds the confirmed appointment without replacing the original request preferences.

| Client information | Required CRM presentation |
| --- | --- |
| Service and base option | Readable service and option names, with saved keys retained for traceability |
| Description | Complete text with line breaks, visible in the request summary |
| Additional services | Selected service names, quantities and units; prices only for staff with financial access |
| Quantities and handling | Item count, cubic yards, special-handling disclosures, hazard categories, equipment needs and unusual-work flag |
| Completion and stops | Requested completion deadline, location time zone, multiple-stop flag, addresses/site names and sequence |
| Contact and access | On-site and alternate contacts, both phone and email, job access instructions and crew instructions |
| Work order and billing | PO/work order, cost center and project reference; billing contact follows financial permissions |
| Completion evidence | Exact requested before/after counts and completion-report preference, including explicit zero counts |
| Reference photos | Saved images, category, original filename and client caption, reachable through authorized staff access |
| Scheduling | Requested dates, time-of-day preference, assistance preference and any originally requested arrival window; separately labeled confirmed appointment |
| Service address | Submitted location snapshot, including unit/building details; private saved access codes excluded from general card payloads |

## Confirmed gaps and changes

- Detailed fields were saved in partner booking snapshots but not exposed by the appointment/calendar card responses. A shared, validated staff request projection makes those fields available to the review queue, calendar, My Day and staff phone details.
- Slot-based submissions did not preserve every original date/assistance preference separately from scheduling fields. New submissions retain the requested preferences/window for later staff review.
- Selected photos could be discarded when the Service details component unmounted on step navigation. Continue, Back and progress navigation now retain the selection until the client attaches or clears it; unsaved navigation protection includes pending photo work.
- A successful upload followed by a failed attachment read used to clear the photo selection and claim success. The selection, category, caption and retry identity now remain until the exact saved attachments are verified. A failed photo read is represented as unknown, never as zero attachments.
- Invalid replacement files no longer erase a valid pending selection. Preparation errors leave retry available.
- The client's final review now includes handling, equipment, completion deadline, stops, alternate contact, access/crew instructions and both on-site contact methods.
- Error-summary focus occurs after React renders server validation errors, avoiding an observed CI timing failure.
- Photo controls are disabled while a step is advancing, so new selections cannot arrive during the save/validation wait and then be discarded. An expiring old arrival hold also leaves the photo step mounted.
- An intentionally cleared access-instruction field stays empty when the saved draft reloads.
- Structured request details replace the old generated internal review note in calendar, My Day and mobile cards. Human notes remain available, and long note references wrap within phone layouts.
- The complete CI journey exposed an existing desktop-header overflow with long staff names/emails. The identity block now has responsive width limits, truncation and full-text titles; the no-overflow assertion remains unchanged.

## Verification

- Site: 201 unit/parser tests passed; scoped lint and typecheck passed. Generated-note matching covers both unscheduled review requests and held bookings, and preserves every mismatched or edited note.
- Portal Service details: four browser cases passed in Chromium/WebKit at 1440px and 375px, including pending-file navigation, slow validation, invalid replacement files, saved blank access instructions and failed attachment-read recovery.
- CRM presentation: four Chromium/WebKit desktop/phone cases passed, covering field display, finance/photo visibility, keyboard access, empty and malformed responses, retained previews after failed refresh, recovered photos, and canceled/declined wording. Compact desktop and expanded phone screenshots were visually reviewed.
- API: 123 portal suites / 925 tests passed in the full focused lane; the final request formatter suite passed nine cases. Database-dependent tests in that first lane were skipped as designed and exercised separately.
- Real PostgreSQL: seven service-review cases and two manual-confirmation policy cases passed. Five calendar-feed tests passed, including restricted visibility forwarding.
- The existing address, calendar identity and calendar payment-fallback route suites passed all 14 cases. Two mocks now isolate the separately tested request loader; their original address, payment and crew assertions remain intact. These route suites are required in the release workflow.
- Production API and Site builds passed in an isolated copy. The main workspace had an unrelated development server using its Next build directory, so the rehearsal used a separate build directory and dependency tree.
- The complete 1440px and 375px production-build journeys passed: normal invitation/activation and sign-in; every entered field and uploaded photo; saved-draft reload; submission awaiting review; staff confirmation; source-snapshot preservation; actual calendar, company request and mobile cards; preserved human notes; and no horizontal overflow or browser runtime errors. Wrong-company reads and restricted-staff financial/photo access were rejected or redacted as expected.
- The original empty-company desktop/phone journeys also passed after the new handoff checks. Temporary test scheduling profiles and optional service choices were returned to inactive state.
- The live API's existing health and readiness checks returned 200 before release; configuration, portal, database, migrations and worker checks were healthy.

Deployment identifiers will be added after completion. Tests use synthetic accounts, normal staff/partner sign-in, an isolated database and local storage. External delivery remains disabled in the local harness. The harness now explicitly sets its appointment time zone to America/New_York so staff scheduling is covered even without a saved business-hours configuration. Its browser certificate override applies only to the local self-signed HTTPS proxy.

The required Partner Portal workflow includes the CRM presentation checks and the full portal-to-staff-scheduling journey. No schema migration or production account change is required.

The separate general E2E workflow retains the same 129 failing suites as the pre-change revision `691e89ab`: 76 `jest` startup failures, 36 `__dirname` startup failures and 17 other existing failures. Comparing `35022870123` with `35026120367` found no new failing suite or failure signature. The required portal workflow uses the correct runners and separately exercises the affected booking-card routes; this report does not claim the broader general workflow passes.
