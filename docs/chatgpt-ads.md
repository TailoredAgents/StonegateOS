# ChatGPT Ads measurement

Stonegate's primary outcomes are confirmed bookings and phone inquiries. The
public website uses the OpenAI Measurement Pixel, and the API queues verified
outcomes for delivery through the Conversions API by the outbox worker.

## Configuration

| Service        | Variable                                 | Purpose                                                                                                   |
| -------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Site           | `NEXT_PUBLIC_OPENAI_ADS_PIXEL_ID`        | Public Pixel ID; requires a site rebuild.                                                                 |
| Site           | `NEXT_PUBLIC_OPENAI_ADS_REQUIRE_CONSENT` | Set `true` to require an affirmative measurement preference; defaults to `false`.                         |
| API and worker | `OPENAI_ADS_PIXEL_ID`                    | Same Pixel ID as the browser.                                                                             |
| API and worker | `OPENAI_ADS_CONVERSIONS_API_KEY`         | Ads Manager Conversions API secret. Store in Render environment settings, never Git or browser variables. |
| API            | `OPENAI_ADS_API_KEY`                     | Separate Advertiser API secret for campaign reporting. Store only on the API server.                     |
| API and worker | `OPENAI_ADS_ENABLED`                     | Set `true` after configuring the conversion credentials.                                                  |
| API and worker | `OPENAI_ADS_PHONE_MIN_DURATION_SECONDS`  | Minimum connected inbound call duration; defaults to 30 seconds.                                          |

Stonegate's Pixel ID is `VzsBYjoVDxBRKqkBtFnsmr`. The Conversions API key is
separate from `OPENAI_API_KEY`, which powers the application's AI features.
The API and outbox worker have matching conversion credentials and
`OPENAI_ADS_ENABLED=true` in production. The Render blueprint preserves that
live configuration. Generic `.env.example` defaults remain disabled until a
new environment has its own credentials configured.

## Events and attribution

- `appointment_scheduled`: a confirmed appointment with a scheduled start time.
  Requests awaiting review, failed bookings, and form starts do not qualify.
- `lead_created`: a qualifying connected inbound phone inquiry. Call-button
  taps use the secondary custom `phone_click` event.
- `page_viewed`: public page measurement; not a primary business conversion.

Booking events use `booking:<appointment UUID>` as both the browser `event_id`
and server event `id`. Phone inquiries use a stable call identifier. The outbox
also deduplicates enqueue operations so repeated callbacks and status updates
do not produce new conversion identities.

The site preserves OpenAI's `oppref` click reference and the Pixel's `__obref`
browser reference with the measurement preference. Attribution follows quote,
lead, and booking records through the existing JSON fields. URL queries,
fragments, and private quote/access paths are excluded from conversion URLs.
Only normalized, SHA-256-hashed contact identifiers are used for server-side
matching; notes, messages, photos, and service addresses are not conversion
payload fields.

The browser assigns a random consent-context ID. Opting out records a durable
revocation on the server, which the worker checks before each delivery. A
delayed booking request cannot reactivate that context. Failed revocation
requests retry on later public visits, and opting back in starts a new context.
Already accepted provider events are not retracted by changing the preference.

Phone measurement currently uses the existing Twilio flow and a recent
consented website record for the caller. A person who calls without such a
record cannot be reliably connected to their browser visit by this integration.
Dedicated tracking numbers or a call-attribution provider are needed to close
that gap. A connected-call duration threshold measures an inquiry proxy, not a
staff determination of lead quality; known voicemail/machine answers are excluded.

