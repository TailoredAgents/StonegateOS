# ChatGPT Ads account connection — September 15, 2026

## Account and campaign verification

The existing local `OPENAI_ADS_API_KEY` authenticated successfully against
`GET /v1/ad_account`. The returned account was **Stonegate Junk Removal**,
`adacct_6aa992efa5688191a9d05019f8d857ff`, active, USD, America/New_York.
No additional key was requested from the user.

The account contained one campaign, **Stonegate Junk Removal campaign**
(`cmpn_5d4728af58a4819c8e232579265ba9aa`). It was active, used clicks bidding,
and had an empty `conversion_event_setting_ids` list. Its existing source
`cds_6aa9a65875c881918831e5944227e7c2` matched the installed Pixel ID
`VzsBYjoVDxBRKqkBtFnsmr`.

## Applied configuration

At approximately 21:52 UTC, created and attached:

| Outcome | Standard event | Setting ID | Click window |
| --- | --- | --- | --- |
| Confirmed Booking | `appointment_scheduled` | `6aa9be0faddc81919c216a390ab27b80` | 30 days |
| Phone Inquiry | `lead_created` | `6aa9be1014e081919178e37f746b9fca` | 30 days |

The update sent only `conversion_event_setting_ids`. A fresh GET confirmed
both IDs, and all other campaign fields except `updated_at` matched the
pre-change snapshot. A subsequent settings listing confirmed both definitions,
their source, and their association with the campaign. The immediate listing
after creation was stale; no duplicate settings were created.

Both approved active ads point to `https://stonegatejunkremoval.com/book`.
Campaign objective, budget, targeting, and ad creative were retained.
The clicks campaign reports conversions. Conversion-optimized bidding would
require a new campaign because the API does not support changing the objective
of an existing campaign.

## Credentials and reporting

Saved and verified `OPENAI_ADS_API_KEY` on the Render API service only using
the single-environment-variable endpoint. No credential values appear in this
report, source control, browser code, or tool output. That environment update
did not trigger a deployment.

Campaign reporting reads the account and Insights through the Advertiser API.
Its UI distinguishes attributed outcomes from first-party delivery counts.
The documented reporting API exposes a combined click-attributed conversion
total; it does not provide separate booking and phone totals for this report.
A caller who later books can contribute two actions to that combined count.
No revenue/ROAS values are invented for these lead events.

## Live measurement check

After the account configuration, a fresh public `/book` browser visit loaded
one Pixel script and received HTTP 202 from OpenAI for `page_viewed`. A fresh
`GET /conversions/events` also returned that `page_viewed` with channel
`pixel_sdk` for the installed Pixel. A fresh staff-login visit loaded no Pixel.
No fake booking, phone inquiry, ad click,
or real outbound phone call was created for this verification.

Real booking/call attribution remains dependent on eligible customer activity
and provider processing. The existing shared-number attribution and voicemail
limitations remain as described in [the integration guide](../chatgpt-ads.md).

## Reporting release checks

- 49 focused API tests passed, including authentication, allowed date ranges,
  unavailable metrics, pagination, safe errors, timeout, and cost-per-conversion
  semantics.
- Eight frontend tests passed for money units, combined conversion display,
  null/zero results, and unavailable states.
- Changed-code ESLint passed and API/site typechecks passed.
- Independent code review found no remaining blocking issues.
- The actual new reporting adapter succeeded against the live Advertiser API
  using GET requests only. The account returned USD, Eastern time, and one
  campaign for September 9–15 inclusive. Delivery metrics and combined
  attributed conversion fields were present; unavailable outcome breakdowns
  and cost per conversion stayed null.

Live deployment details are recorded after the reporting release below.
