# Stonegate agent connections

The customer-operations connector runs in the Stonegate API at `/api/mcp`. It uses MCP Streamable HTTP with a dedicated revocable bearer credential. This release supports the owner's local Codex client; it does not advertise OAuth discovery or universal hosted-client compatibility.

## Owner controls

Open `/team/tools/integrations`, also linked from the existing Agent workspace. An authenticated owner can create a 30-day full customer-operations connection, review immutable proposed actions, approve/reject them, inspect receipts/activity, and revoke a connection. Tokens are shown once and only SHA-256 hashes are stored in PostgreSQL. An inactive/non-owner sponsor, expired grant, revocation or `AGENT_INTEGRATIONS_DISABLED=true` prevents further calls.

Access does not authorize a particular campaign. Routine notes/tasks, pipeline work and campaign preparation execute through the bounded tool catalog. External messages/calls, quote/booking changes, and campaign release/resume/end require an exact action approved by the owner. Approval is tied to the stored payload hash and expires after one hour; the existing campaign review may expire sooner. The agent executes an approved campaign batch without per-recipient prompts. Changes require a new review. A claim already submitted to a provider cannot be recalled by later revocation.

The agent cannot approve its own proposals, write consent evidence, expand permissions, impersonate a human session, query arbitrary SQL, or route to arbitrary URLs. Existing financial, availability, DNC, campaign, provider and outbox controls still apply. Contact merges continue through the attributed human Merge Queue; the connector exposes merge previews rather than pretending its machine identity is a staff session.

## Connecting the desktop workflow

Use the installed project `.codex/config.toml` entry for `stonegate`. The launcher is `apps/api/scripts/stonegate-mcp-stdio.mjs`; it forwards to the live API and reads the token from `~/.local/share/stonegate-agent/credentials.json`. Keep that file outside source control with local-user-only access. Supported shape:

```json
{ "url": "https://stonegate-api.onrender.com/api/mcp", "token": "<private integration token>" }
```

