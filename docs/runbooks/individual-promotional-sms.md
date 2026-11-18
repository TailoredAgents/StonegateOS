# Individual approved promotional SMS

Implemented locally November 18, 2026. This uses Stonegate's normal SMS inbox, durable outbox, provider dispatch ledger and owner action approvals. One release accepts one existing contact and one immutable saved draft. No body editing, footer insertion, ordinary-composer workaround or staff impersonation is involved.

## MCP tools

| Tool                      | Input                                                                                              | Result                                                                                                                                                          |
| ------------------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `promotional_sms_drafts`  | `query: {campaignId, contactId?, limit?, offset?}`                                                 | Immutable saved IDs, versions, exact bodies, source references, `nextOffset`. Maximum 100 per page.                                                             |
| `promotional_sms_preview` | `query: {contactId, draftId, version}`                                                             | Destination, configured sender, exact wording, offer, `review`, `reviewExpiresAt`, `eligible`, specific `blockers`, pacing/quiet-hour `deliveryHolds`. No send. |
| `promotional_sms_release` | `body: {contactId, draftId, version, review, reviewExpiresAt}`, plus top-level unique `requestKey` | Pending owner approval first; after approval, at most one queued SMS and its actual contact/thread/message IDs.                                                 |
| `promotional_sms_status`  | `query: {contactId, draftId, version}`                                                             | Original receipt with current delivery/provider/reconciliation state; no send.                                                                                  |

Copy `review` and `reviewExpiresAt` verbatim from the preview; do not reconstruct them or change text. The snapshot expires after ten minutes. It binds the exact sender, destination, saved wording/hash/version, thread, campaign terms/version, consent and qualification version. The release endpoint validates again after acquiring its database locks. A blocked release returns `released: 0` with each blocker, and does not queue a message.

```json
{
  "query": {
    "contactId": "EXACT_CRM_CONTACT_UUID",
    "draftId": "SAVED_DRAFT_UUID",
    "version": 1
  }
}
```

Use this query for preview/status. For release, use the same selection in `body`, add the full returned `review` object and `reviewExpiresAt`, and supply a stable 16–200 character `requestKey`, such as `winter30:<draft-id>:v1`. The first call creates a `pending` operation. Austin approves its exact payload under **Team → Tools → Agent connections**. Repeat the identical release call, or use the existing `execute_operation` with its operation ID. Approval of the connection is not approval of every message.

First successful execution is wrapped as `status: "succeeded"`, `result.status: 200`, `result.body.data`:

```json
{
  "released": 1,
  "replay": false,
  "contactId": "EXACT_CRM_CONTACT_UUID",
  "draftId": "SAVED_DRAFT_UUID",
  "threadId": "NORMAL_SMS_THREAD_UUID",
  "messageId": "OUTBOUND_MESSAGE_UUID",
  "deliveryState": "queued",
  "providerState": null,
  "blocker": null,
  "deliveryHolds": []
}
```

`queued` is not carrier delivery. Read `promotional_sms_status` for `sent`, `delivered`, `failed`, `suppressed` or `reconciliation_required` as recorded by the real worker/callbacks. Repeating the original release returns its operation and a current `delivery` receipt. Reusing a request key with different inputs is rejected. Even a separately approved request key cannot release the same saved draft twice. An accepted-but-uncertain provider submission requires the existing reconciliation workflow before another campaign send; never invent a new key or clone a campaign to bypass that hold.

## Fictional proof

`apps/api/scripts/test-individual-promotional-sms.mts` uses a newly migrated disposable local PostgreSQL database, the real MCP HTTP endpoint, exact owner approval route, actual outbox worker code, signed Twilio callback/inbound routes, and the ordinary staff reply route. All provider calls terminate at a loopback HTTP simulator. Its assertions reject non-local provider traffic and production databases.

Verified November 18:

