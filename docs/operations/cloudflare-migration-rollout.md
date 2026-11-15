# StonegateOS Cloudflare rollout plan

Prepared November 15, 2026 (America/New_York).

Status: authorized execution is underway on `codex/cloudflare-migration` in an isolated worktree. Production traffic, application consumers and PostgreSQL remain on Render. No production DNS cutover, provider messages, payments or database retirement have occurred. Recovery, media and Cloudflare runtime trials have completed; the production connection and application integration gates remain open.

Private receipts and credentials are held outside this public repository under `~/.local/share/stonegate-migration`. Never commit those files, database dumps, object keys or customer records.

## Execution receipts — November 15

| Check | Observed result | Remaining limit |
|---|---|---|
| Consistent encrypted PostgreSQL export and isolated restore | 230 tables and 200,984 rows; zero unexplained content/schema differences | Snapshot is a rehearsal, not the final synchronization boundary |
| Database objects | 126 functions and 115 triggers match; no views | Final provider role/grant mapping and sequence values need separate reconciliation |
| Media | 206 R2 objects readable and SHA-256 hashed; 203 active database references checked, zero findings | Phone-local unsynced queues still require inspection before cutover |
| Native Cloudflare runtime | 29 checks passed across all four pinned images, including restarts, Sharp, Argon2, FFmpeg and PDF rendering | Diagnostic entrypoints only; consumers have not started |
| Actual Next.js runtime | Seven page/asset/health checks passed inside a network-isolated Cloudflare Container | No authenticated business flows or production API access in this trial |
| Private Worker SQL | Five consecutive reads matched restored table counts through Hyperdrive and Tunnel | Private IP works; internal hostname path failed. Certificate verification is disabled for this isolated restore trial and must be resolved for production |
| Verified Container SQL | Six read-only TLS queries across two Container restarts; wrong certificate identity rejected in both cycles | Access service token expires November 22; outage recovery and application-level pooling still need validation |
| Existing regression suites | Quote and Expense follow-up passed on PG17/Node24; Partner Portal production journey passed | Broad browser audit failed in setup and UI contracts; focused rerun required |
| Production health and access rejection | 13 live checks passed; unsigned Twilio callbacks rejected | Positive provider scenarios require controlled staging fixtures/sandbox credentials |

The restore verifier canonicalizes CHECK expressions using the restore server's PostgreSQL parser and compares enum label order independently of PostgreSQL's internal fractional ordering numbers. Seven equivalent CHECK renderings were accounted for; row contents were not normalized away. Sequence values are not MVCC and are not claimed to match a live source snapshot.

The candidate images preserve different live revisions per service. Authenticated Render SSH confirmed Node 24.22.1 for the website and 24.21.0 for API, outbox and Discord. Build run `43766913190` and image-transfer run `43767348029` passed. The website build contains all 14 captured public configuration fields; its manifest hash matches the deployed configuration. Initial images without that configuration are superseded.

The Container SQL trial uses the official `cloudflared access tcp` client, a service-token-only Access policy and the private Render connector. The client trusts Node roots plus Cloudflare's provided Container CA. PostgreSQL separately verifies an explicitly pinned certificate obtained over authenticated Render SSH, including its server identity. All query credentials belong to a non-superuser SELECT-only restore role; no production database credentials enter the trial. The earlier Hyperdrive trial with certificate verification disabled remains diagnostic only.

The broad baseline audit (`43763531179`) was stopped near its time limit after capturing failures. Its core browser setup rejected a too-short synthetic admin-session secret. API tests reported 4,234 passing, 193 skipped and three failed source-contract assertions (formatting, an extracted message component, and a sidebar CSS scope). Portal audit paths also encountered disabled feature configurations and UI assertion failures. These are not successful migration checks. Focused fixture/contract corrections and reruns are tracked on this branch; production application behavior is unchanged.

Temporary resources (prorated; additional to unchanged production hosting):

