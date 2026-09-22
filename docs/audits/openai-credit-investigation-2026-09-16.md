# OpenAI credit investigation — September 16, 2026

Status: all 16 services in the accessible Render account workspace were audited.
The reported approximately $500 charge has **not** been reconciled to OpenAI
billing or attributed to a service. Two material defects are confirmed: an
unpatched critical Next.js vulnerability on the deployed Stonegate website,
and unlimited recording retries in the outbox worker. The recording defect is
patched locally; the security dependency upgrade remains outstanding.
No production settings, data, deployments, or API keys were changed during
this investigation.

## Reported spending window

The user identified September 15, approximately 8:20 p.m., through September 16,
3 a.m. Assuming America/New_York, the corresponding query interval is
`2026-09-16T00:20:00Z`–`2026-09-16T07:00:00Z`.

The user confirmed the Render workspace associated with the existing
StonegateOS services. Evidence came from Render application/request logs,
production PostgreSQL read-only transactions, and read-only provider queries.
Credentials were consumed in memory and are not included in this report.

## Account-wide coverage

Render returned one accessible workspace, `tea-cvl1h0odl3ps738ecuf0`, which the
user confirmed. Its service inventory, including previews, contained 16
services: 11 active and five suspended. Every service was queried for the
exact interval above. Pagination was exhausted, covering **49,248 distinct
log records**: 7,255 in Virginia and 41,993 in Oregon. Counts include request,
application, and build output, so they are not counts of API calls.

| Service | State | Log records | Exact-window finding |
| --- | --- | ---: | --- |
| stonegate-site | Active | 5,630 | 4,689 requests; extensive scanning; vulnerable Next.js version confirmed; no requests to identified AI endpoints |
| stonegate-api | Active | 818 | Request logs only; no AI execution endpoint activity found |
| stonegate-outbox-worker | Active | 807 | 800 heartbeats, six batches/seven events/zero batch errors, one SEO quota skip |
| stonegate-discord-agent | Active | 0 | No returned logs; proxies the site rather than holding its own OpenAI key |
| stonegate-vm-drops | Active | 0 | No returned logs; current configuration has AI drafting disabled and no OpenAI key |
| stonegate-vm-drops-worker | Active | 0 | No returned logs or configured OpenAI key |
| oakwell-worker | Active | 33,470 | 233 routine jobs; 26 database failures with verbose tracebacks |
| oakwell-api | Active | 6,702 | 1,159 requests, predominantly inbox polling; no AI execution endpoints |
| oakwell-web | Active | 1,122 | Ordinary browsing, crawlers, and deployment diagnostics |
| landl-sourdough | Active | 399 | Neither of its two OpenAI routes was requested |
| landl-bread-club-daily | Active cron | 300 | Six successful hourly runs; all action counters zero; no OpenAI call in the cron implementation |
| stonegate-worker | Suspended | 0 | Suspended since July; separate from the active Stonegate outbox worker |
| stonegate-web | Suspended | 0 | Suspended since July |
| atlanta-freight-os | Suspended | 0 | Suspended since July |
| el-dorado-sb-outreach-agent-web | Suspended | 0 | Suspended since June |
| el-dorado-sb-outreach-agent-worker | Suspended cron | 0 | Suspended since June; still has a distinct OpenAI key configured |

The audit also covered deployment/lifecycle events, scheduled runs, one-off
jobs, paginated environment-variable inventories, environment groups, and
secret-file inventories. No service secret files were returned. No restart,
out-of-memory, or repeated failed-deployment loop was found in the interval.
The complete retained one-off job inventory contained 23 jobs; none of the
17 created before September 15 overlapped the incident window.
Several successful Stonegate/Oakwell deployments occurred. The site's one-off
job at 01:11–01:12 UTC was a partner-route/HTTP-header diagnostic; its command
was inspected as text and did not invoke OpenAI. Known API diagnostic jobs
finished before the spending window.

An empty service log result is a coverage limitation, not proof of zero
execution. Render logs do not provide a complete outbound network ledger.

## Findings

### Critical: the deployed Stonegate site is vulnerable to React2Shell

The site's build/start output confirms **Next.js 15.5.5** across all three
deployments in the interval. Source inspection confirms App Router server
components and Server Actions. The site and API package files also pin
Next.js 15.5.5 and React 19.1.0; only the site's version was independently
confirmed from exact-window production version output.