- One selected draft reached the simulated provider unchanged, without an appended STOP footer.
- Outgoing promotion, incoming customer reply and Jeffrey's normal inbox response shared thread **`215e49db-6fee-406f-9fc6-9569157c9a6e`**.
- Duplicate inbound callbacks and repeated MCP release produced no duplicate messages or sends. Lost MCP completion recovered the original delivery receipt.
- STOP after approval blocked release; STOP after queuing blocked worker delivery.
- An accepted request followed by a lost provider response entered reconciliation; retries did not send again.
- Shared numbers, ambiguous threads, Facebook/named exclusions, service holds, active jobs and rolling 21-day email/call/external activity blocked eligibility. Changing a destination after approval blocked release.
- All 1,318 **fictional** drafts imported atomically after a zero-write draft dry run. Repeat import produced no duplicates. Invalid IDs, duplicate IDs and conflicting 40% copy were reported.
- A private 30% recipient retained 30% pricing while a simultaneous unrelated public campaign retained 40%. Server/customer quote calculations include fees and deposits consistently, with no discount stacking and the same service cutoff.

Full synthetic input/output evidence: local ignored `artifacts/individual-promotional-sms-proof.json`. CI workflow `.github/workflows/individual-promotional-sms.yml` produces the same proof with no production credentials. No real SMS was sent by these tests.

## Prepare and import reviewed drafts

Owner UI: **Team → Marketing → Campaigns → New individual 30% campaign**. Choose actual expiration, final service date, quote retroactivity and no-stacking policy, then save. Individual campaigns cannot use the older batch-release path.

Prepared file shape:

```json
{
  "records": [
    {
      "contactId": "EXACT_CRM_CONTACT_UUID",
      "body": "Exact individually reviewed 30% wording, unchanged.",
      "sourceReference": "Secure reviewed-source reference and file digest"
    }
  ]
}
```

The owner uploads the file, runs the dry run, reviews every issue, then imports that exact report. The server compares its review digest against current CRM/draft/campaign state before committing the entire file. This never creates contacts, resolves by name, clears exclusions, grants consent or sends a message. Maximum 2,000 rows and 1 MiB per request; the 1,318-draft case is tested. Revisions are immutable; old/superseded wording and replacements for already released contacts are held.

API equivalents, with an authenticated owner session and stable `Idempotency-Key`:

- `POST /api/admin/sms-campaigns/drafts`: `{action:"dry_run", campaignId, sourceHash, records}`; review response's `data.reviewHash` and `data.issues`.
- Repeat with `action:"import"` and that `reviewHash`. No import occurs if any row fails or the file/CRM state changed.
- `GET /api/admin/sms-campaigns/drafts?campaignId=...&contactId=...` returns saved draft IDs/versions. Agents have read access through the MCP tool; imports require the owner.

Local source adapter, with absolute private paths:

```powershell
corepack pnpm --filter api exec tsx scripts/prepare-individual-sms-import.mts --drafts C:/private/jeffrey-rewritten-drafts-final.json --scope C:/private/stonegate-owner-consent-attestation-2026-11-18.json --output C:/private/reviewed-drafts-prepared.json
```

This adapter only reads/writes local files. It selects the exact 1,318 UUIDs, preserves the final `draft_body` byte-for-byte, and records source digests. It refuses missing/ambiguous wording and never substitutes `original_draft` or a proposed footer. A blocked source produces a private `.blocked.json` report and exits 2 without producing an import file. A successful source produces the prepared file and manifest; neither imports anything.

**Observed source mismatch:** the November 18 selection contains 1,318 IDs, but the final rewritten source has only 1,278 nonempty drafts for those IDs. Forty are `withheld_pending_review`; older original drafts exist but were not substituted. The owner scope file's `external_evidence_reviewed` is false. Neither selection nor scope attestation is treated as verified consent/history. Resolve the forty held records or explicitly review a smaller scope before live import.

## Evidence and eligibility

The owner can record a reference to evidence retained securely elsewhere without uploading that evidence to Stonegate. History review is distinct from promotional permission:

