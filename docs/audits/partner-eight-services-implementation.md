# Partner services implementation — 2026-09-21

User approved implementation of eight partner services, multiple service lines in one request, separately scheduled visits, versioned negotiated rates, staff price review, and existing company approval rules. No invented rates or modifications to live customer work.

## Architecture and ownership

- Shared registry and strict request/rate schemas: `packages/pricing/src/partner-services.ts`.
- Account-bound service lines and visits preserve the existing booking as the commercial parent.
- Structured rate drafts, publication, effective dates, and staged company activation share server-side completeness checks.
- The four-step partner wizard uses typed service-specific questions and shared contact, access, billing, and photos.
- CRM projections, scheduling, financial ownership, notifications, and proof use the same parent/line/visit contract.

Parent booking retains commercial identity. Model version 2 starts without an appointment. Actual visits each own an appointment and resource reservations. Service line UUIDs are unique within their parent. Parent `quotedTotalCents`, `finalTotalCents` and `pricingVersion` own financial decisions; visits must not create payment obligations. Legacy appointment financial authority is preserved for model version 1.

New creation uses explicit `PARTNER_MULTI_SERVICE_REQUESTS_ENABLED`; optional `PARTNER_MULTI_SERVICE_ACCOUNT_IDS` narrows rollout. Existing v2 work remains readable if creation is paused. Catalog signals `requestModelVersion:2`. Rates are permission-filtered with `structuredRatesStatus:published|missing|hidden` and a separate structured card. Existing negotiated legacy rows remain intact.

## Required completion checks

- [x] All eight service questions and typed answers roundtrip form → draft → submit → CRM.
- [x] Shared contact/access/billing/photos entered once; deselected answers retained locally but excluded from submission.
- [x] Rate draft/publication/effective dates, precise decimal arithmetic, complete new-company activation; missing rates do not disable existing accounts.
- [x] Staff price review, approval amount guards, one minimum per visit, itemized parent quotes/invoices and no duplicate financial authority.
- [x] Multiple visits, one service over several visits, partial completion/cancellation, resources and travel per visit.
- [x] Templates, recurring, bulk grouping and additional work use the same contract.
- [x] Request queue, jobs, calendar, reports, proof and owner alerts show correct saved service names/details.
- [x] Pricing-review/approval-ready alerts, reminders, retry/duplicate suppression.
- [x] Permission/company isolation and disabled payment attempts.
- [x] Real database production-build journeys: Chromium/WebKit, desktop/phone, legacy/new mixed records.
- [x] Visual review: all eight selected, long names, keyboard/zoom, no unnecessary questions or repeated information.
- [x] Additive migration → compatible API/worker → Site → gated journey → gradual activation → live health/log checks.
- [ ] User confirms all eight choices in a new LandL request through normal live sign-in.

## Verification evidence

