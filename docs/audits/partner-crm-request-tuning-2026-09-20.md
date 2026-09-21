# Easier partner service confirmation

The owner identified choosing the date and confirming service as the awkward part of the opened CRM request. This tuning pass makes each client-requested date selectable, preserves the explicit planned start time, and shows a clear result after the saved request is refreshed.

## Result

The scheduling panel shows date buttons with the client's time preference on a separate line. Selecting a button updates the actual submitted date, highlights the selection, focuses Planned start time, and refreshes the arrival preview. The button's wording deliberately promises only to fill the date. It does not guess a time from “morning” or “afternoon,” claim availability, reserve capacity, or submit the request. Dates requested in another explicit time zone remain visible with instructions for entering the matching Eastern date.

Manual and shortcut edits both mark the request as having unsaved changes. The confirmation button requires a matching successful arrival preview. Schedule controls cannot change during submission. Existing permission, approval, resource, capacity, version, and retry protections remain in the canonical scheduling flow.

After confirmation, the screen reloads the saved request and focuses its scheduling result. Confirmed, in-progress, and completed jobs have distinct headings. The confirmed arrival window appears once prominently, and Open in calendar selects that appointment on its scheduled day. Original scheduling details remain available in an expandable section. Pending or client-approval-blocked work is never described as confirmed.

Supporting details use explicit Call and Email actions, including an email-only contact. Repeated contact-name and PO prefixes were removed from review summaries. Verified empty optional photo/requirement sections take no space, while required or unknown proof values, actual supplied data, permission restrictions, and load errors remain visible. Existing Calendar and Mobile booking-card presentation remains unchanged.

## Validation and rollout

Validation and exact-source release evidence are recorded below. The design work changes Site presentation. During live preflight, suspicious command-execution and credential-file-read errors required a separate framework security patch before deployment. The owner confirmed no known authorized security test and explicitly approved taking the public website, Partner Portal, and CRM offline until patched. Site suspension was accepted at 2026-09-21T00:15:59Z and verified suspended with a 503 response at 00:16:22Z.