Project MCP configuration is supported for trusted projects; [official Codex setup](https://learn.chatgpt.com/docs/extend/mcp#connect-codex-to-an-mcp-server) also describes restarting the configured server. A running chat may need its MCP server restarted before native tools appear. Do not interrupt an active outreach review merely to restart the application.

The same agent can use the CLI immediately while its native tool list refreshes:

```powershell
node apps/api/scripts/stonegate-agent-client.mjs list
node apps/api/scripts/stonegate-agent-client.mjs call coverage
node apps/api/scripts/stonegate-agent-client.mjs call-file match_contact C:/private/match-input.json
node apps/api/scripts/stonegate-agent-client.mjs recording CALL_UUID C:/private/call.mp3
node apps/api/scripts/stonegate-agent-client.mjs media MESSAGE_UUID 0 C:/private/attachment.jpg
```

Use absolute script paths when running from the Facebook project. `call-file` avoids Windows shell quoting problems. Never print the credential file or put tokens into chat, arguments, checkpoints or Git. The recording download uses the same token, returns only retained recordings, and refuses to overwrite existing local files.

The optional operator bootstrap script `apps/api/scripts/provision-agent-integration.mts` accepts the requested owner email, first name, chosen integration UUID and SHA-256 token hash. Run it only as an authorized operator in the existing API environment after migration `0185`. It uniquely resolves an active owner, refuses conflicting existing grants and records attribution. It does not accept or print the bearer token.

## Available data and matching

- `records`: paginated contacts, conversation threads/messages, calls and transcripts, tasks/notes, properties, appointments, quote totals and line items, consent evidence and conversation identities. The fixed resource allowlist excludes credential tables. `limit`, `offset`, `contactId`, `threadId`, `q`, channel and date filters are available where applicable. Finish all pages before claiming an exhaustive result.
- `match_contact`: normalized phone/email matches and name candidates. A name is never confirmation. Shared numbers, conflicting identifiers and deleted/merged contacts require evidence review; no automatic destructive merge occurs.
- `coverage`: counts, date ranges and invalid timestamps. An empty result is not proof of no contact. Old invalid Messenger dates are flagged, not silently rewritten.
- The explicit catalog adds contact snapshots/memory, inbox details, quote/job/payment history, scheduling and customer-operation actions. `operation_status` and `execute_operation` read or execute immutable receipts owned by the connection.
- Call recording downloads use `/api/mcp/recordings/{callRecordId}` with bearer authentication. Credentials and raw provider recording URLs are not returned in MCP results.
- Message attachments use `/api/mcp/media/{messageId}/{zeroBasedIndex}` with the same bearer authentication and the existing inbox media restrictions.

The November 16 production audit found 3,634 contacts; 7,762 SMS, 6,851 DM, 55 call-channel and 18 email messages; and 3,704 call records, of which 3,661 were linked to contacts and 2,708 had transcripts/recording identifiers. These are a dated coverage observation, not a retention guarantee. Some Messenger timestamps predate 2000 and are invalid history indicators.

The owner's company Gmail mailbox is separately connected in Codex. Use the Stonegate Gmail account alongside MCP to search actual inbox/sent history by matched email/phone/name. The sending provider in Stonegate is Resend; SMTP configuration is not Gmail read access. Do not claim the 18 ingested email messages represent the full mailbox or copy the entire inbox into the CRM unnecessarily.

For Facebook review checkpoints, `node scripts/facebook-outreach-manifest.mjs <folder>` creates a separate deduplicated manifest with input file hashes and all observations. It never overwrites checkpoints or assumes checkpoint IDs are provider identities. It does not import summaries as real messages or activate automations. Historical Twilio/Meta backfill is not run automatically; investigate a specific missing range before importing retained provider data. Unrecorded/deleted calls cannot be recovered by the connector.

## Campaign workflow

For the new **30% exact saved-draft, one-contact workflow**, see [Individual promotional SMS](individual-promotional-sms.md). Existing grants receive its four tools through an explicit owner capability refresh after deployment. The original 40% broadcast workflow below is unchanged.

Use `campaigns_read` to inspect readiness and `campaigns_command` to create/save/review a draft. The `terms.audience` option is `past_customers` (the backward-compatible default) or `customers_and_leads`. Both require verified marketing consent, and exclude DNC, opted-out, deleted, staff/test and duplicate destinations. The established 40% offer, real launch dates, sender readiness, owner test, capacity, maximum 25-recipient batches and final dispatch checks still apply. See [winter-sale runbook](winter-sale-campaign.md).

`message_send` is the existing individual inbox action with exact owner review, not a promotional campaign bypass. Promotional SMS uses campaign eligibility and release. Other channels retain their existing provider restrictions. Deployment leaves all sale/sending flags at their existing values and sends no test or customer message on its own.

Every write needs a stable `requestKey`. Reuse that key after a timeout. A different payload with the same key is rejected. `pending` waits for owner review; `approved` can be executed; `succeeded`/`failed` return stored receipts. `executing`/`uncertain` require reconciliation against application audit/outbox/provider records. Never invent a new key to blindly resend an uncertain action.

## Release and verification

1. Apply additive migration `0185_agent_integrations`; it adds grants, operations and access events without altering existing history.
2. Run API/site typecheck, focused authorization tests and `apps/api/scripts/test-agent-integration.mts` against the isolated local database only. The script refuses any non-local database and tests real MCP discovery, every fixed resource, pagination, matching, audience/DNC rules, actual CRM writes, deduplication, exact approval, expiry and revocation. External sending is disabled.
3. Complete required repository CI and integrate the tested release lineage into main. The prior live code is ahead of the old main branch; do not cherry-pick only this connector onto an older application.
4. Build/deploy the exact intended main revision through the existing Cloudflare website and Render API/outbox release procedure. Preserve form compatibility keys/action IDs and prior immutable assets. Old migration workflow source pins describe a historical baseline, not this release.
5. Verify live revision/readiness, unauthenticated rejection, real local MCP client access, coverage, owner UI and a reversible internal note/task if needed. Do not send production customer messages as verification. Record deployment IDs and proof in a new release receipt.

To contain a problem, revoke the connection or enable the API kill switch first. Preserve operations/audit tables on rollback. Restore only a compatible application artifact; do not restore old authentication semantics or retry uncertain outbound work. API/outbox auto-deploy remains off unless the main build and migration settings are deliberately verified and handed over.
