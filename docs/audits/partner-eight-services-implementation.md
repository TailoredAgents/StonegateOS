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
- [ ] Real database production-build journeys: Chromium/WebKit, desktop/phone, legacy/new mixed records.
- [ ] Visual review: all eight selected, long names, keyboard/zoom, no unnecessary questions or repeated information.
- [ ] Additive migration → compatible API/worker → Site → gated journey → gradual activation → live health/log checks.

## Verification evidence

- Focused regression gate: 1,031 API tests and 234 Site tests passed after the saved-rate correction. The subsequent legacy-catalog correction passed 21 focused tests; the exact release commit must also pass the required CI workflow.
- Complete real PostgreSQL gate: 45 suites, 277 tests passed, with exit 0. Includes all eight rate models, activation, frozen rate versions, manual parent payments/refunds, cross-account guards, repeat work, precise visit ownership, cancellations, and proof/notification lifecycle.
- Browser component gate: 12 tests passed across Chromium/WebKit and desktop/320px layouts (portal selections, photos, pricing, visit editing, and existing inbox recovery).
- API and Site production builds and typechecks passed. Final builds are being repeated after legacy-draft compatibility and local Safari storage transport corrections.
- Additional legacy appointment, payment, refund, and invitation compatibility: 185 tests passed. Staff resource/capacity/mobile action browser checks: four passed.
- The broad repository `pnpm test` command has pre-existing failures: the exact baseline and release comparison both produced 129 failing suites / 207 failing tests, with identical failing names. No new failures remain in that comparison. The focused Partner Portal release gate is separate and must pass.
- Production-build full journey and legacy CRM handoff remain release blockers until the final browser run and required CI pass.

## Design review

Root visually inspected all-eight-selected portal phone layout, desktop timing, CRM pricing, and phone visit scheduling. Service checkboxes remain compact, one service editor opens at a time, and shared contact/access/billing/photos appear once. Pricing and scheduling are separate sections; the client sees rates, while only staff confirms the total. Mobile progress wording was shortened to avoid crowding. Timing copy now explicitly says Stonegate confirms each visit. Optional details remain collapsed. The staff rate editor opens one service at a time and uses correct singular/plural status wording. Mobile notification preferences remain inside their keyboard-accessible horizontal scroll region. The final review screen is captured only after autosave settles.

The review found and corrected three lifecycle gaps: generic CRM status changes could reopen a closed visit, visit cancellations lacked the existing calendar deletion authorization evidence, and refund allocations assumed every bill had a single appointment. Final completion now queues proof generation and client updates only after the whole request is complete. Visit confirmation messages explicitly describe one visit rather than implying the whole project is scheduled.

Older single-service drafts explicitly reload their authorized legacy catalog after draft recovery, preserving historical service choices, tiers, add-ons, and rate visibility when the new flow is enabled. New requests still receive only the eight intended choices.

The disposable local browser environment uses HTTPS for both the website and object storage so WebKit exercises actual photo uploads without mixed-content exceptions or disabled TLS validation. This affects test scripts only.

No production deployment, rate changes, customer work, or external test messages have been performed for this release yet.