| Resource | Identifier | Cost / scope |
|---|---|---|
| Private restore PostgreSQL | `dpg-dbt21dui0phs73efick0-a` | Basic 1GB + 5GB storage, about $20.50/month equivalent |
| Render Tunnel connector | `srv-dbt2abt6e07s73b7ps30` | Starter, $7/month equivalent; automatic deploy disabled |
| Cloudflare Tunnel | `e1e17afc-ff6e-4a8d-a7ef-a83d6c0d645d` | QUIC; restore-only Access-protected TCP ingress |
| Zero Trust / Access | `migration-db.stonegatejunkremoval.com` | Free plan activated, $0/month; seven-day service credential, one restrictive Service Auth policy |
| Restore VPC service | `01a1e122-4780-75b2-9926-b159cbdfad10` | Restricted destination TCP5432; temporary private IP |
| Read-only restore Hyperdrive | `b449cf5370d34f62aaa57be60980a710` | Caching disabled; origin connection limit five |
| Diagnostic Workers | `stonegate-migration-validation`, `stonegate-container-validation`, `stonegate-database-validation` | Bearer protected, synthetic operations only; metered usage |
| Synthetic R2 bucket | `stonegate-migration-validation` | No public domain; isolated PUT/GET/DELETE trials |

Do not treat the $27.50/month equivalent temporary Render overlap as savings. Original services are still billed. Validation Containers are stopped after tests and have a 60-second idle shutdown. No production database has been provisioned at a replacement provider. One new restore-only CNAME was added; all 17 pre-existing DNS records were compared and remain unchanged.

Current next gates:

1. Rerun the affected browser baseline with valid synthetic session secrets; resolve the remaining failures without weakening application checks.
2. Exercise the verified Container SQL path through connector interruptions, pool reconnects and token/certificate rotation.
3. Start isolated real API/site staging against disposable data, preserving the per-service deployed revisions and provider isolation.
4. Finish authenticated application/provider staging flows, consumer drain/fencing, durable webhook handling, and rollback rehearsal.
5. Only then move traffic and begin the observation windows below. There is no unattended production cutover or retirement timer armed.

## Objective and operating decisions

Move all four StonegateOS application services to Cloudflare while they continue using the existing Render PostgreSQL database. Stabilize that arrangement. Then provision a replacement managed PostgreSQL instance, copy and reconcile all application data, complete a controlled writer handoff, and retain the old database before retirement.

Success means zero lost committed records and zero lost acknowledged incoming events, no migration-induced duplicate financial or communication effects, preserved media and unsynced phone work, functioning integrations, tested recovery, and measured hosting cost. No phase is considered successful solely because deployment or a backup command completed.

Working rollout defaults following the user's instruction to proceed:

- Migrate the currently deployed behavior. Keep the 154 changed/untracked working-tree paths separate.
- Website on Workers if a compatibility trial passes; API, outbox and Discord in Containers.
- Retain the public website origin and existing R2 bucket names/object keys.
- Keep PostgreSQL. Evaluate PlanetScale's Cloudflare integration as the replacement; confirm version, extensions, recovery capability, capacity and total price before provisioning.
- Target approximately $55–75/month after optimization; retain the $70–95/month conservative alternative until runtime measurements establish achievable savings.
- Plan an off-hours write interruption with a proposed 30-minute ceiling. The rehearsal must demonstrate that ceiling; otherwise revise the window or replication method before scheduling.
- Observe each application move through a normal operating day; observe all application services together for at least 72 hours before the production database move.
- Retain the old database for 30 days after the database handoff. This is a proposed retention period, not a scheduled deletion.
- Request a temporary additional hosting budget of $100/month equivalent, prorated, for overlapping services, an isolated test/restore target, backups and a possible connectivity relay. Shared account fees and existing provider usage remain separately accounted for.

## Baseline refreshed on November 15

| Resource | ID | Live source / configuration |
|---|---|---|
| Website | srv-d43o7c0dl3ps73a4rb2g | 5a90cf86608c76cd85773dbd2362b7fa07d5019c; Standard; one instance |
| API | srv-d43o7k0dl3ps73a4rhu0 | 0e66a789ea1c33b297aa5f1324571904c3fa2894; Standard; one instance |
| Outbox | srv-d43sdh0dl3ps73a8l70g | 0c0026b4cd0e26d65c93480e1aeb7e62596ffb0b; Standard; one instance |
| Discord | srv-d6fqpmvgi27c73cgd4jg | 5a90cf86608c76cd85773dbd2362b7fa07d5019c; Starter; one instance |
| PostgreSQL | dpg-d43o7c0dl3ps73a4rb4g-a | PostgreSQL 17; Basic 1 GB; 15 GB allocated; no HA; external IP allowlist empty |
| Render workspace | tea-cvl1h0odl3ps738ecuf0 | User previously confirmed; access still works |
| Cloudflare account | 78ed83c6e3947c93763acef3a48a5561 | OAuth refreshed; Workers/Containers permissions present |
| Website zone | 7eb7c6c85a93c7b0cae01de78028a40f | stonegatejunkremoval.com active in that Cloudflare account |
| R2 | stonegate; stonegate-appointment-media | Both still returned by the authenticated bucket inventory |

