# Cookie disclosures and visitor choice — September 15, 2026

The public Privacy Policy now includes a cookies and browser-storage section at
`/privacy#cookies`. A separate cookie-policy URL is not needed for this design.
Public marketing pages offer **Accept optional cookies**, **Reject optional
cookies**, and **Customize**. The footer and policy have a **Cookie settings**
button. Closing the notice leaves optional tracking disabled.

## Consent decision

This is a consistent opt-in design for all public visitors, rather than a finding
that every Georgia visitor is legally required to see an acceptance button.
The site uses Google Ads, Meta Pixel, and OpenAI advertising measurement and has
no verified regional consent boundary. Google requires clear collection
disclosures and consent where law or its policies require it; its regional
policy covers relevant EEA, UK, and Swiss advertising uses. A policy page or
accept-only button would not implement those choices.

Sources checked:

- [Google Ads conversion measurement requirements](https://support.google.com/google-ads/answer/1722022?hl=en)
- [Google EU user consent policy](https://www.google.com/about/company/user-consent-policy/)
- [Google consent-mode implementation guidance](https://developers.google.com/tag-platform/security/guides/consent)
- [ICO storage and access rules, consent, and territorial scope](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-the-pecr-rules/)

## Implementation

- Analytics and Advertising have separate permissions. Missing, malformed,
  expired, or unsupported preference versions deny optional tracking.
- The necessary `sg_cookie_consent` cookie records both choices, policy version,
  and time for 180 days. A local preference record notifies other tabs.
- GPC and DNT override both optional categories. Necessary sign-in, booking,
  security, and preference functions remain available.
- Vendor scripts are absent before consent, including the former Meta noscript
  pixel. Google receives explicit consent-mode settings before configuration.
- Public analytics, conversion helpers, enhanced conversions, and campaign
  attribution honor the current choice. The website lead-intake GA4 server event
  requires explicit Analytics permission supplied at submission.
- Withdrawal notifies loaded SDKs, removes accessible optional cookies/storage,
  drops queued optional events, and invokes existing OpenAI server revocation.
  Already processed provider events cannot be undone by a browser preference.
- Saving does not reload the page or discard an in-progress service request.
- Private quote and scheduling handoffs do not load marketing tags. Operational
  partner telemetry uses transient identifiers without public analytics storage.
- The disclosure distinguishes 30-day campaign attribution from the observed
  one-year OpenAI browser identifier. It names providers and explains advertising
  measurement, matching, personalization, and browser/device-specific choices.

The expected measurement impact is fewer analytics and advertising events:
visitors who do not opt in are no longer measured by the optional integrations.

## Validation

Focused tests are in `apps/site/test/cookie-consent.test.ts`,
`apps/site/test/cookie-tracking.test.ts`, `apps/site/test/openai-ads.test.ts`, and
`scripts/test-cookie-consent.mts`. The browser suite uses the real React
components and local vendor stubs, without sending test conversions to providers.
API consent tests are in `apps/api/src/__tests__/website-analytics-experience.test.ts`.

Validation passed: 18 consent/tracking/OpenAI unit cases, 16 Chromium/WebKit
browser cases, 14 API analytics cases, and the existing partner middleware and
product analytics checks. Site and API TypeScript checks and scoped ESLint
passed. Browser coverage includes missing/rejected/accepted/granular consent,
withdrawal, reload persistence, GPC/DNT, cross-tab synchronization, 320px/1280px
layouts, and homepage/pricing interactions. Screenshots were reviewed locally.

The separate existing public-lead integrity suite could not run because of its
Jest ESM/CommonJS compatibility setup. Its harness was not changed in this work.

Run the browser checks with:

```sh
corepack pnpm exec tsx --test scripts/test-cookie-consent.mts
```

Deployment is a separate step; this document records the repository change.
