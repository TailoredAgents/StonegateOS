# Pre-Partnership Outreach Plan

> Extend the existing Outbound workspace into a complete, easy-to-use business-development workflow for imported company prospects. Preserve production data, reuse the current communications stack, and do not materially change Mobile.

## Status

| Field                    | Current value                                                                       |
| ------------------------ | ----------------------------------------------------------------------------------- |
| Discovery                | Complete from current `main` on 2026-10-15                                          |
| Existing implementation  | Substantial and already merged into `main`                                          |
| Current route            | `/team/sales/outbound`                                                              |
| Team navigation          | Restored as the only visible Sales workspace; still gated by `outbound.read`        |
| Phase 1                  | Complete locally: guided queue, continue-to-next outcomes, and full CSV guidance    |
| Phase 2                  | Complete locally: active-prospect Inbox and recorded call/SMS/email/reply counts    |
| Focused verification     | 16 outbound suites/170 tests, 44 Inbox tests, and 22 browser checks passing locally |
| Production certification | Controlled smoke test still required                                                |
| Recommended next step    | Verify the complete flow with controlled identities, then refine conversion handoff |

## Business problem

Stonegate has approximately 80 interested business leads from VA outreach, including general contractors, property managers, construction companies, and storage facilities. Creating every company and person manually before outreach is too slow and makes the follow-up process difficult to manage.

The desired workflow is:

```text
CSV of interested businesses
  -> safe preview and deduplication
  -> pre-partnership prospect workspace
  -> one-at-a-time call, SMS, and email outreach
  -> inbound replies in a prospect-scoped Inbox
  -> outcomes, callbacks, ownership, and history
  -> confirmed relationship converted into Partner administration
```

## Key product decision

Do not create a second, disconnected prospect database.

The system should automatically create or match the underlying contact and company records during import because calls, SMS, email, conversation history, Do Not Contact controls, assignment, and later partner conversion already depend on those records. Staff should not have to create those records manually or work them through the normal inbound-lead flow.

Imported records remain isolated operationally by their outbound campaign/source, prospect status, partner account, and outbound tasks. This preserves one identity and conversation history when a prospect becomes a partner.

## What already exists on `main`

| Capability             | Current implementation                                                                                                                                                        | Status                                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Dedicated workspace    | Sales -> Outbound at `/team/sales/outbound`                                                                                                                                   | Implemented and restored to navigation |
| CSV upload or paste    | Upload-first Import contacts view                                                                                                                                             | Implemented                            |
| Import size            | Up to 2 MiB and 2,000 data rows                                                                                                                                               | Implemented                            |
| Supported data         | Company/location IDs, company, contact, phone, email, website/domain, title, per-row industry, status, priority, next action, follow-up, email status, source list, and notes | Implemented                            |
| Safe preview           | Preview -> Review -> one-click import of the accepted rows                                                                                                                    | Implemented                            |
| Deduplication          | Normalized email/phone matching, within-file duplicate clusters, archived/DNC/conflict handling                                                                               | Implemented                            |
| Import safety          | Exact preview hash, idempotency, transaction, advisory/row locks, complete exclusion CSV                                                                                      | Implemented                            |
| Recoverable warnings   | A bad secondary email/phone or follow-up date is ignored with a visible warning when the row still has a usable contact method                                                | Implemented locally                    |
| Automatic setup        | Creates or updates contact, prospect status, partner account link, pipeline row, note, assignment, and outbound task                                                          | Implemented                            |
| Historical carryover   | Prior outreach status, priority, next action, follow-up date, email status, and append-only notes are retained during import                                                  | Implemented locally                    |
| Repeat-import identity | Stable location ID, then stable company ID, then exact company/location matching; public email domains are never company identities                                           | Implemented locally                    |
| Inbound separation     | `outbound:` sources are excluded from normal inbound Sales HQ/new-lead handling                                                                                               | Implemented                            |
| Work queue             | Search, campaign/list, company type, owner, due state, attempt, channel, outcome, and company grouping                                                                        | Implemented                            |
| One-record detail      | Company/contact details, next step, history, tasks, conversation ideas, and actions                                                                                           | Implemented                            |
| Calling                | Uses the existing authenticated Twilio call workflow                                                                                                                          | Implemented                            |
| SMS and email          | Opens or creates the contact's existing shared Inbox thread                                                                                                                   | Implemented                            |
| Incoming replies       | Stored in the shared Inbox; an inbound reply stops open outbound cadence tasks                                                                                                | Implemented                            |
| Prospect Inbox         | Reuses the shared Inbox inside Partner Outreach and limits it to active prospects, campaign/list, company type, and owner                                                     | Implemented locally                    |
| Outreach checks        | Counts recorded outbound calls, sent/delivered SMS and email, and received replies per company                                                                                | Implemented locally                    |
| Call outcomes          | A sufficiently long completed customer call can stop the cadence                                                                                                              | Implemented                            |
| Follow-up outcomes     | Connected, partner, no answer, voicemail, email sent, callback, not interested, and DNC                                                                                       | Implemented                            |
| Partner conversion     | Confirmed partner relationship stops cadence, updates partner/contact state, schedules follow-up, and retains history                                                         | Implemented                            |
| Portal invitation      | Kept separate from relationship confirmation in Partner administration                                                                                                        | Implemented and intentionally separate |