The initial read-only baseline found no Stonegate Workers or Hyperdrive. Execution subsequently created the diagnostic resources above. Authenticated browser tabs provide DNS UI access; the CLI OAuth token still lacks DNS/Access API scope. A dedicated migration SSH key now reaches the running Render API instance and provides private forwarding to both databases. External database allowlists remain empty. Backups and deployed settings were captured privately. The zone includes the Render apex address plus four legacy Squarespace apex addresses; these have not been altered.

Website and API auto-deploy after checks pass; outbox also uses checksPass; Discord auto-deploys on commits. Do not push migration changes to main while those triggers can deploy unreviewed combinations.

The current shell's Node 20 and root-owned npm cache initially prevented modern Wrangler startup. A task-specific temporary npm cache and Node 22 resolved that tool-only issue without changing the application's package files or global Node installation. Pin the deployment toolchain separately from application runtime choices.

## Phase 0 — Isolate the migration and establish access

Work:

1. Create an isolated migration worktree/branch after resolving the production-versus-unfinished-work decision. Preserve the existing worktree; do not stash, reset, clean or merge it automatically.
2. Record a per-service source manifest, build lockfile, image digest/deployment ID, feature flags and environment-variable names. Preserve the existing service version differences initially. Any baseline alignment must be a separately reviewed/tested release.
3. Establish Render SSH or an authorized internal shell for metadata-only database inventory and secure export. Prefer existing internal access; do not expose PostgreSQL to every Internet address.
4. Obtain the DNS capability needed for the verified zone and a secure way to transfer deployed secrets into target secret stores. Keep secret values and customer records out of Git, chat, CI logs and public artifacts.
5. Inventory actual DNS records, TLS, domains, provider callbacks, OAuth redirects, media origins, CORS, CSP, session cookies and service authentication. Inspect existing account-level Cloudflare plan usage and Render subscription eligibility.
6. Produce a reviewed costed resource list for the first staging phase. Preserve direct PostgreSQL connectivity for migration tools that use session advisory locks.

Exit evidence: reproducible per-service builds, confirmed account/zone ownership and capabilities, read-only database access, actual resource/endpoint/flag inventory, source decision, temporary budget and candidate maintenance window.

Status: isolated worktree, source manifest, SSH, environment inventory and browser DNS access established. Production behavior remains unchanged; final cost/availability and cutover timing gates remain open.

## Phase 1 — Prove recovery and the temporary network path

Work:

- Inventory actual application schemas, table/partition counts, sizes, extensions, sequences, functions, triggers, roles/grants, migration journal, large objects, foreign/materialized tables, and dependencies outside public schema.
- Inventory data families: customer/partner/team accounts; bookings; quotes; payment and expense ledgers; messages/calls; sessions/MFA; encrypted fields; integration cursors; audit logs; outbox rows, retry states and uncertain provider operations.
- Verify latest successful backup, PITR retention and restore capability. Make an encrypted export and restore it to an isolated disposable recovery target. Record elapsed dump/restore/validation time. Keep this recovery target distinct from the eventual production replacement.
- Build a repeatable, bounded-memory comparison tool: stable table/key ordering, canonical NULL/JSON/numeric/time handling, row counts and chunk hashes; print aggregate results rather than row contents.
- Inventory every referenced R2 object by key/size/checksum, check readability and document pre-existing missing references. Do not assume ETag is a content checksum. Preserve existing buckets. Resolve/protect pending staging uploads before their two-day expiry. Check actual phone upload and expense queues.
- Prove a secure route from each intended Cloudflare runtime to Render PostgreSQL, including TLS, connection limits, restart and outage recovery. The Render database is currently internal-only.
- For Worker-originated SQL, Hyperdrive with caching disabled for correctness-sensitive reads is a candidate. Private access requires a connector in the Render network. For Containers and administrative tools, validate the actual TCP/private-connectivity design separately: a Hyperdrive binding is not a general Internet PostgreSQL endpoint.
- Select the concrete temporary path only after testing account capabilities and pricing. Options include a private connector/relay or narrowly allowlisted stable egress with TLS. Do not assume normal Cloudflare Container egress has a fixed source IP. If no workable path fits the constraints, revise the design before moving the API.