The combined release now updates all workspace copies of Next.js to 15.5.24, React/React DOM to 19.1.5, and Sharp to 0.35.4. The lockfile contains no old 15.5.5 or 19.1.0 copies. This follows the [maintained Next.js security release](https://nextjs.org/blog/august-2026-security-release), [RSC advisory](https://nextjs.org/blog/CVE-2025-66478), and [Sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c). API and Site typechecks and synthetic image processing passed; the targeted package audit reports no Next/React/RSC/Sharp findings. Unrelated dependency audit findings are outside this bounded patch.

The suspicious logs are incident evidence, not proof that data was or was not accessed. Patching does not replace credential rotation and incident follow-up. Relevant raw logs were preserved outside the repository in a restricted local file. No credentials or customer access codes are included in this document. API/worker/Site deployment and authorized credential changes are recorded separately below; no additional owner test text is part of this release.

## Exact-source release verification

Source `c50de74bf324e7d7d7f6e41926b8d5625331e195` passed [required release run 35547598182](https://github.com/TailoredAgents/StonegateOS/actions/runs/35547598182) at 2026-09-21T00:37:51Z. All 1,607 counted tests passed: 1,052 API, 227 website, 41 additional address/calendar/team-auth, 44 browser recovery, 239 PostgreSQL, and four production browser journeys. No regression stage failed or was skipped. Both production builds and separate worker import/PDF rendering checks passed. The production journeys cover desktop (1440px) and phone (375px) activation/first-location/first-request workflows, and complete request-field/photo handoff to CRM scheduling.

An earlier UI-only gate correctly caught a confirmed-window mismatch: request detail responses provide the saved window in `partnerRequest.scheduling.confirmedWindow`, while the first fixture incorrectly supplied list-only top-level fields. The final source reads the canonical saved window and tests the actual response shape. No release assertion was weakened.

## Recovery actions and current boundaries

The owner confirmed saving the replacement OpenAI key. It was securely copied to the API and outbox worker using per-key environment updates; readback matched, and a read-only OpenAI authentication check returned HTTP 200. Secret values were never included in chat or repository files. Other environment settings were preserved.

The API entered public maintenance mode at 2026-09-21T00:32:03Z. Database external access was disabled at 00:37:11Z; internal Render connections remained available. Site was resumed at 00:48:23Z solely to permit deployment behind its verified maintenance page. Both its canonical domain and Render domain returned HTTP 503 during that deployment. The automatic build triggered by resume was canceled and replaced with an explicit deployment of the tested SHA with the build cache cleared.

Automatic safety review interrupted broader credential-recovery preparation with the stated reason “Potentially unintended activity.” The owner was informed and then explicitly approved replacing the remaining internal keys and shared database login, restarting their consumers, and verifying the services. Those changes were handled in a separate controlled phase behind public maintenance.

The tested source was pushed to `main` before deployment. API pre-deploy checks confirmed configuration, database compatibility, and migration state; migration 0175 was already applied and no schema or customer-data migration was applied by pre-deploy. Credential changes were performed separately.

## Deployed patch and saved configuration

The clean-cache builds of the tested source became live in this order: outbox worker `dep-dao7rn3m8hqs73dkea2g` at 00:45:50Z, API `dep-dao7rl6k1f9s73b0p53g` at 00:48:47Z, and Site `dep-dao7u0942hec738q2gk0` at 00:53:09Z on September 21. Site serves the public website, Partner Portal, and CRM. Private health checks verified the patched package versions and service readiness while public maintenance remained active.

Saved credential changes were then loaded through configuration deployments using those successful builds. The final live deployments are:

| Service | Deployment | Source | Finished (UTC, September 21) |
| --- | --- | --- | --- |
| API | `dep-dao896ugekts73b98osg` | `c50de74bf324e7d7d7f6e41926b8d5625331e195` | 01:15:04Z |
| Outbox worker | `dep-dao89bf40ujc73ea2j8g` | `c50de74bf324e7d7d7f6e41926b8d5625331e195` | 01:13:58Z |
| Discord worker | `dep-dao89jn40ujc73ea3ke0` | `f1330c15a3542e94eb91abb6dc71d0c59572f7e7` | 01:14:35Z |
| Site | `dep-dao8ad3m8hqs73dm6pm0` | `c50de74bf324e7d7d7f6e41926b8d5625331e195` | 01:16:35Z |

Discord retained its existing Node worker build; it does not run the affected Next.js web server. All four deployment IDs, source revisions, and saved environment inventories were checked. Unrelated environment settings remained unchanged.

Internal API authentication, Site administrator sessions, bot authentication, and the two distinct quote-signing secrets were replaced across their consumers. Partner notification authentication was made explicit on API and worker using the existing API verification material. Permanent private-location and proof-sharing encryption material was preserved. The unused Site `DATABASE_URL` was removed. The new database login was loaded by API, outbox, and Discord; internal TLS, login identity (`session_user`), effective role, schema/sequence permissions, and application-table permissions passed a private read-only probe. Render's new login uses the original owner as its effective role; the check correctly distinguishes that role from the authenticated login.

Private postconfiguration job `job-dao8blbm8hqs73dmbmeg` succeeded at 01:19:01Z, after every configuration deployment had finished. It verified Next 15.5.24, React 19.1.5, Sharp 0.35.4, API readiness, Site configuration readiness, the new database login, and continued public maintenance. Read-only record checks found exactly one LandL request, still `under_review`; owner alerts enabled at revision 2 for the selected phone ending 8806; and exactly one owner test operation with one attempt. No additional customer request, scheduling action, or test text was created.

Application logs for all four services from 01:16:36Z through 01:33:15Z contained no new command-execution/file-read indicators or credential-authentication failures in the reviewed results. Worker processing continued. An existing transcription item repeatedly received `audio_too_short` from OpenAI, and sales-draft preparation logged `request_failed` while the public API was deliberately in maintenance. These known errors are distinct from authentication failures; this release does not claim that all unrelated background tasks are error-free. The queried logs were complete for that interval and preserved in a restricted local evidence file.

## Old database credential retirement

Fresh private drain job `job-dao8oimgekts73basueg` succeeded at 01:46:48Z, confirming the replacement login, required permissions, internal TLS, and zero connections using the old login. Every consumer's saved configuration and exact live deployment were rechecked before removal. The credential endpoint imposed a stricter rate limit than expected; an unavailable readback and a subsequently confirmed HTTP 429 were retained as separate attempts. No ambiguous mutation was automatically repeated. After review, requests were spaced 65 seconds apart and the five-minute drain proof was checked again immediately before dispatch.

The final removal returned HTTP 204 at 01:49:08Z. Although the endpoint documentation listed HTTP 200, subsequent GET readback verified the old credential was absent and the new default remained at 01:50:11Z. The original attempted-response evidence was preserved. [Render's credential-rotation documentation](https://render.com/docs/postgresql-credentials) specifies that retiring the original login revokes its login privilege while retaining its owned database objects. External database access remained disabled.

Post-retirement private job `job-dao8qmugekts73bb4bng` succeeded at 01:51:28Z. A fresh read-only TLS connection authenticated with the replacement login, used the expected effective role, and verified the original role's `pg_roles.rolcanlogin` was explicitly `false`. API readiness and Site configuration remained healthy. The LandL request, selected owner-alert settings, and single owner test operation still matched the unchanged baseline. This directly verified both the retired login's inability to sign in and the new login's continued operation before public restoration.

## Public restoration

The API was restored first and passed public health/readiness checks at 01:52:35Z. The first Site restoration encountered a public HTTPS timeout; the safeguard re-enabled Site maintenance at 01:53:21Z. Normal TLS connection checks then passed on both Site domains, and the same restoration checks passed on retry at 01:55:07Z. The canonical website and Render domain both passed health, complete readiness, and team-login checks. Unauthenticated access to the exact LandL CRM request redirected to sign-in while preserving the complete return path. No owner session was fabricated; authenticated desktop/phone journeys were verified against the controlled production builds in the required release run.

The API, website, Partner Portal, and CRM are online. Saved-key authentication probes also passed: Discord's replacement bot credential was recognized by Site, and the outbox worker's replacement internal credential was recognized by API. Both probes intentionally exercised permission denials before work could execute; they sent no messages and changed no application records. Database external access remains disabled. The permanent location-code and proof-sharing encryption material remains unchanged.

Public health, readiness, login, and the exact protected-request redirect passed again at 01:58:43Z. The complete final log interval from 01:52:35Z through 01:55:56Z contained no new command-execution/file-read indicators or credential-authentication failures. The existing short-audio transcription item continued to fail validation. Three CRM POSTs returned HTTP 404 because the server could not resolve their Server Action identifier at 01:55:13Z and 01:55:19Z; the same client address and browser agent also received HTTP 200 for an intervening CRM GET. A tab retaining an earlier page version is a plausible explanation, not established provenance: the action identifier was absent from the available local build manifests. The owner was asked to refresh/reopen the CRM and report whether the request opens normally. This record does not claim that the post-restoration interval was free of interaction errors.

A redacted completion record and restricted incident evidence were retained outside the repository. The two temporary files containing prepared internal keys and old/new database connection credentials were removed after the completed rotation and restoration were verified. These operational helpers are not intended to be rerun with their completed secret state removed. The evidence still does not establish whether any data was accessed before containment.