- **Review a contact's history and exclusions** stores legitimate past customer/inquiry/quote-only qualification, Facebook overlap (`clear`, `excluded`, `uncertain`), explicit service/identity holds, last external activity, secure evidence reference and owner review time/version. No completed job is required.
- **Record existing consent evidence** separately stores granted/revoked marketing permission for the contact's current number, captured date, verified timezone, summary and optional secure external reference. Existing opt-outs and DNC remain effective.
- Qualification API: GET `/api/admin/sms-campaigns/qualification?contactId=...`; owner POST `{contactId,expectedVersion,qualification,facebookStatus,holds,externalLastActivityAt,evidenceReference,reviewedAt}`. Last external activity is an ISO timestamp or null only after confirming none. Refresh external-history review within 24 hours of dispatch. This does not fetch private evidence or claim to have searched a disconnected mailbox.

Every send checks current Stonegate SMS/email/DM messages, linked and normalized phone-matched calls, quote/job activity and the owner's external-activity record against a rolling 21-day cutoff. Recorded FB overlap and CRM DM history hold the CRM-only promotion. Named exclusions are Natasha Larson, Tim Gant and Kim Spratlin. Active/unresolved jobs and explicit service/identity holds remain blocked. Resolve ambiguity in the CRM before approving; do not change identity or phone merely to make a preview pass.

Existing recipient-local 9 a.m.–6 p.m. hours, campaign pacing, capacity, current consent, owner test, sender readiness and global outbound controls still apply. Operational pause/pacing/quiet hours defer delivery; a new recipient blocker suppresses the queued send. The worker repeats eligibility immediately before provider submission. STOP handling remains active without modifying saved outgoing text.

## Release, activation and connector refresh

1. Review the local proof. The owner’s follow-up requests a usable enabled release and authorizes deployment/activation after proof; importing the real list and sending a test/customer message still require specific approval.
2. Integrate the tested revision with current `main` through the existing release process. Run required CI and builds. Apply additive migration `0186_individual_promotional_sms` before deploying API and outbox code; deploy the matching Site UI. Preserve the existing Cloudflare image/action-key/asset compatibility procedure. Do not roll back the new tables, draft/approval history or dispatch evidence.
3. Configure the API **and** outbox consistently: `SMS_CAMPAIGNS_ENABLED=true`, `SMS_CAMPAIGN_SENDS_ENABLED=true`, `WINTER_SALE_ENABLED=true`. Keep normal per-message owner approval and opt-out/reconciliation controls. Verify the actual sender's promotional registration before `SMS_CAMPAIGN_MARKETING_VERIFIED=true`; finish live scoped pricing/booking checks before `SMS_CAMPAIGN_PRICING_VERIFIED=true`. Set the verified interval (at least ten seconds), actual estimated segment rate, and explicitly approved owner-controlled test number. Do not copy fictitious CI provider credentials, rate, phone numbers or verification flags into production.
4. For an existing Austin grant, open **Team → Tools → Agent connections → Enable individual promotional SMS**. This adds only the four new capabilities, retains the token/expiry and records the owner action. New full-access grants include them. Owner API alternative: POST `/api/admin/agent-integrations` with `{action:"enable_individual_sms",id:"EXISTING_INTEGRATION_UUID"}`. Agents cannot expand their own grants.
5. Restart/refresh the outreach assistant's Stonegate MCP connection and call `tools/list`. Existing endpoint remains `https://stonegate-api.onrender.com/api/mcp`; existing stdio bridge and private credential file remain valid. Native tools may require a new agent turn/session. The installed `stonegate-agent-client.mjs list` / `call-file` commands work without changing credentials. Do not paste tokens into the outreach project or chat.
6. Owner reviews/imports the real recipient file and records evidence/holds separately. Complete an explicitly approved real owner test of the campaign terms/sender through the existing campaign control; no provider test was sent by development. Then preview and approve one exact contact's saved draft. Work the reply in its returned normal inbox thread.

The November 18 read-only production check found the configured Stonegate sender **+1 404-777-2631**, no campaigns, and the original campaign/pricing flags off. Promotional-registration verification, pricing verification, interval, segment rate and owner test allowlist were not configured. These are existing launch requirements, not new artificial switches. Read `campaigns_read` again at activation; do not represent the local simulator as real carrier delivery or current provider registration.

Containment uses existing pause/revoke controls while retaining inbound replies and STOP processing. Keep uncertain provider work in reconciliation and retain quoted/accepted financial snapshots.
