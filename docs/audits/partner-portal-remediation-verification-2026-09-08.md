# Partner service remediation: verification and handoff

Date: September 8, 2026. Baseline: `a70006eee418ce03534b3386e38717d0440de0ef`.

This report describes the local implementation worktree, not the deployed product. The [60-finding implementation ledger](./partner-portal-simplicity-audit-2026-09-08.md) remains authoritative for the current work; the historical [99-finding ledger](./partner-portal-audit.md) remains preserved. Production cutover is **not approved** by this report.

## What changed

- Compact password sign-in at `/partners`, consistent Sales help, staff-led company setup and one-use invitations; public applications are retired with explicit old-link compatibility. No MFA requirement was added or restored.
- Job-first Home, permission-aware navigation, four-part service requests, saved-request recovery, complete location lookup and job-specific site/contact snapshots. Enabled relationships can submit a truthful review request without configured pricing or a scheduling profile.
- Shared final scheduling guards, weighted capacity and durable calendar blocks, preferred-date reschedule review, background recurring/bulk processing and staff-controlled optional tools.
- Correctly scoped job photos, recoverable deletion, private PDF quarantine/scanning, background immutable completion records, shared partner/staff threads and committed notification events.
- CRM-owned invoice/payment balances, staff invoice/credit/refund/statement workflows, embedded payment collection, immutable issued records and bounded fixed-snapshot operational/financial reports.

## Executed local checks

Results are from executable tests against local production builds or disposable PostgreSQL 16. Source-contract checks, mocked providers and rendered-browser checks are deliberately distinguished.

| Lane | Actual evidence | Boundary |
| --- | --- | --- |
| API units/contracts | 111 suites / 819 tests passed in the aggregate run; 13 suites / 57 opt-in cases skipped there | The PostgreSQL lane is run separately; a skipped test is not counted as passed |
| Site units/contracts | 165 tests passed after recurring-status and staff-history additions | Some tests inspect source; they are not browser journeys |
| Real PostgreSQL | 31 suites / 145 tests passed against the fresh 168-migration schema | Local SQL/concurrency; external providers are controlled fakes |
| CRM status and payout integrity | 4 suites / 67 tests passed, including ordinary Complete job/status totals and payout integrity | Existing CommonJS harness run in its required mode |
| Commissions, expense and payout calculations | 7 suites / 45 tests passed, including effective-dated management rates and completed-job reconciliation in real PostgreSQL | No production rates or payout records changed |
| Public rendered pages | 4 browser tests passed; Chromium, Firefox and WebKit × five widths × four public pages = 60 Axe scans, zero violations/overflow | Widths 320, 375, 768, 1024, 1440; automated desktop engines, not physical phones |
| Native credential fallback | Actual JavaScript-disabled sign-in submits POST and returns a neutral invalid-credentials outcome | No password in URL; not a complete password-reset/invitation browser certification |
| Signed-in rendered journey | Actual password login for all four roles; account identity, operational-only financial exclusion, disabled portfolio API; Operations searches saved location 105 and submits a review-only job with no fabricated arrival window | Disposable local company; no real service scheduled or external delivery |
| Authenticated accessibility | Ten Axe scans passed: four role-specific Home views, four request steps, submitted job and older-job proof search | Not full authenticated WCAG certification or manual assistive-technology coverage |
| Complete job history | Actual rendered proof search/pagination with more than 100 local jobs; selected older job stays selected across pages; missing job shows an error without another job's media | Additional history rows are explicit local fixtures, not production jobs |
| Resource regression browsers | Chromium/WebKit wrong-job proof and invitation-role component tests passed | Actual React components with synthetic network responses |
| Booking state regression | Actual React draft switch and early browser Back/save harness passed | Online behavior; browser crash/offline durable storage not proven |
| Staff Inbox regression | Actual mobile conversation component passes in Chromium and WebKit, including contactless partner thread and explicit internal-note/reply choice | Not real inbound email/SMS delivery |
| Staff financial history | Five real PostgreSQL/API cases cover 521 documents and 537 refunds with microsecond/equal-timestamp cursors, scope and permission denial; Chromium/WebKit components cover retry, older pages, download, currency and invoice switching | Controlled local records/component network responses; not a production billing journey |
| PDF scan protocol | Five bounded ClamAV protocol-stub tests passed; real PostgreSQL rejects unscanned required proof | No live ClamAV/signature-freshness/EICAR certification |
| Completion records | Real PostgreSQL plus actual PDF and original-media ZIP generation, checksums, immutable snapshot and idempotent replay passed | Private object storage supplied by a controlled in-memory test adapter |
| Schema rehearsal | All 168 migration journal entries through `0170_partner_draft_invoice_line_editing` applied to a fresh local database; migration-file validation passed | Additive local rehearsal only |
| Restore rehearsal | Local PostgreSQL custom-format backup restored into a separate local database; 168 migration records verified | Not a production-sized restore or measured recovery-time commitment |
| Production builds | Final API and Site production builds passed, including billing history and due-date status | Build success does not enable flags or validate providers; build lint is skipped by existing configuration |
| Anonymous HTML | `/partners` appears in the prerender manifest with 3,600-second revalidation; generated HTML is 29,771 bytes with noindex and a native password form | Build artifact/cache evidence, not lab or field Core Web Vitals |

