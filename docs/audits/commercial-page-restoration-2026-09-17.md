# Commercial page restoration

## Requested version

The user selected the broader commercial page headed “Junk Removal,
Demolition & Land Clearing,” with the flowing navy/gold/green borders and
call/text contact actions. The source is the previously deployed
`5ee640475b487f6ca27ce19d4eaf746dba02f63a` version, including the updated
Monday–Friday 8 AM–6:30 PM, Saturday 8 AM–4:30 PM, Sunday closed hours (Eastern).

## Current release and scope

The live website at the start of this task was
`8c55db33a4a8eecb8b122daf48670d656b80a9ec`. It had replaced the commercial
route and components with the original contractor estimate-form page and
reverted the public business hours. This change starts from that exact live
release and restores the selected route, layout, and branded components.
The duplicate `/contractors` route under the general site layout is removed.

The shared public hours and search-engine opening hours are restored, and the
conflicting old hours statement on the pricing page is removed. Contact
measurement again distinguishes call, text, and email clicks. The Google/Meta
page-view helpers and their existing regression test are restored to support
navigation between the separate public layouts without duplicate initial views.
Current partner, booking, API, and other newer application changes are preserved.

The starting release also lacks the previously deployed OpenAI Ads frontend
integration. That pre-existing issue was reported to the user. This restoration
retains the current marketing-tag configuration; it does not claim to restore
OpenAI attribution or conversion delivery. API deployment state was not inferred
from the website source tree.

## Validation

- Frozen dependency installation and Contentlayer generation passed.
- Production build, including TypeScript validation, and changed-code lint passed.
- The restored marketing page-view regression suite passed all three checks.
- Production-built browser checks at 1440px, 375px, and 320px passed: selected
  headline and hours, no forms/quote prompts, correct call/text/email destinations
  and intercepted events, no overflow, no focused accessibility violations, and
  no page errors. Brand colors, flowing edges, sticky header, and mobile footer
  clearance also passed. Desktop and mobile screenshots were reviewed.
- Independent review verified the restored route/layout and branded components
  are byte-identical to the selected version. Newer partner/API/reporting files
  and the current shared marketing-tag configuration remain unchanged.
