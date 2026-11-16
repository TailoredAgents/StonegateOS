# Stonegate agent access and main-branch release plan

Status: implementation under validation; main integration and live release pending.
Owner request: November 16, 2026 (America/New_York).

## Outcome and authorization

Give the owner's Facebook Outreach agent full access to Stonegate's customer operations: discover contacts across every available channel, read their history, update records, manage follow-up, and execute authorized sales outreach through the existing system. Deliver the completed implementation on `main` and deploy it to the live services promptly. A read-only connector is an implementation checkpoint, not the final deliverable.

The owner approved implementation and deployment after reviewing this plan. The requested merge/deployment destination remains main; do not stop to reconfirm that destination. This request does not select a campaign audience, establish launch dates, or instruct us to send customer messages today. Connection permission and approval of a particular outbound campaign are separate records.

“Full access” covers all customer/business context and supported customer-operation tools described below. It does not require exposing infrastructure secrets, raw database credentials, password hashes, or an unrestricted SQL/shell tool. Agent permissions must be visible and revocable rather than hidden behind a shared administrator credential.

## Verified starting point

Implementation update: the Facebook workflow is an existing local Codex chat. Austin is the requested integration owner, and the Stonegate Gmail connection for `austin@stonegatejunkremoval.com` is already available on this host. Use Gmail alongside MCP for full mailbox history instead of duplicating it into the CRM. The connector uses SDK 1.32.2, stateless Streamable HTTP, a dedicated bearer grant and a local stdio bridge. The operator runbook is [agent-integrations.md](runbooks/agent-integrations.md).

The production read-only audit found 3,634 contacts; 7,762 SMS, 6,851 DM, 55 call-channel and 18 ingested email messages; and 3,704 calls, with 3,661 linked and 2,708 transcript/recording identifiers. Invalid Messenger timestamps are flagged. A separate checkpoint manifest initially covered 49 files and 1,200 unique source records without modifying the active review. Provider backfill is not launched without a demonstrated missing range. Contact merges retain the existing human-session requirement and are exposed as previews, an explicit capability limit.

Migration 0185, the real SDK/database smoke test, and mobile/desktop owner controls passed locally. The checks cover the expanded campaign audience, DNC, actual CRM writes, duplicate protection, exact owner approval, expiry and revocation. Main integration, live deployment and client installation remain the release steps.

- Repository: `TailoredAgents/StonegateOS`.
- After fetching origin on November 16, `origin/main` is `5a90cf86`; the current release branch and `origin/codex/cloudflare-migration` are `85fc2bb2`. Main has zero unique commits and the release branch has 60 unique commits. Recheck immediately before integration; this is a snapshot, not an assumption for future work.
- The recorded live application revision is `749ebb50`; `85fc2bb2` adds deployment records. The website runs on Cloudflare; API, outbox and PostgreSQL remain on Render. See [release record](operations/2026-11-16-site-campaign-release.md).
- API/outbox automatic deployment is recorded as off because their configured main branch is older. Existing Cloudflare workflows include branch restrictions and historical source pins. Merging alone does not publish the intended application.
- No Stonegate MCP server or MCP SDK dependency was found. Jarvis already has contact search, snapshots, inbox transcripts and other read-tool logic in `apps/site/src/app/api/chat/jarvis-read-tools.ts`.
- SMS, Messenger and email ingestion, contact records, quotes/jobs, and call records exist. Call records support recordings, transcripts and summaries. Actual production retention and completeness have not yet been measured.
- Email webhook support does not establish a complete mailbox import. Facebook ingestion does not establish complete historical Messenger coverage.
- The `Facebook outreach` folder on the desktop contains `campaign.json` and review checkpoints. It does not identify the executable agent host. Its campaign inventory is incomplete; checkpoint records contain name, ID, status, prior25 and summary. Verify the meaning of those IDs before using them as Facebook identifiers.
- Existing campaign mutations and agent approval/execution routes require human principals. An MCP adapter cannot simply call those routes as an external agent. Implement a real delegated action boundary without weakening the current human route checks.
- Winter-sale campaigns currently target completed customers. Older unbooked leads require an explicit additional audience type. Existing consent, opt-out, cooldown, quiet-hour and delivery controls remain authoritative.

## Intended architecture

```text
Facebook review agent
  -> authenticated Stonegate MCP connection
  -> named integration identity + tool permissions + action authorization
  -> shared Stonegate business services
  -> existing database / inbox / jobs / campaign and outbox workers
```

