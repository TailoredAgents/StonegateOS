# Team inbox simplification

## Result

The inbox is organized around choosing a customer, reading messages, and replying. Desktop uses a 300px list and a separate conversation pane. Each scrolls independently; the composer stays at the bottom. Phones show the list or conversation with Back navigation.

- Removed the New Lead banner and its feed request from `/team`. Lead records and APIs remain available.
- Removed routine thread status badges, Waiting/Done controls, queue tiles, the duplicate Inbox heading, and the large AI/workflow panels. Stored thread states are unchanged.
- Default is all conversations ordered by recent activity. Useful queue/source/date filters live in a closed panel; active counts and Clear filters expose applied selections.
- Search and filters retain the selected conversation. Applying them resets list pagination. Legacy Waiting/Closed links normalize to All without discarding search, dates, or selection.
- Call, Create quote, Book, and Customer details remain close to the customer name. Customer details load on demand. Appointments, addresses, quotes, notes, reminders, media analysis, and automation information stay in closed sections. Reschedule appears with an existing appointment.
- AI offers Draft a reply / View draft. Adding generated text appends to the correct saved reply; it never sends or replaces existing text. Cross-channel suggestions confirm the target customer before insertion.
- Provider diagnostics, access information, theme controls, and Classic layout are reached from the account/settings menu. Optional navigation groups start collapsed only when no preference exists.

## Reliability boundaries

### Reading

`inbox-loader.ts` owns the essential reads independently of the visual layout. A customer/channel link resolves its thread before fetching its strict message page. Explicit thread IDs are authoritative; a failed explicit read never falls back to another conversation. Customer/channel resolution rejects mismatched customer, channel, or partner data.

The existing message endpoint and completeness/pagination contract are unchanged. Malformed responses, permission errors, expired pages, and verified empty conversations remain distinct. Retry messages keeps context and drafts; Latest messages removes an invalid or historical page cursor. Optional provider, customer, directory, and automation reads do not participate in the server message-loading barrier.

`InboxAutoScroll` changes only message-pane scrollTop and stores per-employee/conversation/channel/page reading positions. New activity does not scroll someone away from the position they are reading. List positions survive conversation navigation.

### Drafts and sending

`InboxComposerClient` uses employee/conversation/channel/partner-audience scoped draft state. Text and subject save during editing to session storage, with an in-memory fallback. File objects remain in memory during inbox navigation. After a full reload, missing local files are named and must be reattached or removed; uploaded references for unresolved sends remain reusable.

Sending has two phases through the existing server action layer:

1. Resolve a missing thread on explicit Send and upload selected attachments. An existing-thread send does not require a successful message-history GET.
2. Persist the exact request key, thread, expected contact, channel, text, subject, and uploaded references before dispatch. The API checks recipient context in its existing transaction.

A shared operation lock covers preparation and sending across composer remounts. Duplicate clicks and uncertain retries reuse the original request. Authentication/permission uncertainty, rate limits, and unresolved idempotency conflicts do not discard it. Pending send requests are exempt from ordinary draft expiry and eviction. Success is accepted only with a valid message/thread receipt; Queued is distinct from Sent/Delivered. Only submitted content is cleared, retaining edits made during sending.

Regular staff sends now enforce supplied idempotency keys with the existing durable mutation infrastructure. Keyed message, outbox, audit, and receipt writes commit atomically. Calls without the new key/context fields retain the legacy API contract. Partner replies and internal notes retain their separate audience and permission rules. No database migration is required.

## Verification

All browser fixtures use synthetic people and loopback services in disposable source copies. They do not load workspace `.env` files or send real messages.

Run:

```sh
corepack pnpm test:team-inbox
corepack pnpm test:team-inbox-page
corepack pnpm --filter api exec jest --config jest.config.cjs --runInBand --testPathPattern='inbox-(message-idempotency|thread-message-pagination|queue-contract|queue|reliability|timestamp)|partner-portal-inbox-financial-thread-isolation|team-workflow-drawer|site-inbox-new-lead-contract'
corepack pnpm --filter site exec tsc --project tsconfig.typecheck.json
corepack pnpm --filter api typecheck
```

The local fixtures cover authoritative thread selection; strict empty/error/pagination recovery; actor/channel/audience isolation; prepared-send replay including authentication uncertainty; duplicate clicks and navigation during preparation; attachment recovery; booking and quote draft insertion; optional tool failures; automation concerns and authorized controls; desktop/narrow layouts; keyboard navigation; and real Next Back/Forward navigation.

The final focused run passed 116 API tests, 42 loader/component/recovery checks, and the actual Next page at 1440×900, 390×900, 320×900, 390×664, and 320×568. Site/API TypeScript, the audit E2E TypeScript check, and lint on changed TypeScript files passed. Browser exceptions and React console errors were empty.

An exploratory broader run also exposed a pre-existing media-route test mock that lacks the current thread-scope join; that unrelated test was not changed. The full database-backed E2E suite was not run.

Full-page preview artifacts are written under `artifacts/team-inbox-page/`, including desktop, phone, and short-phone email/filter states.

## Release and rollback

The reliability changes are kept in dedicated loader/composer modules and the existing action/API layers. `InboxSection` owns only the essential server orchestration and renders the separate `InboxView` presentation component. Shell, customer-drawer, and filter presentation changes are also separate components. A visual rollback should retain `inbox-loader.ts`, composer storage/types/client, structured send actions, API idempotency/context checks, and scoped scrolling. Adapt the reverted visual view to those interfaces rather than restoring the old combined loader or form submission path. Legacy `sendThreadMessageAction` remains a compatible wrapper for other callers.

Before a staging release, run the local commands above, then verify the same flows using staging-only customers and delivery providers. Production hosts must not be used as substitutes for a staging messaging test.

At implementation time, repository and deployment inspection identified main/production services only. No staging URL or sanitized staging account was available. Staging verification remains pending that environment information; no production deployment or real outbound message is part of this work.