- Focused regression gate in CI: 1,137 API tests and 234 Site tests passed, including database-enabled cases. The complete required workflow passed for release commit `550f624cabf46005041a576b0fb91a7f8c397b98`: [GitHub run 35681331366](https://github.com/TailoredAgents/StonegateOS/actions/runs/35681331366).
- Complete real PostgreSQL gate: 45 suites, 278 tests passed, with exit 0. Includes all eight rate models, activation, frozen rate versions, manual parent payments/refunds, cross-account guards, repeat work, precise visit ownership, cancellations, and proof/notification lifecycle.
- Browser component gate: 16 tests passed across Chromium/WebKit, desktop/phone, and effective 200%/400% desktop zoom (eight portal cases, four CRM cases, and four existing inbox recovery cases). Zoom cases select all eight services by keyboard and check layout on both the details and review steps. Three additional SSR-to-browser hydration tests pass, including Eastern-time midnight, noon, and daylight-saving boundaries.
- Final API and Site production builds and typechecks passed. All four complete new-request browser journeys passed with zero client exceptions, and both legacy CRM handoff journeys passed with all submitted details and photos preserved.
- Additional legacy appointment, payment, refund, and invitation compatibility: 185 tests passed. Staff resource/capacity/mobile action browser checks: four passed. Exact seven-suite CI compatibility lane: 41 tests passed; three capacity suites: 102 passed.
- Final CI diagnostics exposed an ambiguous-column commercial-directory query. Explicitly qualified correlated columns now preserve each company's counts and balances. The populated regression includes historical and new request invoices across two companies; the focused database suite passes four tests and related units pass 36. The browser journey now opens the actual billing directory before reviewing a company's invoice lines.
- The broad repository `pnpm test` command has pre-existing failures: the exact baseline and release comparison both produced 129 failing suites / 207 failing tests, with identical failing names. No new failures remain in that comparison. The focused Partner Portal release gate is separate and must pass.
- Local checks and the final exact-commit GitHub workflow are complete. All four new-request journeys and both legacy handoffs passed in CI without skipped cases. Live rollout evidence and the remaining user screen check are recorded below.

## Design review

Root visually inspected all-eight-selected portal phone layout, desktop timing, CRM pricing, and phone visit scheduling. Service checkboxes remain compact, one service editor opens at a time, and shared contact/access/billing/photos appear once. Pricing and scheduling are separate sections; the client sees rates, while only staff confirms the total. Mobile progress wording was shortened to avoid crowding. Timing copy now explicitly says Stonegate confirms each visit. Optional details remain collapsed. The staff rate editor opens one service at a time and uses correct singular/plural status wording. Mobile notification preferences remain inside their keyboard-accessible horizontal scroll region. A long native company selector caused Safari page overflow; its displayed value is now clipped within the control without changing the available choices. The browser checks exercise Safari’s native Option+Tab behavior where needed, rather than assuming identical browser keyboard defaults. The final review screen is captured only after autosave settles.

The review found and corrected three lifecycle gaps: generic CRM status changes could reopen a closed visit, visit cancellations lacked the existing calendar deletion authorization evidence, and refund allocations assumed every bill had a single appointment. Final completion now queues proof generation and client updates only after the whole request is complete. Visit confirmation messages explicitly describe one visit rather than implying the whole project is scheduled.

Older single-service drafts explicitly reload their authorized legacy catalog after draft recovery, preserving historical service choices, tiers, add-ons, and rate visibility when the new flow is enabled. New requests still receive only the eight intended choices.

The disposable local browser environment uses HTTPS for both the website and object storage so WebKit exercises actual photo uploads without weakening application TLS or mixed-content policies. Node trusts only the generated local certificate; the controlled Playwright context accepts that self-signed local endpoint. Production smoke checks retain normal TLS validation. The local transport changes affect test scripts only. A shared date formatter also removes real Safari hydration differences on settings, team access, and job pages; server and browser rendering now use the same timezone and date/time separator.

## Live rollout

- Verified release source: `550f624cabf46005041a576b0fb91a7f8c397b98`, pushed to `main` after the required CI workflow passed.
- Creation was explicitly disabled on API and worker before deployment; the initial cohort was LandL's existing account.
- API deployment `dep-daov7en40ujc738ngp90` became live at 2026-09-22 03:24:26 UTC. Readiness confirms migration `0180_partner_parent_refund_allocation_scope`, database, portal configuration, and worker health. The old API briefly reported its expected migration target during the database-to-API transition; the new deployment resolved that readiness response.
- Worker deployment `dep-daova1f40ujc738np1fg` became live at 03:26:25 UTC.
- Website deployment `dep-daovasugekts73f76370` became live at 03:30:43 UTC. LandL-only activation followed: worker `dep-daovcstg1s2s738r2eh0` at 03:31:53 and API `dep-daovdm80cd8s73b6d9d0` at 03:34:17. Health and readiness passed after activation; the API/Site error-log window had no errors.
- Default activation for all eligible partners followed: worker `dep-daovfk80cd8s73b6k500` became live at 03:37:41 UTC and API `dep-daovg7egekts73f7pqlg` at 03:40:09 UTC. Both run the verified release source with `PARTNER_MULTI_SERVICE_REQUESTS_ENABLED=true` and the optional cohort restriction removed. Existing company restrictions remain effective. Portal reads/writes remain enabled; automatic appointment confirmation and hosted/embedded payment collection remain disabled.
- Final provider-host checks at 03:40:32 UTC passed with normal TLS validation: website/API health and readiness, Partner and staff sign-in pages, protected CRM redirect preserving the destination, and unauthorized service-catalog rejection. API readiness confirms migration `0180_partner_parent_refund_allocation_scope`, database and worker health, and zero dispatchable outbox events. Configuration inspection confirms all three services use the verified release source.
- Final paginated log review exhausted all pages through 03:43:45 UTC. API/Site from 03:34:20: 81/2 application lines, zero application errors, and zero HTTP 500–599 records. Worker from 03:37:45: 38 application lines and 12 healthy heartbeats, latest at 03:43:23. Four pre-existing call-recording `audio_too_short` HTTP 400 failures had matching retry batches. No new Partner Portal errors or unexplained errors appeared in these windows. The earlier pre-release lead-automation SQL failure did not recur; no failed event was replayed. The existing recording retry issue is outside this release, so this does not claim that every worker log is error-free.
- Public-domain TLS requests from the development machine encountered failures consistent with hostname-specific network interference. The provider hostnames passed normal certificate verification, recent hosting logs show public-domain HTTP 200 responses, and the user independently confirmed that the public Partner sign-in page loads normally. No TLS or security settings were weakened.
- User verification of all eight choices in LandL's newly started request remains pending. The user was asked to open Service details without submitting test work. Automated authenticated journeys passed against production builds and a disposable real database; they do not substitute for this final live-account screen check.
- No negotiated rates, existing customer work, or external test messages have been created or changed by this release.