Build the integration inside this repository and deploy it with the existing API, avoiding a separate CRM or duplicated send pipeline. Extract reusable services where logic currently lives in a site route; do not import site implementation into the API or bypass authorization by replaying staff cookies.

Preferred remote surface: authenticated `/api/mcp` on the API, using a pinned official TypeScript SDK and a protocol revision supported by the actual client. Confirm hosting/proxy behavior, streaming, request limits and cancellation. Prefer stateless request handling where supported; do not depend on a process-local session surviving multiple replicas.

First identify the host that owns the desktop Facebook review. If it supports remote MCP, connect directly with its supported authentication flow. If it only supports local MCP, provide a small stdio adapter that calls the same live integration service. The local adapter is a client of the live system, not a second business implementation. Do not claim that placing JSON files in a folder installs tools into an agent.

For interoperable remote authorization, use OAuth resource-server validation and discovery supported by the chosen client. A fixed-client token mechanism may be used only if that client supports it; document that narrower compatibility instead of calling it universal OAuth support. Store local credentials outside the project and customer checkpoint files.

Protocol references: [authorization](https://modelcontextprotocol.io/specification/latest/basic/authorization), [transports](https://modelcontextprotocol.io/specification/latest/basic/transports). Recheck the SDK/client compatibility matrix during implementation rather than assuming the newest protocol works with every client.

## Capability contract

Tool names below are proposed, not already implemented. Create an explicit tool/permission matrix with schemas, pagination, output limits, audit behavior and tests. The default owner-authorized integration should receive the complete customer-operations bundle, not stop at search-only access.

| Area                     | Required capabilities                                                                                                                                                                                                          |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Contacts and identity    | Search/list all contacts including call-only leads; read phone/email/Facebook links, properties, source, tags, consent and DNC; create/update contacts; propose and confirm identity links/merges with evidence                |
| Conversations            | Search/list/read full paginated SMS, Messenger and ingested email threads, inbound/outbound timestamps, delivery states, subject lines and available attachments                                                               |
| Calls                    | Search/list inbound/outbound calls, linked and unlinked numbers, duration/status, available transcripts/summaries and authorized access to retained recordings; initiate an authorized call through the existing call workflow |
| Customer history         | Quotes, estimates, booking status, appointments, completed work, service addresses, notes/tasks, invoices/payment status and customer-specific pricing context                                                                 |
| Sales operations         | Create notes/tasks, update pipeline/follow-up, prepare quotes, use existing availability/booking actions and record outcomes; preserve each operation's existing financial and scheduling rules                                |
| Outreach                 | Draft and send supported channel messages under a valid authorization; create/review/release/pause campaigns; inspect delivery, replies, failures, opt-outs and conversion results                                             |
| Coverage and maintenance | Report available channels/date ranges, missing records and import status; run resumable bounded imports where provider access exists; report integration health and revoke access                                              |

Proposed initial tool groups: `contacts.*`, `history.*`, `conversations.*`, `calls.*`, `sales.*`, `campaigns.*`, `coverage.*`. List every supported operation individually. Inspect the existing API permission catalog for additional relevant customer context and explicitly record any unsupported actions; do not advertise a catch-all tool that silently lacks functionality.

All read responses include canonical record IDs, source/channel, UTC timestamps, available local timezone, provenance links, pagination and explicit missing/truncated indicators. Large transcripts and attachments are retrieved separately with bounded sizes. Recording access should be short-lived and authenticated; provider credentials never enter a tool response.

## Identity matching and Facebook handoff

1. Read checkpoint files without changing the ongoing Facebook agent's work. Use a separate import manifest with file hashes, source record IDs and resumable cursors; deduplicate overlapping checkpoints.
2. Extend the interchange schema to include exact observed phone/email, page-scoped Facebook identity when available, conversation URL, evidence timestamp, source excerpt/reference, review status and uncertainty. Never invent identifiers from a name.
3. Normalize phone numbers using known country context and emails consistently. A shared/recycled number or conflicting identifiers must produce a possible match, not an automatic destructive merge.
4. Use confirmed links and corroborated identifiers for a unified timeline. Name/address similarity supplies review candidates. Keep original provider records and provenance intact.
5. Reconcile Facebook classifications against newer SMS/call/job events. “Moved to phone” is unresolved until the later history supports an outcome. Distinguish quoted, booked, completed, declined, unreachable and unknown.
6. Independently enumerate CRM contacts and calls so people absent from Facebook are included. Surface unlinked calls and duplicates as review work.
7. Write match results to a separate report or database review table. Keep checkpoint conclusions and Stonegate facts distinguishable; do not overwrite historical evidence with an AI conclusion.

## Production data coverage and historical import

Run bounded read-only aggregate queries first. Record per-channel counts, earliest/latest dates, linked/unlinked counts, available recordings/transcripts and retention gaps. Sample a small number of known cross-channel contacts privately to verify chronology. Commit only aggregate evidence without names, phone numbers, message bodies or signed URLs.

Compare provider availability with Stonegate coverage. Implement idempotent imports only for accessible retained Twilio history/recordings, mailbox messages and Meta history. Confirm the actual mailbox provider and permissions before building email backfill. Report inaccessible/deleted history explicitly; do not promise transcription for unrecorded calls.

Historical imports must preserve provider IDs and original timestamps, avoid generating new-lead notifications or auto-replies, avoid reopening old jobs, and never count an import as fresh consent. Use cursor checkpoints, bounded batches, retry/backoff and a pause control. Existing-record access can go live while imports continue; coverage status must make the incomplete history obvious.

## Access, writes and sending

- Add a named `facebook-outreach` integration principal, owner grant, hashed/revocable credential or OAuth binding, permission set, expiry/rotation and last-use metadata. Derive identity server-side; never trust actor headers supplied by an external caller.
- Map granted tools to API-owned permissions. Reuse `permissions.ts`, verified actor context, `team-mutation.ts`, action authority, idempotency and audit infrastructure with explicit non-human support where needed. Do not globally change all human-only routes to accept workers.
- Allow authorized routine CRM updates directly. For external sends, calls, bookings, financial or destructive actions, require the applicable operation authorization. The integration can execute those actions; it does not approve its own authority or impersonate the owner.
- Support one campaign authorization covering the exact reviewed audience, content/terms, allowed channel, expiry, spend/rate/batch limits and follow-up policy. The agent can execute within that authorization without asking about every recipient. Changed terms/audience invalidate the authorization. Keep existing maximum batch size until deliberately revised and tested.
- A full-access grant must not allow the agent to invent consent, remove opt-outs to make someone eligible, or expand its own grant. Owner-authorized consent corrections must retain actual evidence and audit history.
- Retain normalized-number deduplication, DNC/STOP enforcement, quiet hours, cooldowns, capacity checks, final dispatch rechecks, durable outbox and uncertain-send reconciliation. No direct MCP-to-Twilio/SMTP bypass.
- Separate transactional replies, promotional SMS, promotional email and Messenger eligibility. Implement channel-specific controls before exposing promotional send for that channel; SMS eligibility is not transferable to email or Messenger.
- Treat customer messages, attachments and imported summaries as untrusted data. They cannot authorize tools, change integration permissions or redefine the offer.
- Audit reads by actor/tool/record references and writes with operation receipts. Avoid copying entire conversations or credentials into logs. Provide an owner-visible pause/revoke control, integration health and send status.

## Implementation sequence

- [ ] **1. Establish baseline.** Refresh remotes, inspect branch protections/CI, verify deployed revisions and flags, identify the actual Facebook agent host, and produce the aggregate coverage report.
- [ ] **2. Define contracts.** Inventory tools and permissions; specify integration principal, grant/action authorization, audit and additive schema changes. Decide the supported MCP transport/auth combination based on the client.
- [ ] **3. Implement full reads.** Build the live connector and paginated contact/channel/call/customer-history services. Connect the actual agent and verify reads against Stonegate's own UI. This is an intermediate milestone.
- [ ] **4. Match and import.** Add checkpoint interchange, identity reconciliation, call-only discovery and coverage reporting. Start only supported backfills; report gaps without blocking access to existing records.
- [ ] **5. Implement writes and outreach.** Add CRM/task/quote/booking actions, agent campaign draft and delegated execution, older-lead audience support, pause/revoke and delivery reporting. Complete the capability matrix and make any remaining unavailable channel/action explicit.
- [ ] **6. Test and prepare release.** Run the focused checks below plus required repository CI. Build deployable artifacts from committed source. Prepare migrations, endpoint routing and the actual client configuration with credentials kept private.
- [ ] **7. Integrate into main.** Follow the branch procedure below, retaining the public-site/cookie/campaign work and Jeffrey's migration history.
- [ ] **8. Deploy and prove live.** Release from the merged main revision, connect the Facebook agent to production, verify representative reads and safe reversible writes, and record exact revisions/health/rollback. Launching customer outreach remains a distinct campaign operation.

## Main integration and deployment procedure

1. Use an isolated worktree/feature branch from the latest integrated release lineage. Preserve unrelated working changes and re-fetch before merging. Inspect the existing release PR (currently #8) and update or supersede it coherently rather than opening competing overlapping releases.
2. At today's graph, main is an ancestor of the release branch. Integrate that release lineage plus the new feature into main through the repository's permitted PR/merge process. No force-push and no selective cherry-picks that drop migration work. If Jeffrey pushes meanwhile, include and test the new commits before merging.
3. Require passing checks on the final candidate and recheck main's head immediately before merge. Respect actual branch protection requirements; do not invent a new approval step where none exists.
4. Update the release workflows/source pins to build the intended committed main revision. Historical migration scripts must not reapply compatibility patches already present or deploy the November 15 baseline. Pin/validate runtime versions against the actual hosting environment.
5. Apply verified additive database migrations, deploy API/outbox together as required, and deploy the Cloudflare site if routing or integration-management UI changed. Preserve current form compatibility keys/action IDs and immutable assets where the release procedure requires them. Do not move database/providers or finish the unrelated hosting migration as part of this feature.
6. Verify live revision, MCP authentication and authorization, API readiness, worker health and public booking/inbox behavior. Re-enable automatic deployment only if its branch, build and migration settings are verified to release tested main correctly; otherwise document the explicit main release command/workflow.
7. Commit a new release manifest/runbook with current source revisions and deployment IDs. Keep the November 16 record historical. Retain the last compatible application artifacts and all new business records.
8. Roll back the connector with its kill switch/revocation first. For an application rollback, select a compatible prior deployment and leave additive tables and authorization/audit records intact. Never blindly restore older authentication behavior or retry uncertain provider sends.

## Required verification

- Real client compatibility: tool discovery, pagination, reconnect/cancellation, expiry and credential revocation; malformed/unauthenticated calls rejected; correct HTTP/proxy behavior.
- Permission boundaries: forged principal/scope/owner IDs rejected; grants cannot expand themselves; customer content cannot mint approvals; existing human-only routes retain their rules.
- Identity/history: repeated names, conflicting/shared phones, missing email, overlapping checkpoints, unlinked calls, timezone ordering and missing/deleted recordings.
- Import behavior: retry produces no duplicate records or outbound side effects; original timestamps/provider IDs preserved; interrupted import resumes.
- Mutations: operation receipt and idempotency survive retries; concurrent edits detect conflicts; an expired/changed campaign authorization cannot release messages.
- Outreach: synthetic/provider-mocked tests for opt-outs, consent, quiet hours, cooldown, duplicate recipients, new prospect segment, pause/revoke, provider timeout and reconciliation. No production customer texts used as test traffic.
- Run focused API/integration tests, typecheck/lint and required CI; public/partner smoke checks for auth/routing changes. Test the actual final merged artifact, not just an earlier branch SHA.
- Production: privately verify a Facebook-to-SMS/call-to-job example, a call-only contact, and missing-history output. Exercise a reversible internal note/task and inspect audit. Any owner-test message requires a specified owner-controlled destination and send instruction.

## Done means

- The integrated feature and current release lineage are on `main`; the live services run the intended main application revision.
- The actual Facebook agent can use its installed connection to read all available customer channels and history, match identities with evidence, and find non-Facebook contacts.
- The complete agreed capability matrix includes working customer-operation writes and authorized outreach execution, not only read tools. Unsupported provider history is clearly reported rather than silently omitted.
- The owner can inspect granted access, see actions/delivery status, pause outreach and revoke the integration immediately.
- Customer messages still go through the existing audited delivery system, and no campaign was launched merely by deploying the connector.
- A handoff/runbook records connection setup, available tools, data coverage, main/deployment revisions, verification and rollback without secrets or customer data.

Open implementation facts to resolve through inspection: actual agent host and MCP support; production coverage/retention; connected mailbox provider; current provider channel readiness; current branch protection and CI. Launch dates, audience, exact content and send budget are campaign choices, not prerequisites for building and publishing the integration.