This combination is affected by the unauthenticated remote-code-execution
vulnerability tracked as CVE-2025-66478 / CVE-2025-55182. Such execution could
access the application's environment secrets, including its OpenAI key.
The vendor recommends upgrading and then rotating application secrets.
[Official Next.js advisory](https://nextjs.org/blog/CVE-2025-66478).

Observed attacks/probes:

- The largest scanner made 3,091 site requests at 01:00–01:05 UTC
  (September 15, 9:00–9:05 p.m. Eastern).
- Secret/configuration/git/PHP path probes returned **no 2xx responses**.
  Successful scanner requests were ordinary public pages or the admin login
  page. Login URLs containing an original probe in a query parameter were
  distinguished from actual successful secret-file responses.
- A suspicious `POST /` at 02:33:56 UTC (10:33:56 p.m. Eastern) returned 404
  alongside `Failed to find Server Action "x"`. Another `POST /` at 02:06:12
  UTC received a www-host redirect.
- The unknown-action 404 **does not prove that malicious decoding failed**.
  In the installed version's Node multipart-action path, payload decoding
  precedes the unknown-action lookup. Render's logs do not include the request
  body or headers needed to determine which path that request took.
- No successful command execution or full credential disclosure was observed
  in the returned logs. That absence cannot establish that exploitation did
  not happen. No exploit was sent during this investigation.

This is a verified vulnerability and a plausible credential-exposure route,
**not a confirmed compromise or attribution of the $500 charge**. The observed
probes also do not account for the first 40 minutes of the reported window.
Admin login redirects do not establish protection against this RSC flaw.

### Stonegate and Sourdough share the same model API credential

In-memory comparisons of the current Render environment values found:

| Distinct model credential | Services holding it |
| --- | --- |
| Stonegate/Sourdough key | stonegate-site, stonegate-api, stonegate-outbox-worker, landl-sourdough |
| Oakwell key | oakwell-api, oakwell-worker |
| Eldorado key | Suspended el-dorado-sb-outreach-agent-worker |

OpenAI Ads credentials and a webhook secret were identified separately and
were not treated as model credentials. No apparent OpenAI secret was found
in a public-prefixed environment variable. The environment group did not
contain another OpenAI model key. Current environment values are not a
historical record of every key/model configured overnight.

Sourdough's deployed commit matches the inspected clean checkout. Its only
OpenAI routes are `/api/chat` and `/api/admin/draft`; neither appeared in its
complete request logs. Its cron does not call OpenAI. A separate scanner at
01:55–01:56 UTC generated 152 redirects followed by 152 final 404s for
secret/debug paths, with no successful secret-file response observed.

If the shared key was copied from any holder, subsequent direct calls to
OpenAI would not need to pass through Render and would not appear in these
services' request logs. The sharing also prevents application attribution
from that key alone.

### Oakwell has a database/logging defect, without evidence of a billable AI loop

Oakwell's worker emitted 26 database failures involving `FOR UPDATE` and a
nullable outer join. Their large tracebacks explain most of its log volume;
the 233 processed jobs were chiefly batch-dialer polling and handoff recovery.
These errors are not evidence of worker restarts or paid OpenAI requests.

Tracebacks printed **52 truncated OpenAI key fragments**, each ending with an
ellipsis. Adjacent-line inspection found no continuation; no complete current
configured key appeared in the inspected logs. The settings object's
`openai_api_key` is a plain string, so exception rendering needs redaction.
This is a logging hygiene defect, not evidence of a usable full-key leak.
Tracked-file scans found no apparent committed model key in the inspected
Stonegate/Wholesale files; this was not an audit of all git history.

### The exact overnight window does not show a large StonegateOS workload

- The outbox worker logged six completed batches covering seven events,
  concentrated around 01:23–01:24 UTC.
- Read-only database queries for the exact window found two Facebook inbound
  events, two message-received events, two Facebook sales evaluations, and one
  contact alert. Zero call recordings completed, and there were no draft,
  suggestion, or recording audit events.
- The SEO check at 03:58 UTC skipped generation with `quota_met`.
- No sales-draft preparation output or OpenAI errors appeared in the worker's
  exact-window logs. Discord worker logs were empty for that interval.
- Across the wider September 15 20:00 UTC–September 16 18:30 UTC interval,
  site/API request logs showed zero public `/api/chat` requests, zero owner/team
  agent requests, and only one junk-quote POST and one inbox suggestion.
  The quote was outside the overnight window, at September 16 18:17 UTC.
- The Stonegate VM Drops services showed build/startup/login traffic, with no
  logged OpenAI activity. Their log searches were also wider than the reported
  window; absence of logs is not proof that no unlogged calls occurred.
- Oakwell's production database also had zero AI runs started/created/completed,
  zero evaluation runs, zero transcripts created/updated, and zero calls created
  during the exact window. Its 1,159 API requests and 233 processed worker jobs
  were chiefly polling/recovery work, with no AI execution endpoints found.
  Oakwell uses a different OpenAI key; whether it shares the billing organization
  was not established.
- The current site, API, and outbox worker configuration sets `OPENAI_MODEL`
  to `gpt-5-mini`; site team chat has a `gpt-5.2` override. These settings alone
  do not establish which model incurred the dashboard charge.
- Local development and E2E configurations route OpenAI through the controlled
  localhost fake. This establishes the current configuration, not every
  historical process environment.

### Recording jobs retry without the normal attempt limit

At approximately September 16 18:35 UTC, the database contained 13 recording
processing events created since September 14 20:00 UTC, with 2,036 recorded
attempts in total. Four September 15 events accumulated 550, 342, 328, and 324
attempts. Four September 16 events were still pending with
`transcription_failed` and 235, 171, 65, and 14 attempts. These counters are
attempts, not confirmed billable requests or dollar amounts.

`call.recording.process` uses a dedicated lease and returns `skipFinalization`,
bypassing the generic outbox retry limit. Its dedicated defer function did not
have a terminal retry limit. Also, a successful transcription was previously
saved only after downstream analysis/coaching completed. A downstream failure
could therefore cause another transcription of the same recording.

Sampled retries returned HTTP 429 with `insufficient_quota` and
`credit_balance_exhausted`. The earliest matching depletion message found in
the September 9 onward worker search was September 15 at 13:36:57 UTC
(9:36:57 a.m. Eastern), before the reported overnight window. Four recordings
subsequently completed around 23:16–23:18 UTC, totaling 194 seconds of audio.
Further depletion failures were present September 16. These observations do
not establish that the account remained continuously empty, and do not explain
the later $500 spike.

### Billing attribution is unavailable with the application credentials

A read-only request to OpenAI's organization costs endpoint returned HTTP 403
for each of the three distinct model credentials: all lack `api.usage.read`.
No monetary total can be calculated
reliably from application logs because the application does not persist model
token usage. The project had no batch jobs; its most recent returned fine-tuning
job was from January 2026, so no recent training job was found.

The remaining attribution input is the OpenAI dashboard's model/project
breakdown for the precise spending interval, or an authorized usage/costs
report. Group usage by model, project, and API key for the interval, including
token totals and request counts. Do not treat retry counts as evidence that
those requests cost $500.

## Prioritized remediation and remaining attribution

### Follow-up: dashboard screenshot and ChatGPT Work

The user supplied a dashboard screenshot and explicitly confirmed that it is
filtered to one specific API key. This is user-reported attribution, not an
independent provider export. The attachment was reduced from 2,940 × 28,472
to 211 × 2,048 pixels. A dominant final spending bar is visible, but the
model names, amounts, axis labels, and filters cannot be read reliably. No
model-level totals or unexpected-model claims were inferred from tiny labels.

The user also confirmed the business partner used Astra in ordinary ChatGPT
on the website, in Work mode. Work can consume ChatGPT workspace credits
under eligible agreements. That does not, by itself, attribute requests to
a Platform project API key. An indirect path remains possible if Work runs
code or invokes a tool/backend that separately calls OpenAI using the key;
there is no evidence yet that this happened. See the official
[Work usage guide](https://learn.chatgpt.com/docs/enterprise/chatgpt-work-usage-and-cost)
and [authentication guide](https://learn.chatgpt.com/docs/auth).

The next evidence needed is a readable usage/cost export with the key ID,
model, time bucket, request count, input/output/cached token totals, and cost
line items. Compare usage at hourly or finer resolution for September 16
00:20–07:00 UTC; do not infer that every panel in a longer-range screenshot
represents activity in that interval. Model snapshots and separate metrics
also must not be counted as independent unexpected models without reading
their labels.

### Actions

1. Upgrade Stonegate's affected site/API dependencies to a currently patched
   release, validate, and deploy. Do not target only the original December
   RCE patch: subsequent security fixes exist, including the vendor's
   [December follow-up advisory](https://nextjs.org/blog/security-update-2025-12-11).
2. Replace and revoke the vulnerable application's credentials, prioritizing the
   shared OpenAI key. Coordinate all four holders to avoid leaving an old key
   active or breaking a dependent service; issue separate credentials per
   application. Patch the vulnerable application before supplying its fresh
   secrets. If unwanted spend continues, revoking the suspect key immediately
   would contain usage but interrupt features still using it.
3. Obtain the OpenAI usage/cost export or dashboard breakdown for attribution.
   No application log analysis can reliably distinguish external use of a
   stolen key from unlogged internal calls without provider-side evidence.
4. Deploy the tested recording retry fix below, and correct Oakwell's locking
   query and settings redaction. Add per-service model usage accounting and
   enforceable application request/token limits.

These are recommendations, not completed production changes. The audit did
not suspend services, revoke keys, run model requests, or deploy fixes.

## Local fix and validation

- Reserve each processing attempt durably before external calls; quarantine
  an event after five attempts. Legacy events already over that threshold stop
  before further provider work.
- Confirmed empty-recording polls return their reservation and retain their
  separate five-observation readiness counter.
- Checkpoint successful transcription immediately under the existing lease;
  reuse it only when the recording SID matches on a later retry.
- Quarantined events remain available for review; they are not marked as
  successfully analyzed.

Files: `apps/api/src/lib/call-recording-persistence.ts`, the recording handler
in `apps/api/src/lib/outbox-processor.ts`, and
`apps/api/src/__tests__/call-recording-persistence.test.ts`.

Validation: 15 targeted tests passed; API typecheck passed. The tests cover
exhausted legacy jobs, crash accounting, stale lease rejection, transcript
checkpoint retention, and readiness polls interleaved with failures.

The limit is per outbox event. An existing duplicate-call callback path can
enqueue another event after quarantine, so this change is not a lifetime
per-call or account-wide dollar limit. Deployment is still required for the
local fix to affect production.