Exit evidence: successful isolated restore, full application-data inventory, documented existing discrepancies, functioning secure Cloudflare-to-Render database connectivity, and measured recovery times.

Rollback: production remains on the original infrastructure. Temporary restore/relay resources can be removed once no longer needed.

## Phase 2 — Build and verify Cloudflare staging

Deliverables, to be implemented on the migration branch:

- Locked build/deploy toolchain and explicit staging/production configuration.
- Site deployment adapter selected by compatibility trial, with a Container fallback if the Workers path fails required behavior.
- Node Container images for API, outbox and Discord, preserving FFmpeg, Sharp, Argon2, PDF fonts and temporary-file behavior.
- Runtime secrets/settings manifest, readiness checks, metrics, bounded logs and cost alerts.
- Single-consumer lifecycle controls, restart supervision and graceful stop/drain behavior.
- Tested maintenance controls and durable inbound-event handling for the later database switch.
- CI jobs that build and exercise the actual Cloudflare runtime, with immutable release artifacts and reproducible rollback references.

Important implementation details:

- Use a disposable/sanitized test database and separate media test storage; production credentials and live business records must not be writable from ordinary previews.
- Keep public hostname/cookie behavior stable. Validate both Next.js configuration entrypoints, Contentlayer, server actions, proxy hops, cache headers, the 20 MB upload paths and Square CSP.
- Existing kill switches do not freeze all database writes: scheduler tasks, reconciliation and other paths still write. Build and prove a complete freeze covering API, webhooks, workers, scheduled jobs, imports and administrative scripts.
- Retain the PostgreSQL outbox. Do not simultaneously rewrite every background job into Queues/Workflows.
- Outbox and Discord must survive process death, cold starts and container lifecycle events. Specify one active dispatcher, stop claiming new work during shutdown and retain durable uncertainty markers.
- New-process ownership checks do not automatically fence the old Render code. The rollout must actually stop old consumers and prevent their auto-restart/auto-deploy before starting replacements.
- Prevent migrations from running automatically at every application start. Use a separate controlled migration job against the direct database endpoint.
- Do not assume a Worker deployment automatically finishes a Container rollout. Verify the running image and health of every intended instance.

Test matrix:

| Area | Required evidence |
|---|---|
| Identity | Existing password hashes, login/logout, session continuity, MFA, staff/partner permissions and tenant isolation |
| Website and UI | SSR, server actions, Team/Mobile/Partner navigation, booking, quotes, redirects, SEO and cache isolation |
| Financial | Sandbox payment initiation, retries, callbacks, reconciliation, invoices/refunds/expense arithmetic and idempotency |
| Media | Presigned uploads, CORS, image/HEIC/video/PDF processing, private downloads and mobile offline replay |
| Integrations | Signed Twilio/Meta/email/Square/Calendar callbacks; OAuth redirects; Ads, Traccar, OpenAI and Discord where enabled |
| Worker lifecycle | Restart mid-job, interrupted provider request, queue recovery, singleton ownership, heartbeat and schedule continuity |
| Database | Locking, transactions, pool limits, fresh reads, network interruption and restore behavior |
| Operations | Error/latency baseline, peak memory, cold start, logs without secrets/customer payloads, and projected costs |

Use existing CI suites for quotes, expenses, Partner Portal, providers and PostgreSQL as the baseline, pinned to the selected application revisions. Exercise PostgreSQL 17 for source parity and the actual chosen destination version. Tests named “production journey” in this repository use disposable infrastructure; they are not permission to run customer-facing actions against production.

Exit evidence: passing required tests, runtime compatibility, restart/failure drills, a proven freeze/replay procedure, rollback rehearsal and an updated cost forecast. No automatic promotion from staging.

## Phase 3 — Move application services, preserving Render PostgreSQL

Rollout order:

1. **Website.** Use an internal preview first. Verify authentication, cookies, server actions and media. Switch the existing public domain only after the candidate passes. Avoid mixing incompatible server-action builds across requests; retain old assets or implement version affinity where required. Monitor through a normal operating day.
2. **API.** Use a stable custom API hostname if the endpoint inventory confirms one is available. Validate signatures against exact allowed public URLs, including temporary legacy callback URLs; do not trust arbitrary forwarded headers. Update site/API settings and provider callbacks. Keep a forwarding path for stale Render callbacks until their retry windows are reconciled.
3. **Outbox.** Stop old dispatch, drain in-flight operations, confirm the old process is gone, and disable its automatic resurrection. Start exactly one Cloudflare consumer. Reconcile pending/uncertain effects, heartbeat and oldest runnable job age.
4. **Discord.** Stop the old bot, confirm disconnection, start the new one and test gateway reconnection plus scheduled tasks.

