# Commercial campaign landing page

## Page and scope

URL: https://stonegatejunkremoval.com/contractors

Retarget the existing contractor page to junk removal, demolition, and land
clearing for landlords, property managers, contractors, investors, and
businesses. Use restrained first-person copy. Demolition examples remain light
and selective; land clearing describes brush, overgrowth, and property cleanup.
Project scope, pricing, and scheduling are discussed before work begins.

Calls to the existing (404) 777-2631 number are the primary action. Text messages
to the same number are secondary, with sales@stonegatejunkremoval.com available
as a quieter email option. The page has no estimate form, quote buttons, or chat
widget. A dedicated public layout preserves marketing tags while providing
contact-only header, footer, and mobile bar. Legal and privacy links remain.

Homepage, services, and footer commercial links lead to this page. Canonical,
Open Graph, and Twitter metadata retain the existing URL and describe the three
services. No campaign, budget, ad creative, credential, or phone configuration
was changed by this release.

## Measurement

- Existing OpenAI Pixel, Google, Meta, and first-party page measurement remain.
- Contact links record separate `cta_click` keys: `call`, `text`, and `email`.
  Placement labels identify the header, hero, closing, footer, and mobile bar.
  Message bodies, subjects, and fragments are excluded from href metadata.
- Call taps remain the secondary OpenAI `phone_click` event. Text/email taps
  are website engagement events, not proof that a message was sent.
- Google/Meta page-view helpers now retain navigation history across public
  layout remounts without duplicating the initial SDK page view. Existing
  private/public layout boundaries and provider coverage remain unchanged.
- Confirmed call attribution retains the existing shared-number limitation:
  a recent matching consenting website record is required. This form-free page
  does not collect a visitor's phone number, so first-time inbound calls cannot
  reliably be matched to an individual browser visit. See [tracking guide](../chatgpt-ads.md).

## Validation

- Built from the live website release `b96a50cc`, preserving the intervening
  partner service and scheduling release.
- Production Turbopack build passed, using the frozen dependency lockfile.
  A separate Webpack build attempt flagged an existing unsupported expense
  route export; no unrelated expense code was changed.
- Site TypeScript and changed-code ESLint passed.
- All 10 existing OpenAI browser-helper tests passed.
- Mounted React/Playwright tracking regression passed: initial load, repeated
  render, same-path remount, public layout transition, return navigation,
  private layout unmount, and absent/late SDK callbacks. Run with
  `node --import tsx --test scripts/test-marketing-pageviews.mts`.
- Actual production-built page checked at 1440px, 375px, and 320px: no forms or
  quote links, correct contact destinations, no horizontal overflow, no browser
  errors, and no WCAG 2A/AA or 2.1 AA violations in the focused axe check.
- Local, intercepted contact clicks recorded exactly call/text/email with the
  page and campaign context. No primary booking/call conversion came from taps.
- Actual Next navigation `/contractors` -> `/` -> `/contractors` retained the
  browser document and recorded one Google/Meta page view for each transition.
- Independent source review found no blocking issues. Browser interaction tests
  blocked external delivery and prevented phone, SMS, and mail app activation.

## Live release

- Website service: `srv-d43o7c0dl3ps73a4rb2g`.
- Runtime commit: `bef7beb118e8a23f873a9c21c33aa83da7217a08`.
- Render deployment: `dep-dakt1djl550s73apaqc0`, confirmed live at
  23:16:57 UTC on September 15, 2026 (build/release finished 23:16:19 UTC).
- Final deployment-base check confirmed the existing live `b96a50cc` release
  and no competing deployments before publishing.
- Live `/contractors`, `/book`, `/services`, and `/partners` returned 200.
  Website health and readiness returned 200 with readiness true.
- Live desktop and 375px/320px browser checks passed the same contact,
  no-form, accessibility, overflow, and intercepted-click checks above.
- A separate real, untagged public visit loaded exactly one OpenAI SDK script;
  OpenAI returned 202 for `page_viewed`. A fresh staff-login visit loaded no
  OpenAI Pixel. No real calls, messages, or synthetic lead conversions were sent.
- Review: https://github.com/TailoredAgents/StonegateOS/pull/3.

## Business-card styling

Applied the supplied business card's navy, muted gold, and deep green to this
page only. A responsive white-paper frame has navy outer gutters, fine gold
edges, concave corners, and a reserved navy/green curved strip below the footer.
The hero adds the card's gold line-and-diamond detail. Service cards have gold
outlines and green icons; calls use navy buttons and texts use a gold outline.

The treatment uses scoped CSS and decorative SVG, without adding raster images
or image requests. Gold is used for decoration; readable navy/white text and
green keyboard focus indicators retain contrast. Decorative elements are
noninteractive and hidden from assistive technology. Contact destinations,
content, analytics, privacy links, and the mobile contact bar remain intact.

Desktop (1440px) and mobile (375px/320px) browser checks passed with no overflow,
no focused accessibility violations, and working contact-click measurement.
Independent visual/source review, changed-code lint, and the production
Turbopack build (including TypeScript validation) passed.
