# Partner contact and access — 2026-09-17

## Change

Contact and access now shows a compact contact summary with Change contact, an optional Backup contact disclosure, the existing stairs/elevator/loading-dock choices, and one Arrival instructions field. The primary editor offers explicit Use location contact and Use my details choices when valid and different. Saved location instructions can be copied explicitly. Older crew instructions remain separately editable when present; new requests do not show a second blank instructions box.

Primary contacts require a name and either phone or email. A backup remains optional, but a partially entered backup must include the same essentials. Errors open the relevant disclosures and focus existing field IDs. Done validates only the primary contact, returns keyboard focus to its summary, and does not collapse while someone is typing. Long contact details wrap on small screens.

Location defaults apply once to a new request. Changing the service address preserves the client's chosen contact and arrival instructions. Saved null or blank values remain blank on reload. Choosing a contact replaces all three identity fields together, preventing one person's name from being paired with another person's contact method. All existing draft, request, and CRM field mappings remain unchanged, including separate access and crew instructions.

## Verification

- Local Site typechecking, scoped ESLint, and diff checks passed.
- The Site portal suite passed all 218 tests, including eight new contact selection and validation tests.
- An independent integration review found no regressions in draft restoration, location changes, error routing, or CRM payload preservation.
- All six actual-Wizard browser cases passed across Chromium/WebKit and desktop/phone layouts. Coverage includes keyboard editing and focus, email-only contacts, primary and backup error recovery, whole-person contact choices, changing addresses without overwriting edits, cleared-contact reload, legacy note preservation, photos, scheduling, and exact outgoing data. Log: /tmp/stonegate-partner-contact-access-browser-verified.log.
- Desktop and phone screenshots were visually reviewed in artifacts/partner-contact-access. The browser fixture was corrected to expect the existing explicit empty backup-phone field and to assert the selected address after its picker closes. A keyboard test now waits for the existing step-heading focus before moving focus to the next disclosure; its keyboard assertions remain intact.
- The real CRM journey fixture restores distinct older crew instructions before editing them to the existing final expected value. All existing saved draft, request, photo, staff card, and confirmation assertions remain.

## Release

Source committed and pushed to main: 6eacb0bf1dc9240aec56dc0ac9ea815e57353b11. Only seven relevant source/test files were included; unrelated concurrent workspace changes were excluded.

Required production journey: https://github.com/TailoredAgents/StonegateOS/actions/runs/35273675889.

The separate general E2E run, https://github.com/TailoredAgents/StonegateOS/actions/runs/35273675734, passed application typechecking, the lint ratchet, and Quote/Expense PostgreSQL jobs. Its broad API step retains all 129 previously failing suites and 207 failure headings, plus one nondeterministic failure in an unchanged location-encryption test. Current totals: 130 failing suites / 208 failing tests, 329 passing suites / 3,367 passing tests, and 61 skipped suites / 269 skipped tests.

That extra assertion replaces the last ciphertext character with a literal A. When randomized ciphertext already ends in A, it leaves the ciphertext unchanged and incorrectly expects decryption to fail. Both the test and encryption implementation have identical source blobs in this release and the previous live release; the assertion originated on August 31. A bounded diagnostic using the actual helper ran 1,024 round trips: 13 unchanged replacements decrypted correctly, all 1,011 actually modified replacements were rejected, and guaranteed one-byte tampering was rejected in all 1,024 cases. Independent code review agreed with the diagnosis. No encryption or unrelated test change is included in this UI release. Evidence: /tmp/stonegate-contact-access-general-e2e-comparison.json, /tmp/stonegate-contact-access-general-e2e-failed.log, and /tmp/stonegate-contact-access-encryption-diagnostic.log.

The required production journey passed at the exact source SHA. Counts: 139 API suites / 998 tests; Site 218 tests; three additional API contract suites / 14 tests; browser/configuration 35 checks; 41 PostgreSQL suites / 223 tests. Worker rendering/import checks passed with zero network attempts. Both production builds and all four actual desktop/phone journeys passed: two first-company journeys and two complete CRM handoffs. The exact location-encryption suite also passed in this required run at 20:58:12.186 UTC. Full log: /tmp/stonegate-contact-access-required.log; summary: /tmp/stonegate-contact-access-required-summary.json.

Site deployment dep-dam5dpvcgkoc738ddnlg was triggered at 21:08:55 UTC for exact source 6eacb0bf1dc9240aec56dc0ac9ea815e57353b11 after verifying the successful required gate, unchanged live baseline c3ed2e88, no competing deployment, and the configured private-media origin.

The deployment became live at 21:12:45 UTC with the exact tested source SHA.

## Live verification

- At 21:12:54 UTC, provider-host checks passed for Site/API health, effective portal availability, database/migrations/worker readiness, protected catalog access, saved-draft sign-in redirection, and restrictive private-photo policy. There were zero dispatchable outbox events.
- At 21:12:55–56 UTC, fresh Chromium with normal certificate verification passed canonical-domain health and sign-in checks. Billing and the saved request redirected normally; the user's original draft ID remained in the sign-in return path. Private-media policy stayed limited to its intended image/connect directives.
- No API/Site application errors or portal HTTP 5xx responses appeared in the observed 21:12:45–21:13:12 UTC post-deployment log window.
- Evidence: /tmp/stonegate-contact-access-provider-live.json, /tmp/stonegate-contact-access-canonical.json, and /tmp/stonegate-contact-access-live-logs.json.

Authenticated write journeys used production builds with a disposable database. Live checks used normal unauthenticated browsing and read-only requests. No production customer job, upload, or account setting was created or changed for this update.