Latest local restore artifact: `/tmp/stonegate-partner-final-170-rehearsal.dump`, SHA-256 `242aa020cabd1c87261c8fa8e1b9425a6f0f0ffe6df1f394a159bc5a40c502df`. It contains the local rehearsal schema, not a production backup. Temporary logs/screenshots are supporting local artifacts; the repository test sources and commands are the reproducible evidence.

## Defects found by executing the implementation

The rendered native form test caught `Origin: null` caused by a tokenless page using a no-referrer policy. Tokenless private forms now retain same-origin referrers; invitation/token handoffs still use no-referrer. Strict CSRF/origin validation was not relaxed.

The actual saved-request POST caught Next.js normalization of local `127.0.0.1` to `localhost`. The proxy/native-form origin helper now validates the configured Site origin against the actual Host; it does not trust arbitrary forwarded hosts, wildcard origins or `null` origins.

Real concurrency review found that a recurring worker could retain a draft after staff disabled its tool. Occurrence-bound draft writes now revalidate current series/tool state under the claim/schedule locks. Pause/cancel cannot overwrite an already accepted job, and a worker cannot revive a skipped occurrence. Recurring history separately projects the current linked job status without rewriting the original processing result.

The proof index now supports server search, cursor history and exact older-job lookup. A missing job never falls back to a different job. The more-than-100-job rendered browser test passed and caught a low-contrast date label that was corrected before its final Axe pass.

The accepted-change-order price now updates the CRM quoted price atomically. A draft invoice must be revised to match before issue; an unpaid invoice can be explicitly voided and replaced after provider obligations are resolved. Finalized/paid work or uncertain collections stop acceptance with `financial_review_required` and Sales help instead of silently changing commission/revenue records. The PostgreSQL tests also exposed an old blanket invoice-line trigger that prevented legitimate draft editing: forward migration 0170 removes only that obsolete trigger after verifying the issued-only immutability guard is active.

Report testing caught a precision mismatch between PostgreSQL creation timestamps and JavaScript's millisecond clock. Report snapshot cutoffs now come from the database with microsecond precision; tests verify that a just-created record is not silently omitted.

Invoice overdue status now derives from the actual due date at read time, including the full New York due day and DST boundaries, without rewriting financial evidence. The shared expression drives partner lists, job summaries, CSV, report filters/snapshots and staff counts. Staff document/refund history no longer silently stops at 500 records: the per-invoice route and controls expose complete, scoped cursor history and retain already-loaded rows on retry.

## Explicit remaining limits and release gates (September 8 snapshot)

The [September 9 continuation](partner-portal-completion-verification-2026-09-09.md) supersedes the named-resource UI, shared read filtering, audited allocation-repair and local scanner/codec/worker-runtime gaps below. Preserve this section as the earlier handoff, not the current state. Paid/finalized additional-work policy and actual release/provider/manual gates remain explicit.

1. No deployment, production database changes, flag changes, real invitations, external messages, charges or 48-hour monitoring occurred. Recheck live account/service/calendar/pricing counts before the approved single cutover.
2. Real Square card/ACH settlement, refunds, webhook disorder, legacy hosted-link retirement, storage/HEIC/expiry behavior, ClamAV, Google/Mapbox and email/SMS/inbound reconciliation still require provider certification with controlled Stonegate-owned accounts and recipients.
3. Screen readers, physical devices, native 200%/400% zoom, full authenticated cross-browser navigation, staff training, three-minute booking and 90% unassisted-user targets remain unmeasured. No lab Core Web Vital or field p75 claim is made.
4. Staff confirmation of work requiring specifically named crew/equipment assignments fails closed where the CRM editor cannot supply those assignments. The missing staff assignment UI must be resolved before offering that configuration; the portal cannot silently substitute generic capacity.
5. Legacy non-partner availability read generators remain separate. Their final writes use the shared conflict guards, but a displayed legacy candidate can still be rejected on submission. Do not claim all-channel candidate-generation parity or production-equivalent race certification from the local final-write checks alone.
6. Autosave/Back recovery is demonstrated online. Offline browser-crash durability, interrupted provider uploads, financial correction/provider recovery and the complete invitation-to-payment staff journey remain distinct release tests.
7. Manual and operational evidence columns stay open in all applicable audit rows. None is silently waived, and no unfinished optional tool should be enabled simply because its page renders.
8. Ambiguous legacy multi-invoice/payment allocations do not have an audited staff repair command in this implementation. They fail closed and require explicitly reconciled migration/repair work before enabling collection for affected jobs. Automatic supplemental invoices for finalized/paid job price changes are also not implemented; those changes remain financial-review cases. These are workflow limits, not merely provider-testing gates.

