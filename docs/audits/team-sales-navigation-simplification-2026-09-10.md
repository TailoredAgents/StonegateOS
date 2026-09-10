# Partners-first CRM navigation

## Owner decision

Remove Sales from everyday CRM navigation. Do not replace Pipeline, Sales HQ,
Outbound, or Sales Activity with another dashboard, follow-up list, or
"needs attention" workspace. Partners is the useful retained destination.

This supersedes the navigation recommendations in the preceding Sales audit,
including keeping Outbound as a normal destination. It does not authorize
deleting customer or financial records or changing shared automation.

## Implementation

- `apps/site/src/app/team/surface-registry.ts`: separate normal navigation from
  the historical route registry. Partners is a daily destination; old Sales
  routes retain their permission checks and bookmark compatibility, but are not
  normal navigation or default landing destinations.
- `apps/site/src/app/team/page.tsx`: apply the same navigation policy to modern
  and classic layouts; mark Partners itself active rather than Outbound.
- `apps/site/src/app/mobile/page.tsx` and `mobile/lib/session.ts`: direct,
  permission-aware Partners access using the existing authenticated Team page.
- `PartnerAdministrationSection.tsx`, `PartnerAdministrationNavigation.tsx`,
  `PartnerCompanyNavigation.tsx`, and `partner-company-navigation.ts`: company
  directory and Add partner, followed by company-specific details, people and
  invitations, jobs and service requests, billing and service terms, and
  settings. Rare administration remains in a collapsed section.
- `PartnerRelationshipSetup.tsx`: open the explicitly selected company for
  invitations and configuration; keep deliberate company creation and roles.
- Existing account-directory and service-request reads support exact account
  lookup and company job history. Job history requires an explicit company,
  bounded pagination and its own cursor mode, and retains both staff read
  permissions. Default review-only reads are unchanged.
- `PartnerServiceReviews.tsx` and `PartnerRescheduleReviews.tsx`: fixed-company
  context and stale-response protection; reuse existing job and scheduling
  actions rather than introducing a second scheduler.
- `PartnerAccessEntry.tsx`, Contacts and legacy relationship components: use
  canonical invitation setup instead of old contact-owned login-link forms.
  Preserve relationship and preview context on historical links. Remove the
  ordinary Quotes shortcut back into Sales HQ.

## Preserved boundaries

No production database connection, migration, deployment, email, SMS, payment,
or invitation was performed for this change. No customer, job, quote, message,
financial record, commission rule, or background automation was deleted or
disabled. No MFA was introduced. Legacy API compatibility is not a claim that
historical Sales screens or endpoints have been fully remediated.

## Verification evidence

- Real PostgreSQL service/history integration: seven tests passed against a
  newly created, disposable local PostgreSQL 16 container, with all existing
  170 migration journal entries applied through migration 0172. Includes 102
  jobs, company separation, scheduled/completed/canceled records, complete
  arrival windows, cursor mode/account isolation, unchanged default reviews,
  and exclusion of scope secrets from lists.
- Real PostgreSQL company-directory integration: three tests passed, including
  opening the oldest company beyond a 100-company page, rejecting a cursor
  from a different filter, and never substituting another company for a
  missing ID. These ten database tests used synthetic data only.
- New history route tests cover both required permissions, private responses,
  explicit company forwarding and invalid-input errors.
- Ancillary navigation tests: seven new helper/static-render tests and 59
  focused existing Contacts, Outbound, preview and Pipeline tests passed.
- `pnpm test:partners-workspace`: 15 tests passed (seven helper/static-render
  checks and eight Chromium/WebKit browser/component checks). Tests execute the
  actual Team shell, company navigation, company directory, contacts and setup
  form with mocked authentication/API/action boundaries. Coverage includes
  320/375/768/1024/1440 widths, permissions, active navigation, keyboard drawer
  behavior, company selection, missing/malformed/unavailable accounts,
  cross-company response rejection and no fallback to another company.
- Zero Axe violations on the tested company-navigation views at 320 and 1440
  pixels in Chromium and WebKit. This is not a claim of full-system WCAG or
  manual screen-reader certification.
- Focused final Jest lane: 61 tests passed across registry, staff management
  UI/list contracts, history authorization and Outbound compatibility.
- Existing additional-service component journeys: nine Chromium/WebKit checks
  passed, including original-job association and retry behavior.
- Site/API typechecks and both production builds passed. The Site build
  retained tooling/browser-data warnings and nonfatal local fetch refusals
  during static generation; no live-provider or production smoke evidence is
  inferred from the successful build.
- Touched-file lint passed without errors (existing-style warnings remain in
  partner components); `git diff --check` passed.
- The isolated test container and its temporary synthetic database were removed
  after verification. No existing local or production database was deleted.

Browser screenshots are local temporary artifacts, not production captures:
`/tmp/stonegate-partner-company-navigation-320.png` and
`/tmp/stonegate-partner-company-navigation-1440.png`.

## Release limitations

Local browser fixtures use synthetic accounts and stub external boundaries.
They do not certify live invitations, customer deliveries, Square, production
data, or actual partner usability. Production rollout is a separate step.