Parent call duration alone does not qualify. The installed Studio
configuration below supplies the completed dial leg and its duration. Studio
considers an answering machine or voicemail to be connected, and this existing
forwarding widget does not expose machine detection. Consequently, this setup
cannot exclude an unrecognized voicemail connection that exceeds the threshold.
See [Connect Call To behavior](https://www.twilio.com/docs/studio/widget-library/connect-call).

## Installed Twilio Studio configuration

Production configuration verified on September 15, 2026:

- The business number ending in **2631** routes incoming calls to Studio Flow
  `FWae6ddf7a2fa835025d6aad8d79ec2e8d`.
- Published revision **76** runs `trigger` → `forward_call`, then sends both
  `callCompleted` and `hangup` through the installed inquiry callback steps.
- Revision 76 was built from the previous published production revision **72**.
- `forward_call` records calls and has a 30-second ringing timeout.
- Historical unpublished drafts **73–75** and the revision **72** definition
  were retained separately as recovery backups before activation.
- The number's existing status callback is
  `https://stonegate-api.onrender.com/api/webhooks/twilio/call-status?leg=inbound&mode=inbound`.

Revision 76 passed Twilio Flow Validate (`valid: true`) and was published on
September 15, 2026. The phone number configuration, `forward_call.properties`,
and other Flow fields were preserved. The installed `forward_call.transitions`
are:

```json
[
  { "event": "callCompleted", "next": "record_phone_inquiry" },
  { "event": "hangup", "next": "record_phone_inquiry" }
]
```

The Flow's `states` array already includes these two installed widgets:

```json
[
  {
    "name": "record_phone_inquiry",
    "type": "make-http-request",
    "transitions": [{ "event": "success" }, { "event": "failed", "next": "record_phone_inquiry_retry" }],
    "properties": {
      "method": "POST",
      "url": "https://stonegate-api.onrender.com/api/webhooks/twilio/dial-action?mode=inbound",
      "content_type": "application/x-www-form-urlencoded",
      "add_twilio_auth": false,
      "parameters": [
        { "key": "CallSid", "value": "{{trigger.call.CallSid}}" },
        { "key": "Direction", "value": "{{trigger.call.Direction}}" },
        { "key": "From", "value": "{{trigger.call.From}}" },
        { "key": "To", "value": "{{trigger.call.To}}" },
        { "key": "DialCallSid", "value": "{{widgets.forward_call.DialCallSid}}" },
        { "key": "DialCallStatus", "value": "{{widgets.forward_call.DialCallStatus}}" },
        { "key": "DialCallDuration", "value": "{{widgets.forward_call.DialCallDuration}}" }
      ]
    }
  },
  {
    "name": "record_phone_inquiry_retry",
    "type": "make-http-request",
    "transitions": [{ "event": "success" }, { "event": "failed" }],
    "properties": {
      "method": "POST",
      "url": "https://stonegate-api.onrender.com/api/webhooks/twilio/dial-action?mode=inbound",
      "content_type": "application/x-www-form-urlencoded",
      "add_twilio_auth": false,
      "parameters": [
        { "key": "CallSid", "value": "{{trigger.call.CallSid}}" },
        { "key": "Direction", "value": "{{trigger.call.Direction}}" },
        { "key": "From", "value": "{{trigger.call.From}}" },
        { "key": "To", "value": "{{trigger.call.To}}" },
        { "key": "DialCallSid", "value": "{{widgets.forward_call.DialCallSid}}" },
        { "key": "DialCallStatus", "value": "{{widgets.forward_call.DialCallStatus}}" },
        { "key": "DialCallDuration", "value": "{{widgets.forward_call.DialCallDuration}}" }
      ]
    }
  }
]
```

Both termination paths enter the first HTTP step. A failed request gets one
retry; either success or a second failure ends the Flow. The API's deterministic
`phone:<parent CallSid>` identity prevents a retry from creating another
conversion. The trigger provides the parent call identity and caller, while the
forwarding widget provides the connected leg's outcome and duration. These are
documented [trigger variables](https://www.twilio.com/docs/studio/widget-library/trigger-start)
and [widget fields and transitions](https://www.twilio.com/docs/studio/rest-api/v2/schemas).

The widgets use form encoding, as required by the existing webhook verifier.
Twilio supplies the [request signature](https://www.twilio.com/docs/usage/webhooks/webhooks-security).
`add_twilio_auth` is false because that option is for requests to Twilio APIs.
The endpoint's XML response is an HTTP acknowledgement here; Studio does not
execute it as new TwiML. No `AnsweredBy` or `DialBridged` value is invented.
[HTTP widget reference](https://www.twilio.com/docs/studio/widget-library/http-request).

Live callback verification remains pending. Test eligible calls ended by each
party, a short call, and an unanswered call. Verify Studio's HTTP success and a
single queued conversion for the consenting test caller. Configuration
validation establishes the Flow structure; runtime callback delivery still
requires an eligible call. If the called party hangs up first, the caller
may remain connected while the post-call HTTP steps finish; each HTTP step has a
10-second timeout. Inspect failed executions if both attempts fail.

## Campaign setup

The following live account configuration was verified on September 15, 2026:

- Ad account: `adacct_6aa992efa5688191a9d05019f8d857ff`, Stonegate Junk Removal,
  USD, `America/New_York`.
- Campaign: `cmpn_5d4728af58a4819c8e232579265ba9aa`, Stonegate Junk Removal campaign.
- Source: `cds_6aa9a65875c881918831e5944227e7c2`, using Pixel
  `VzsBYjoVDxBRKqkBtFnsmr`.
- Confirmed Booking: setting `6aa9be0faddc81919c216a390ab27b80`,
  `appointment_scheduled`.
- Phone Inquiry: setting `6aa9be1014e081919178e37f746b9fca`, `lead_created`.

Both settings are attached to the existing active campaign and use a 30-day
click attribution window. Its existing clicks objective, budget, targeting,
and ad creative were retained. A clicks campaign can report conversions;
conversion-optimized bidding is a separate campaign-creation choice. OpenAI
does not allow changing the objective of an existing campaign.

The delivery panel distinguishes booking and phone events. Advertiser Insights
provides the combined attributed conversion total; the documented API does not
expose a booking-versus-phone breakdown for this report. This total counts
actions, not unique customers: an inquiry followed by a booking may count twice.

Add explicit campaign parameters to each ad destination. For example:

```text
https://stonegatejunkremoval.com/book?utm_source=chatgpt&utm_medium=paid&utm_campaign=junk_removal&utm_content=ad_1
```

Keep OpenAI's appended `oppref` intact through redirects. Explicit UTMs let the
first-party Website Analytics dashboard distinguish individual campaigns and
ads. An `oppref` establishes paid ChatGPT traffic; an organic ChatGPT referrer
alone does not.

## Verification and operations

Production verification on September 15, 2026:

- The reporting release is live on the site at `692c0a4c` and API at
  `d28925ea`. The existing outbox worker is at `bffb0c3b`. These releases
  retain the original booking/call tracking implementation from `04d3ed7f`.
- Site and API readiness checks are healthy; the API and worker conversion
  credentials match and server delivery is enabled.
- The browser loaded the OpenAI SDK with HTTP 200 and sent one `page_viewed`
  event accepted with HTTP 202.
- The checked private page did not load the OpenAI Pixel.

Real attributed booking and phone-inquiry verification remains pending. Use
these checks to complete that verification and monitor future changes:

1. With the server environment configured, run
   `pnpm --filter api exec tsx --tsconfig tsconfig.json scripts/validate-openai-ads.mts`.
   This always uses `validate_only: true` to check credentials and payload
   without saving a conversion. It prints only acceptance or a safe error code.
2. Test a successful booking and verify the browser/server event identifiers
   match. Test a rejected or pending booking and verify no booking event fires.
3. Test repeated callbacks and confirmed-status updates for deduplication.
4. Test measurement denial, Global Privacy Control, and Do Not Track.
5. Inspect Marketing → Website analytics and the authenticated
   `/api/admin/openai/ads/status` endpoint for delivery status. The campaign
   performance panel uses `/api/admin/openai/ads/reporting?rangeDays=7` and
   supports 1, 7, 14, or 30 days. It shows spend, impressions, clicks, combined
   attributed conversions, and provider cost per conversion. Both routes require
   `marketing.read` and prevent response caching.
6. Confirm receipt and attribution in Ads Manager. Delivery acceptance is not
   proof of attribution to an eligible ad click; attributed reporting can lag.

Transient delivery failures retry using the existing outbox. Malformed,
permanently rejected, or expired events are quarantined for review. Provider
errors are stored as safe codes without credentials or customer payloads.
Controlled test/audit runtimes and external-send kill switches prevent live
conversion delivery. Public ad scripts are excluded from authenticated CRM,
partner, mobile, and private quote surfaces.

Campaign reporting uses the separate `OPENAI_ADS_API_KEY`. The reporting code
only reads the advertiser account and Insights; it does not change campaign
budgets, bidding, or creative. It shows spend in the account currency, delivery
metrics, and click-attributed conversions for the selected account-local date
period. Results may arrive late or be revised. A missing metric is unavailable,
not zero, and delivery acceptance is separate from attribution. Return on ad
spend is not calculated because these booking/inquiry events do not send sales
revenue.

## References

- [Measurement Pixel](https://developers.openai.com/ads/measurement-pixel)
- [Conversions API](https://developers.openai.com/ads/conversions-api)
- [Supported events](https://developers.openai.com/ads/supported-events)
- [Advertiser API](https://developers.openai.com/ads/api-overview)
- [Campaign conversion setup](https://developers.openai.com/ads/conversion-tracking)
- [Reporting](https://developers.openai.com/ads/reporting)