See the [release and recovery runbook](../runbooks/partner-relationship-service-release.md) for controlled account setup, configuration, incident response, feature containment, migration/restore and the single-cutover gates. Rollback preserves accepted work and money and never restores CRM-contact authorization or MFA requirements.

## Reproduce the rendered local journey

Use the existing migration runner and a disposable local database named `portal_rehearsal`. Do not copy a production database URL into these fixture commands. `seed-partner-service-browser.ts` and `seed-partner-history-browser.ts` reject a non-local/non-test target. All external-send, financial-mutation and outbox-dispatch kill switches must remain enabled on the rehearsal servers.

Run `apps/api/scripts/seed-partner-service-browser.ts` with `NODE_ENV=test`; start the local API/Site production builds at ports 3101/3100 with matching `SITE_URL` and V2 internal test flags. Supply its account ID to `pnpm test:partner-portal:browser-service`. The first journey creates a real local review request. Then run the history fixture for that same account; supply its oldest job ID as `PARTNER_BROWSER_OLDEST_JOB_ID` to additionally test more than 100 jobs, pagination, older proof lookup and missing-job recovery.

Other reproducible commands are in the runbook and root `package.json`. Database suites use `DATABASE_SSL=false`, `DOTENV_CONFIG_PATH=/dev/null` and an explicitly selected disposable local `DATABASE_URL`; no production credentials belong in this document.

## Final-source results

All of these final aggregate runs passed after source freeze:

- `pnpm test:partner-portal:api`: 111 suites, 819 passed; 13 suites/57 cases intentionally skipped in this non-database lane. Log: `/tmp/stonegate-partner-api-final6.log`.
- `pnpm test:partner-portal:site`: 165 passed. Log: `/tmp/stonegate-partner-site-final7.log`.
- `pnpm test:partner-portal:postgres` against disposable `portal_full_final`: 31 suites, 145 passed, zero skips. Log: `/tmp/stonegate-partner-postgres-final5.log`.
- `pnpm --filter api build` and `pnpm --filter site build`: passed. Logs: `/tmp/stonegate-partner-api-build-final3.log` and `/tmp/stonegate-partner-site-build-final7.log`.
- API typecheck and Site `tsconfig.typecheck.json` check: passed after the final history changes.
- Public browser matrix: 4 passed and 60 zero-violation Axe scans. Log: `/tmp/stonegate-partner-public-browser-final3.log`.
- Actual four-role local login/service/history journey: passed, including 105 saved locations, more than 100 jobs and 10 additional zero-violation Axe scans. Log: `/tmp/stonegate-partner-real-browser15.log`.
- Actual resource and staff component browser suites: 2 resource cases, 2 staff Inbox cases and 2 staff billing history cases passed in Chromium/WebKit. Logs: `/tmp/stonegate-partner-resource-browser-final2.log`, `/tmp/stonegate-partner-inbox-browser-final2.log`, `/tmp/stonegate-partner-billing-browser-final.log`.
- Actual draft/Back component harness: passed. Log: `/tmp/stonegate-partner-booking-browser-final.log`.
- CRM completion/payout integrity: 4 suites/67 passed. Commission/expense calculations and real PostgreSQL reconciliation: 7 suites/45 passed. Logs: `/tmp/stonegate-partner-crm-final.log`, `/tmp/stonegate-partner-commission-final.log`. Financial provider tests use fakes; no live Square payment occurred.
- Migration file validation: 168 entries, zero exclusions. A fresh application and separate restored schema both include migration 0170. Log: `/tmp/stonegate-partner-migration-170-final.log`.
- `git diff --check`: passed. All 60 current finding IDs have exactly one ledger row; no finding is silently omitted.

Earlier failed runs exposed the defects described above and triggered corrections. One repeated local browser run correctly hit the five-login-per-15-minute identity limit; its rerun used a newly seeded disposable account, not relaxed authentication limits. The intentionally classified accepted-price metadata writer was added to the exhaustive scheduling inventory with a regression forbidding schedule/finalized-revenue fields.

Build output retains existing incremental-project-reference and outdated browser-data warnings; these are not evidence of a failed build, nor a claim that dependencies were upgraded. No production smoke, provider certification, physical-device/screen-reader validation, usability timing, deployment or monitoring result is asserted.