## Gaps relative to the desired experience

1. **Campaign and company-type reporting is operational rather than managerial.** It needs simple totals for imported, attempted, replied, callback, interested, converted, DNC, and not interested.
2. **Channel-wide filtering remains a polish/reporting item.** The dedicated Inbox can already narrow by campaign/list, company type, and owner, while each conversation retains its real channel and complete shared history.
3. **Current production behavior has not been smoke-tested and signed off against controlled call, SMS, email, reply, and conversion identities.** Source and local tests are not enough to claim production readiness.

## Target desktop experience

Keep the existing route and underlying API names to avoid unnecessary risk. Present the feature to staff as **Partner Outreach** with four clear destinations:

1. **Work Queue** — the next company/contact to reach, owner, campaign, available channels, last activity, next action, and outcome.
2. **Prospect Inbox** — only conversations connected to active outbound prospects, with Needs Reply, Waiting, Failed, and All queues.
3. **Import** — CSV template, campaign and owner selection, preview, exclusions, one-click import, and receipt.
4. **Partners** — a contextual handoff to existing Partner administration after confirmation.

The Work Queue should keep the operator in one place:

- Call, open SMS, or open email.
- Show the conversation beside the prospect when practical.
- Record the result and optional recap.
- Schedule a callback in Eastern time.
- Move directly to the next due prospect.
- Clearly block outreach for DNC, deleted, conflicting, or unavailable records.
- Preserve the current company-level history and multi-contact support.

## Delivery phases

### Phase 0 — Controlled production verification

No real lead import occurs in this phase.

- Confirm the Outbound route and permissions for the intended Stonegate users.
- Use three Stonegate-controlled test identities representing phone-only, email-only, and phone-plus-email records.
- Preview the CSV and verify matching, deduplication, company grouping, assignment, and exclusion explanations.
- Import only the controlled identities.
- Verify a controlled call, SMS, email, inbound reply, callback, DNC block, and partner conversion.
- Confirm imported prospects remain out of inbound Sales HQ.
- Record evidence and any production configuration gaps.

Acceptance gate: every controlled workflow is verified without contacting a real prospect, losing history, duplicating identities, or exposing a production-data reset path.

### Phase 1 — Make the existing workspace obvious and fast

Status: **Complete locally on 2026-10-15.** Production deploy and controlled smoke verification remain separate gates.

- Use the staff-facing label **Partner Outreach** while retaining the existing route and API contracts.
- Rename Follow-ups to Work Queue and clarify pre-partnership status language.
- Add a prominent next-due prospect action and next/previous navigation.
- Preserve selected campaign, owner, filters, and return position after an action.
- Expand the CSV template and help text to match all currently supported fields.
- Add an 80-row readiness summary during preview: ready, updates, duplicates, conflicts, invalid, and excluded.

Acceptance gate: an authorized staff member can preview the actual 80-row file, understand every exclusion, and work successive controlled prospects without manually creating contacts.

### Phase 2 — Prospect-scoped Inbox

Status: **Complete locally on 2026-10-15.** Production deploy and controlled smoke verification remain separate gates. Company-type filtering is included; channel-wide filtering can be added with Phase 4 reporting polish without changing the communications path.

- Add an explicit outbound/prospect scope to the existing Inbox read path; do not build a second messaging system.
- Reuse the current Inbox composer, delivery states, media handling, retries, and provider threads.
- Add Needs Reply, Waiting, Failed, and All counts for active prospects.
- Preserve campaign/list, company type, owner, queue filters, selected prospect, and pagination while moving between the Work Queue and Prospect Inbox.
- Show recorded call, SMS, email, and reply counts from the existing communication records; a button click alone never earns a check.
- Embed or closely integrate the selected conversation with the Work Queue.
- Preserve a safe return to the same prospect and queue position.
- Move a confirmed partner out of the active Prospect Inbox while retaining the same underlying conversation history.