All application writes still go to the same Render database in this phase. Preserve existing encryption keys and feature flags. A narrow compatibility relay may temporarily remain on Render after the business services move; it is retired when no callbacks or database connections depend on it.

Phase gates:

- No missing or duplicate controlled business operations; no authentication or tenant-isolation regressions.
- No unexplained persistent increase in 5xx errors or material latency regression against the measured baseline.
- Healthy outbox heartbeat and stable/draining runnable backlog; future scheduled events are not incorrectly counted as overdue.
- Confirm actual running versions and only one active background consumer.
- At least 72 hours of stable combined application operation, including daily schedules. Exercise longer-period schedules safely in staging.

Rollback: route the affected service back to its retained Render version using the same database. Stop the new background consumer before reactivating the old one. Pause the next move until the cause is understood.

## Phase 4 — Create and synchronize the production database replacement

Begin after all application service gates pass.

1. Confirm the destination's PostgreSQL version, extensions, region, TLS/roles, connection limits, storage headroom, backups/PITR, recovery objectives and total cost. Confirm single-node versus HA matches the agreed availability requirement.
2. Provision an isolated candidate. Application production credentials cannot write to it during copying.
3. Prefer consistent initial copy plus logical replication when both providers support the full migration path. Render requires support enablement and Pro-or-higher workspace eligibility; verify target import/subscription capabilities rather than assuming them.
4. Freeze application schema changes for the migration. Copy schema and supported roles/grants deliberately. Standard logical replication does not transfer schema changes, sequence state or PostgreSQL large objects; inventory and handle them separately.
5. Measure lag and retained WAL on the Render source. Its storage autoscaling is disabled. Bound migration duration and alert before retained WAL can exhaust source disk.
6. If replication is unavailable, rehearse a final full export/restore under a write freeze. Only use this route if export, restore, complete verification, endpoint switch and recovery margin fit the user's downtime limit.
7. Verify every application-owned table, exact financial aggregates, object references, unique IDs, constraints and outbox state. Record any managed-provider metadata/role differences explicitly.
8. Run functional mutation tests on a disposable clone of the candidate. Do not pollute the actual synchronized production candidate with test writes.
9. Rehearse a backup and restore of the new provider as well as the source export.

Exit evidence: zero unexplained data discrepancies; compatible schema and keys; measured catch-up/final-validation duration; all needed non-replicated objects covered; backup recovery proven; forecast within the agreed budget.

## Phase 5 — Final database handoff

No cutover date is booked until Phase 4 timings fit the agreed window. Before the window, record the exact source/target IDs, roles, URLs, backups, hashes, deployed versions, ingress-buffer state, maintenance owner and abort deadline.

Sequence:

1. Check staff phone queues and unfinished uploads. Pause cleanup, publishing, financial dispatch and other scheduled effects as required.
2. Activate maintenance for interactive writes. Route inbound events to a durable journal outside the database being frozen. Validate signatures and persist the event before acknowledging it. Preserve original event identity, timestamp, ordering requirements and payload integrity for replay.
3. Handle synchronous voice and interactive callbacks separately. For example, voice webhooks require a valid timely response; merely queuing their bodies does not preserve calling behavior. Prove the voice continuity/fallback path and drain active operations where necessary.
4. Stop all database writers and dispatchers; drain active transactions and fence old application credentials/connections. Verify this at the database. UI maintenance and a default read-only connection setting alone are insufficient.
5. Finish replication or perform the rehearsed final restore. Establish and record the common verification boundary. Reconcile sequences, large objects and remaining non-replicated state.
6. Run final per-table counts/chunk hashes, financial and queue checks, schema checks and media-reference reconciliation against that boundary. Any unexplained mismatch prevents the switch.
7. Install the target credentials on every production component, recycle connection pools, and verify every service reaches the target database ID. Keep ordinary writes disabled during read-only smoke checks.
8. Declare the target authoritative. Replay buffered events under idempotency controls and the required ordering rules; then resume user writes and one background dispatcher per role. Record the first target-write time.
9. Reconcile received versus replayed event IDs, message/payment provider outcomes, job backlog and phone uploads. Keep source writers fenced.

