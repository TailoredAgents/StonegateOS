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
| API and worker | `OPENAI_ADS_ENABLED`                     | Set `true` after configuring the conversion credentials.                                                  |
| API and worker | `OPENAI_ADS_PHONE_MIN_DURATION_SECONDS`  | Minimum connected inbound call duration; defaults to 30 seconds.                                          |

Stonegate's Pixel ID is `VzsBYjoVDxBRKqkBtFnsmr`. The Conversions API key is
separate from `OPENAI_API_KEY`, which powers the application's AI features.
The Render blueprint leaves server delivery disabled until credentials are
configured. Configure the API and worker consistently before enabling delivery.

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

The existing Twilio configuration must supply connected-call evidence: either
an explicit human answer or a completed bridged dial leg. Parent call duration
alone does not qualify. Signed inbound dial-action callbacks can be sent to
`/api/webhooks/twilio/dial-action?mode=inbound`; inspect the existing TwiML flow
before changing its action URL, since that endpoint controls what happens after
the bridged call ends. The number's ordinary inbound status callback remains
`/api/webhooks/twilio/call-status?mode=inbound&leg=inbound`.

## Campaign setup

In Ads Manager, connect this Pixel/data source to the campaign and select the
desired conversion events. Report bookings and phone inquiries separately so a
caller who later books is not mistaken for two customers. Verify the campaign's
available optimization options before selecting its primary optimization event.

Add explicit campaign parameters to each ad destination. For example:

```text
https://stonegatejunkremoval.com/book?utm_source=chatgpt&utm_medium=paid&utm_campaign=junk_removal&utm_content=ad_1
```

Keep OpenAI's appended `oppref` intact through redirects. Explicit UTMs let the
first-party Website Analytics dashboard distinguish individual campaigns and
ads. An `oppref` establishes paid ChatGPT traffic; an organic ChatGPT referrer
alone does not.

## Verification and operations

1. With the server environment configured, run
   `pnpm --filter api exec tsx --tsconfig tsconfig.json scripts/validate-openai-ads.mts`.
   This always uses `validate_only: true` to check credentials and payload
   without saving a conversion. It prints only acceptance or a safe error code.
2. Test a successful booking and verify the browser/server event identifiers
   match. Test a rejected or pending booking and verify no booking event fires.
3. Test repeated callbacks and confirmed-status updates for deduplication.
4. Test measurement denial, Global Privacy Control, and Do Not Track.
5. Inspect Marketing → Website analytics and the authenticated
   `/api/admin/openai/ads/status` endpoint for delivery status.
6. Confirm receipt and attribution in Ads Manager. Delivery acceptance is not
   proof of attribution to an eligible ad click; attributed reporting can lag.

Transient delivery failures retry using the existing outbox. Malformed,
permanently rejected, or expired events are quarantined for review. Provider
errors are stored as safe codes without credentials or customer payloads.
Controlled test/audit runtimes and external-send kill switches prevent live
conversion delivery. Public ad scripts are excluded from authenticated CRM,
partner, mobile, and private quote surfaces.

Campaign spend, cost per conversion, and return on ad spend require the
separate Advertiser API credentials; conversion delivery credentials alone do
not enable that reporting integration.

## References

- [Measurement Pixel](https://developers.openai.com/ads/measurement-pixel)
- [Conversions API](https://developers.openai.com/ads/conversions-api)
- [Supported events](https://developers.openai.com/ads/supported-events)
- [Advertiser API](https://developers.openai.com/ads/api-overview)