Acceptance gate: staff can call, send, receive, reply, and disposition a prospect without losing queue context, while the general Inbox continues to work unchanged.

### Phase 3 — Conversion and partner handoff

- Make the transition from prospect -> contacted -> qualified -> partner clear.
- Keep “relationship confirmed” separate from “portal invitation sent.”
- Reuse the existing partner account and contact link; never duplicate the company during conversion.
- Carry owner, company details, contacts, notes, conversation history, and next action into Partner administration.
- Provide a clear action for portal setup only when the relationship is ready.

Acceptance gate: one controlled prospect can be converted once, appears correctly in Partner administration, and retains its complete outreach history.

### Phase 4 — Management visibility and polish

- Show campaign totals and conversion funnel.
- Show owner workload, overdue callbacks, reply rate, connection rate, and confirmed partnerships.
- Add approved first-touch and follow-up templates without automatic bulk sending.
- Perform desktop and mobile-width visual/accessibility review for this workspace.
- Add a short operating guide for importing and working a new list.

Acceptance gate: the owner can understand the status of the 80-lead effort without opening individual records, and the workspace is ready to demonstrate to another junk-removal company.

## Safety rules

1. Never reset, replace, truncate, or bulk-delete the production database.
2. Previewing a CSV remains read-only.
3. Import requires an exact current preview and an idempotency key; the reviewed rows can then be imported with one click.
4. Do not automatically send bulk SMS, email, calls, invitations, or portal credentials.
5. Keep outreach human-initiated one prospect at a time unless a later, separately approved compliance plan permits automation.
6. Respect DNC and provider delivery state before every external action.
7. Keep imported prospects out of inbound Sales HQ and normal new-lead alerts.
8. Test external communications only with controlled Stonegate-owned identities until production verification is complete.
9. Use supported archival/status transitions for test or rejected records; do not clean them up with raw database deletion.
10. Preserve Mobile behavior. This initiative is desktop-owned unless a shared safety fix is required.

## Recommended defaults for the 80-lead list

- Import campaign/list: a short stable label describing the outreach batch and date. It groups the upload but never determines a company's industry.
- Company type: use the `industry` column on each CSV row (aliases `vertical` and `segment` are also accepted). One file can freely mix contractors, property managers, storage facilities, and other industries.
- Existing outreach: include `status`, `priority`, `next_action`, `follow_up_date`, and `email_status` so previously contacted leads resume at the correct point instead of restarting as new.
- Stable matching: include `company_id` whenever available and `location_id` for chains or multi-location businesses. A location ID wins over company ID so separate Extra Space Storage facilities remain separate accounts.
- Notes: imported notes are appended as auditable contact history and added to account research when they are new; existing notes and conversations are never replaced.
- Domain safety: Gmail, Outlook, Yahoo, iCloud, and other public mailbox domains are ignored as company identifiers. A business domain is only a final fallback when stronger company/location identity is unavailable.
- Historical email status remains visibly labeled as imported history; it does not fabricate a provider delivery receipt or count as a newly sent email.
- Recoverable import issues are warnings, not exclusions: a valid phone can rescue an invalid email, a valid email can rescue an invalid phone, and an invalid follow-up date is retained in import history but not scheduled. Identity conflicts, DNC, true duplicates, and rows with no usable contact method remain blocked.
- Assignment: choose one accountable owner during preview; reassign through supported bulk controls if needed.
- Initial state: new untouched prospects receive an unstarted outbound task; rows carrying prior outreach resume from their imported status and follow-up.
- Cadence: start only after the first real contact attempt.
- Sending: one-at-a-time manual SMS/email/call with a reviewed message.
- Interested response: record Connected or Callback until the relationship is truly confirmed.
- Conversion: use Confirmed partner relationship only after mutual agreement; configure portal access separately.

## Definition of done

This initiative is complete when Stonegate can safely upload the 80-lead CSV, review and import accepted records once, work them one at a time from a dedicated Partner Outreach area, receive and respond to their communications in a prospect-scoped Inbox, track callbacks and outcomes, and convert confirmed relationships into the existing Partner system without duplicate entry or production disruption.