Abort rules:

- **Before target writes:** if verification fails or the abort deadline is reached, restore service against the unchanged source and replay buffered events there.
- **After target writes:** never point application traffic at the stale source. Freeze target writes if necessary, preserve target and inbound journal, and use a tested reverse synchronization or forward repair. A retained old database is a recovery reference, not an automatically current rollback replica.

## Phase 6 — Observe, retire and validate savings

- Daily for the first week, reconcile critical business totals, webhook receipts, backlog, provider failures and backups. Review again at 14 and 30 days.
- Exercise all weekly/monthly scheduler families in staging before final retirement; verify the production schedules that occur during observation.
- Keep the old source read-only/protected, independent encrypted backups and compatible artifacts for the proposed 30-day retention period. Protect replication slots from unnecessary WAL retention after handoff.
- Verify there are no remaining requests, credentials, provider URLs, cron jobs, relay dependencies or CI deployment paths requiring the old Render resources.
- Demonstrate a restore of a recent target backup near the end of retention, and retain a final source archive under an explicit retention/access policy.
- Prepare a resource-specific retirement list and record the final retirement decision. No future automatic deletion has been scheduled.
- Remove obsolete services, temporary connectivity, access grants, migration credentials and old deployment triggers as each becomes unused. Keep unrelated Render applications untouched.
- Review measured billing after a complete target billing period and update the savings estimate. Increase/downsize resources only after peak-memory and job-load evidence supports it.

Completion evidence: reconciled data and event manifests, verified business workflows, recovery evidence, final runtime/secret/endpoint inventory, retired resources, updated operations documentation, and actual recurring cost.

## Deliverables and work order

| Work package | Deliverable | Depends on |
|---|---|---|
| A | Release manifest, isolated worktree and metadata inventory | Source decision; Render internal access |
| B | Backup/restore and bounded comparison tools; object inventory | A |
| C | Secure temporary database connectivity and credentials mapping | A; required account capabilities |
| D | Cloudflare staging builds, runtime configuration and CI | A; test infrastructure |
| E | Singleton lifecycle, maintenance and durable callback handling | C, D |
| F | Functional/load/restart/rollback evidence | B–E |
| G | Application migrations and 72-hour observation record | F |
| H | Target PostgreSQL, synchronization and measured rehearsal | G; provider eligibility and quote |
| I | Final comparison, controlled switch and event reconciliation | H; confirmed maintenance window |
| J | 30-day observation, recovery proof, retirement and billing review | I |

The first implementation package is A–D preparation: isolate source, establish database/DNS access, build the inventory/restore checks and run the website/container compatibility trial. Initial code and disposable tests can proceed while access is arranged. Production movement depends on the corresponding exit evidence.

Calendar dates and a reliable engineering estimate follow the access and runtime trials. The 72-hour application observation and proposed 30-day database retention are explicit elapsed-time periods, separate from implementation effort.

## Outstanding operating assumptions

The user authorized end-to-end execution and use of the open provider tabs. The confirmed Render workspace is My Workspace. Access and source-isolation choices have been resolved without changing the original working tree. No further permission is needed for authorized staging work.

The final write-interruption window, destination PostgreSQL plan and measured steady-state cost remain unsettled. Keep the proposed 30-minute interruption ceiling and 30-day source retention as planning defaults; do not schedule a database handoff or deletion until recovery timings and all prerequisite gates support them.

## Technical references

- [Current Cloudflare Next.js deployment guidance](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)
- [Workers best practices](https://developers.cloudflare.com/workers/best-practices/workers-best-practices/)
- [Cloudflare Container rollouts and process lifecycle](https://developers.cloudflare.com/containers/configuration/rollouts/)
- [Container outbound networking](https://developers.cloudflare.com/containers/configuration/outbound-traffic/)
- [Private database connectivity for Hyperdrive](https://developers.cloudflare.com/hyperdrive/configuration/connect-to-private-database/)
- [Cloudflare/PlanetScale PostgreSQL integration](https://developers.cloudflare.com/hyperdrive/planetscale/)
- [Render logical replication requirements](https://render.com/docs/postgresql-logical-replication)
- [PostgreSQL logical replication restrictions](https://www.postgresql.org/docs/current/logical-replication-restrictions.html)
