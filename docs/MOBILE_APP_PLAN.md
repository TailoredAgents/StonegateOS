# Mobile App Plan

This is the living implementation plan for bringing StonegateOS to a production-ready phone app without disturbing the desktop Team Console.

## Goal

Build a dedicated phone-first app for daily field, sales, and owner workflows while keeping the existing computer version stable.

## Launch Remaining Checklist

Use this as the first source of truth for what is still needed before calling the phone app ready.

Status options:

- `[x]` Done
- `[~]` In Progress
- `[ ]` Not Started

### Must Finish Before Launch

- `[~]` Mobile shell, login, 30-day team sessions, and `/api/mobile/me`.
- `[~]` Role gating for Jeffrey, Austin, and Devon.
- `[x]` Create/confirm real accounts: Jeffrey owner, Austin owner, Devon sales.
- `[~]` Add automated tests proving Devon cannot access owner/admin screens or APIs.
- `[~]` Add automated tests proving owner accounts can access owner-only screens and APIs.
- `[~]` Mobile Inbox: live threads, detail, replies, search/filter, call button.
- `[~]` Mobile Contacts: live search, detail, basic edit, notes.
- `[~]` Mobile Calendar: day view, projected daily amount, create/reschedule/cancel/complete, upload attachment.
- `[~]` Mobile Quotes: list, create, edit, send, accepted/declined status.
- `[~]` Mobile My Day screen: assigned appointments, projected jobs, map/status/complete quick actions.
- `[~]` Mobile Owner Snapshot: collected today, projected work, booked jobs, open leads, follow-ups, provider health.
- `[~]` Mobile Access screen: launch account readiness for Jeffrey, Austin, and Devon.
- `[~]` Mobile Settings screen: account info, logout, session status.
- `[~]` Basic offline/bad-signal handling for key forms.
- `[~]` PWA/Home Screen install: manifest, icons, theme color, install behavior.
- `[ ]` Real-device testing on Jeffrey's phone.
- `[ ]` Real-device testing on Austin's phone.
- `[ ]` Real-device testing on Devon's phone.
- `[ ]` Final desktop regression check for `/team`.
- `[ ]` Final production deploy and smoke test at `https://stonegatejunkremoval.com/mobile`.

### Should Finish Soon After Launch

- `[ ]` Standalone expense receipt workflow from mobile.
- `[ ]` Contact-level quote media/photo gallery workflow.
- `[ ]` Better quote detail view: line items, customer preview, share-link copy.
- `[ ]` Convert accepted quotes into booked jobs from mobile, if desired.
- `[ ]` Inbox done/snooze workflow where completed messages leave the active inbox after 24 hours.
- `[ ]` Push-style inbox updates if polling is not smooth enough after real-device testing.
- `[ ]` Face ID/passkey unlock layer after baseline auth is stable.
- `[ ]` Advanced offline queue with pending-sync labels and retry.

## Product Direction

Recommended path:

- Build the phone app as `/mobile` routes inside the existing `apps/site` app.
- Reuse the existing backend, database, auth tables, permissions, automations, and integrations.
- Keep `apps/site` and the desktop `/team` experience stable.
- Start with a PWA/profile-installable app for speed and internal deployment.
- Consider Expo/native later only if the PWA hits a real phone capability limit.

## Architecture

Keep:

- `apps/site`: public site and desktop Team Console.
- `apps/api`: backend, auth, database, admin APIs, integrations.
- `outbox-worker`: reminders, follow-ups, background jobs.

Add:

- `/mobile` routes inside the existing `apps/site` app.
- Mobile-specific API endpoints only when the current desktop APIs are too large or awkward for phone workflows.
- Mobile E2E tests that run separately from desktop E2E tests.

Rule:

- Mobile work must be additive. Do not redesign or destabilize the computer version to make mobile work.
- Mobile ships through the existing web deployment. No separate Render service and no new Cloudflare DNS record for the first launch.

## Day-One Mobile Scope

Build phone workflows that matter in the field and during daily operations:

- First launch users: Jeffrey, Austin, and Devon.
- First screen: Inbox.
- My Day: assigned appointments, projected jobs, maps, completion, quick actions.
- Inbox: SMS, Messenger, email threads, replies, calls, assignment, snooze/done states.
- Contacts: search, profile, notes, message history, appointment/quote context.
- Calendar: day view, appointment detail, reschedule/cancel, map navigation.
- Quotes/Jobs: create or edit quote, send quote, track status, add job notes/photos.
- Owner Snapshot: today revenue, leads, booked jobs, open follow-ups, provider health warnings.

Keep desktop-only at first:

- Full marketing dashboards.
- SEO agent.
- Deep settings and policy configuration.
- Bulk imports.
- Advanced reporting.

## Auth And Role Gating

The existing system already has the right base:

- `team_members`: individual staff accounts.
- `team_roles`: owner, sales, crew, office/read-only style roles.
- `team_login_tokens`: magic-link login.
- `team_sessions`: active sessions.
- Role permissions plus per-user permission grants/denies.
- Owners resolve to full access (`*`).

Phone app rule:

- Every real person gets their own account.
- No shared Owner/Crew passwords.
- No legacy emergency sessions in mobile.
- The UI hides screens the user cannot use.
- The API still enforces permissions server-side, even if the UI hides a button.

Initial accounts:

- Jeffrey: `owner`
- Austin: `owner`
- Devon: `sales`

Owner account behavior:

- Can see owner snapshot, inbox, contacts, quotes, calendar, jobs, settings, access/admin, audit, provider health.
- Can create/edit users and roles.
- Can override permissions.
- Can see revenue and sensitive business controls.

Sales account behavior:

- Can see all sales leads.
- Can see contacts, inbox, quotes, follow-ups, and calendar items relevant to sales.
- Can send messages directly.
- Can send any quote.
- Can create, reschedule, and cancel appointments.
- Can edit basic customer info.
- Can upload job photos, quote photos, and receipts.
- Can see projected daily calendar amount, similar to the current calendar projection.
- Cannot access owner dashboard, revenue controls, access management, audit logs, policy settings, provider secrets, or destructive admin tools.

Recommended initial `sales` role permissions:

- `messages.read`
- `messages.send`
- `appointments.read`
- `appointments.update`
- `bookings.manage`

Do not give sales:

- `*`
- `read`
- `policy.read`
- `policy.write`
- `automation.read`
- `automation.write`
- `audit.read`
- `access.manage`
- `contacts.merge`
- `sales.reset`
- `expenses.read`
- `expenses.write`

Why these permissions:

- `messages.read`: lets sales view inbox threads and conversation history.
- `messages.send`: lets sales reply to customers, retry failed sends, upload inbox media, and use sales reply/draft flows.
- `appointments.read`: lets sales see My Day, quotes, Sales HQ, outbound queue, scorecards, appointment context, and schedule summaries.
- `appointments.update`: lets sales mark touches/dispositions, update appointment-related status, manage sales tasks, and perform normal follow-up work.
- `bookings.manage`: lets sales book/reschedule appointments and use contact/calendar/pipeline workflows that currently depend on booking management.

Data scope rule for sales:

- Sales can see all sales leads.
- Sales should still be blocked from owner-only company-control data.
- Owners can see all records.
- Revenue visibility for sales is limited to job/quote context and projected daily calendar amount. Sales does not get owner revenue dashboards.

Recommended future permission cleanup:

- Add narrower permissions such as `contacts.read`, `contacts.write`, `quotes.read`, `quotes.write`, `quotes.send`, `pipeline.read`, `pipeline.write`, `tasks.read`, and `tasks.write`.
- Keep the initial launch on the existing permission vocabulary unless narrower permissions are needed to close a real safety gap.

Implementation approach:

1. Seed the required roles with explicit permissions.
2. Create owner accounts for Jeffrey and Austin.
3. Create Devon as a sales account.
4. Build `/api/mobile/me` so the phone app always knows the current user, role, and permissions.
5. Build mobile navigation from permissions.
6. Guard every mobile API route with `requireTeamSession` plus required permissions.
7. Add tests proving Devon cannot access owner-only routes or screens.
8. Add tests proving owner accounts can access owner-only routes.
9. Add audit logging for important mobile actions: sending messages, sending quotes, changing appointments, changing user access.

## Non-Third-Party Onboarding

Use first-party onboarding inside StonegateOS:

1. Owner opens Access Management.
2. Owner creates a team member with name, email, phone, and role.
3. System sends an invite/magic link by email or SMS.
4. New user opens the link on their phone.
5. User sets their own password.
6. User lands inside the mobile app with their role applied.
7. Owner can deactivate the account immediately if needed.

No Auth0, Clerk, Firebase Auth, or other third-party identity provider is required.

Security requirements:

- Store only hashed passwords.
- Store only hashed session tokens.
- Expire magic links.
- Revoke sessions on logout/deactivation.
- Default session length: 30 days.
- Keep audit records for sensitive actions.
- Never expose `ADMIN_API_KEY` to the mobile client.
- Mobile client talks through user-session auth only.
- Biometric unlock can be added after password/session login by using device passkeys/WebAuthn or a native wrapper. It should unlock an existing trusted session, not replace server-side role permissions.

## Implementation Phases

## Build Tracker

Use this section as the source of truth while implementing the phone app.

Status options:

- Not Started
- In Progress
- Blocked
- Done

### Milestone 1: Mobile Shell + Auth

Status: In Progress

Progress:

- `/mobile` route added inside `apps/site`.
- `/mobile/login` added with password and mobile magic-link login.
- `/mobile/auth` added as the mobile magic-link callback.
- `/api/mobile/me` added for mobile session/role/allowed-screen lookup.
- Team sessions changed from 14 days to 30 days.
- Mobile magic links can route back to `/mobile/auth`.
- Mobile owner Access screen added for launch-account readiness, role review, active status, password status, account creation, account updates, and mobile login-link requests.
- Sales role defaults include live inbox, messaging, appointment, booking, and quote permissions.
- Sales quote permissions include read/write/send/update, but not quote delete.
- Mobile server actions check the signed-in user's permissions before writing data.
- Quote APIs enforce quote permissions server-side.
- Mobile Settings now shows account, role, password status, session duration, allowed screens, and logout.
- Production site build passes after the shell/auth addition.

Acceptance criteria:

- `/mobile` exists inside `apps/site`.
- `/mobile` has its own phone-first layout and does not reuse or modify the desktop Team Console layout.
- Unauthenticated users are sent to mobile login.
- Logged-in users land on Inbox.
- Existing team member sessions work on mobile.
- Legacy emergency Owner/Crew access is not used for mobile.
- `/api/mobile/me` returns the logged-in team member, role, permissions, and allowed mobile screens.
- Owner users can access owner-capable mobile areas.
- Sales users cannot access owner-only mobile areas.
- Desktop `/team` still loads and passes smoke testing.

### Milestone 2: Mobile Inbox

Status: In Progress

Progress:

- Mobile Inbox list is connected to live open CRM threads.
- Mobile thread detail is connected to live messages.
- Mobile reply form queues outbound messages through the existing inbox send API.
- Mobile call button uses the contact phone when available.
- Selected thread view now shows compact contact detail: stage, phone/email, appointment count, quote count, properties, and recent notes.
- Mobile users can add a contact note from the selected thread.
- Inbox list now supports search plus open/pending/closed filtering.
- Focused lint passes for mobile files.
- Production site build passes after Inbox wiring.

Acceptance criteria:

- Inbox thread list loads on mobile.
- Thread detail loads on mobile.
- SMS/Messenger/email context is clear enough for sales use.
- Sales users can send replies directly.
- Failed-send state is visible.
- Retry flow is available where supported.
- Owner-only controls are hidden from sales.
- API permissions still block unauthorized message reads/sends.

### Milestone 3: Mobile Contacts

Status: In Progress

Progress:

- Selected Inbox thread now surfaces compact contact detail.
- Mobile contact detail shows basic info, pipeline stage, properties, stats, notes, and quick note entry.
- Sales users can edit basic contact name, phone, and email from the selected thread.
- Mobile Contacts tab now supports live contact search.
- Mobile Contacts tab can open contact detail with basic info, pipeline stage, properties, stats, notes, edit, and add-note controls.
- Merge/delete controls are not present in mobile.
- Focused mobile lint passes.
- Production site build passes after contact detail/edit additions.

Acceptance criteria:

- Contact search works on mobile.
- Contact detail shows basic customer info, notes, messages, appointments, and quotes.
- Sales users can edit basic customer info.
- Sales users can add notes.
- Sales users cannot merge/delete contacts.
- Owners retain full allowed access.

### Milestone 4: Mobile Calendar + Appointments

Status: In Progress

Progress:

- Mobile Calendar day view is connected to live calendar feed.
- Day navigation supports previous, today, and next.
- Calendar shows projected daily amount using job appointment totals.
- Appointment cards show time, customer, address, status, amount, and latest note.
- Mobile My Day now combines today's appointments, projected daily amount, open tasks, quick links, map links, and task completion.
- Sales users can confirm or cancel appointments from mobile.
- Sales users can reschedule appointments from mobile with date/time controls.
- Sales users can book a job or in-person quote from the selected inbox contact.
- Focused mobile lint passes.
- Production site build passes after calendar additions.

Acceptance criteria:

- Calendar day view works on mobile.
- Appointment detail works on mobile.
- Sales users can create appointments.
- Sales users can reschedule appointments.
- Sales users can cancel appointments.
- Cancellation captures a reason if supported by the workflow.
- Sales users can see projected daily calendar amount.
- Sales users cannot access full owner revenue dashboards.
- Map/navigation links work on phone.

### Milestone 5: Mobile Quotes + Jobs

Status: In Progress

Progress:

- Mobile Quotes tab now loads the live quote list.
- Sales users can filter quotes by status.
- Sales users can send existing pending/sent quotes from mobile.
- Sales users can mark quotes accepted or declined from mobile.
- Sales users can create a quick exact-price quote from a selected inbox contact.
- Sales users can edit pending/sent quotes from mobile by changing services, exact prices, and notes.
- Accepted/declined quotes are locked from mobile editing.
- Quote updates recalculate totals through the existing pricing engine and are audited.

Acceptance criteria:

- Sales users can create quotes.
- Sales users can edit quotes.
- Sales users can send any quote.
- Quote status is visible.
- Job/appointment context is visible from the quote flow.
- Quote actions are audited.
- Owner-only revenue/admin controls remain hidden from sales.

### Milestone 6: Photos, Quote Media, And Receipts

Status: In Progress

Progress:

- Mobile calendar appointment cards now support uploading job photos, quote photos, receipt images, or receipt PDFs.
- Uploads use the existing appointment attachment API, audit path, and 20MB backend limit.
- Upload success/failure is shown on the mobile calendar.
- Contact-level quote media and standalone expense receipt workflows are still pending.

Acceptance criteria:

- Job photo upload works from phone.
- Quote photo upload works from phone.
- Receipt upload works from phone.
- Upload progress/error state is visible.
- Failed upload can be retried.
- Uploaded media attaches to the correct record.
- Mobile upload limits and accepted file types are clear.

### Milestone 7: Notifications

Status: Not Started

Acceptance criteria:

- Existing Twilio lead notifications remain active.
- Mobile does not remove or weaken the current notification safety net.
- Notification preferences plan is documented before changing alert routing.
- App notification proof-of-concept is tested on real phones before replacing any Twilio alert.

### Milestone 8: Offline And Bad-Signal Handling

Status: In Progress

Progress:

- Mobile app now shows an offline banner when the phone reports no network.
- Mobile form submissions are blocked while offline so sends, quotes, uploads, and edits do not fire into a dead connection.

Acceptance criteria:

- Basic offline/error banner exists.
- Failed sends/uploads show a clear retry state.
- Duplicate sends are prevented.
- Advanced offline plan remains documented for later.
- No silent data loss when the phone loses connection mid-action.

### Milestone 9: Mobile E2E And Desktop Regression

Status: In Progress

Progress:

- Mobile Playwright role-gating spec added for sales and owner storage states.
- Sales test proves a Devon-style account is forced away from the owner screen and receives `403` from an owner-only mobile API.
- Owner test proves an owner account can see the owner mobile screen and receives `200` from the owner-only mobile API.
- API unit test added for sales default permissions, owner full access, and explicit permission denies.

Acceptance criteria:

- Mobile owner login test passes.
- Mobile sales login test passes.
- Sales cannot see owner/admin screens.
- Sales gets `403` from owner-only mobile APIs.
- Owner can access owner-only mobile APIs.
- Inbox read/reply test passes.
- Contact edit/note test passes.
- Calendar create/reschedule/cancel tests pass.
- Quote create/send test passes.
- Photo/receipt upload tests pass.
- Desktop `/team` smoke tests still pass.
- Public booking flow still passes.

### Milestone 10: Real-Device Launch QA

Status: Not Started

Acceptance criteria:

- Tested on Jeffrey's phone.
- Tested on Austin's phone.
- Tested on Devon's phone.
- Login works on each real device.
- 30-day session behavior is verified.
- Home Screen install/profile behavior is verified.
- Inbox, contacts, calendar, quote, and upload flows work on real devices.
- Rollback plan is documented.
- Launch is approved only after automated tests and real-device tests pass.

### Phase 1: Desktop Safety Baseline

- Run `pnpm -w build`.
- Run `pnpm -w lint`.
- Run existing tests.
- Run desktop Playwright smoke flows.
- Make desktop regression checks part of the mobile work.

### Phase 2: Mobile Foundation

- Create `/mobile` inside `apps/site`.
- Add mobile app shell, bottom tabs, loading states, error states, account menu.
- Add installable PWA manifest, icons, splash/theme color.
- Add mobile environment config.

### Phase 3: Auth Foundation

- Confirm roles and permissions.
- Add or harden first-party invite/password setup.
- Add `/api/mobile/me`.
- Add mobile login/logout/session persistence.
- Disable legacy emergency access for mobile.

### Phase 4: Core Screens

- My Day.
- Inbox.
- Contact detail.
- Calendar day view.
- Quote/job workflow.
- Owner snapshot.

### Phase 5: Phone Features

- Tap-to-call.
- Map navigation links.
- Camera/photo upload.
- Job photo upload.
- Quote photo upload.
- Receipt upload.
- Push notifications if needed.
- Retry states for failed sends/uploads.

Notification direction:

- Keep current Twilio notifications during the first mobile launch.
- Add in-app/mobile notification preferences later so owners can decide which alerts stay as SMS and which move into app notifications.
- Do not remove existing lead SMS alerts until the mobile notification path is proven reliable on real phones.

### Phase 6: Mobile API Hardening

Potential additive endpoints:

- `/api/mobile/me`
- `/api/mobile/my-day`
- `/api/mobile/inbox`
- `/api/mobile/inbox/:threadId`
- `/api/mobile/contacts/search`
- `/api/mobile/contacts/:id`
- `/api/mobile/calendar/day`
- `/api/mobile/appointments/:id`
- `/api/mobile/quotes`
- `/api/mobile/owner/summary`

Rules:

- Do not break existing desktop endpoints.
- Validate request and response shapes.
- Require team session auth.
- Require permissions per route.

### Phase 7: Offline And Bad-Signal Behavior

Minimum:

- Cached shell.
- Visible offline/error banner.
- Retry failed sends/uploads.
- Prevent duplicate sends.

Later:

- Draft preservation for notes/replies.
- Offline job checklist.
- Queued photo uploads.
- Appointment cache for the day.

Advanced offline plan:

1. Cache the app shell and today's assigned work.
2. Save message drafts, notes, job checklists, and upload metadata locally.
3. Queue actions while offline with clear "pending sync" labels.
4. Sync automatically when the phone reconnects.
5. Deduplicate risky actions like message sends, quote sends, appointment changes, and uploads.
6. Show owners a sync/error log for unresolved mobile actions.

### Phase 8: E2E Testing

Mobile tests:

- Owner login works.
- Sales login works.
- Devon cannot see owner/admin screens.
- Devon gets `403` from owner-only APIs.
- Owner can access owner-only screens/APIs.
- My Day loads.
- Inbox thread opens and sends a test reply.
- Contact note saves.
- Quote sends.
- Appointment reschedule works.
- Photo/receipt upload works.
- Appointment create, reschedule, and cancel work for sales.
- Sales can see daily projected calendar amount but cannot see owner revenue dashboards.

Desktop protection tests:

- Desktop login still works.
- Desktop inbox still loads.
- Desktop contact search still works.
- Desktop calendar still works.
- Booking flow still works.
- Quote lifecycle still works.

### Phase 9: Production Release

- Deploy mobile through the existing web deployment.
- First launch URL: `https://stonegatejunkremoval.com/mobile`.
- No separate Render service for first launch.
- No new Cloudflare DNS record for first launch.
- Configure production env vars.
- Add health check and smoke check.
- Install on phones through PWA/Web Clip/profile.
- Test on real iPhone and Samsung devices.

## Open Decisions

- PWA first vs Expo native first. Current recommendation: PWA first.
- Whether biometric unlock is implemented during first launch or later.
- Exact notification split between existing Twilio SMS alerts and future app notifications.
- Whether mobile photo uploads attach to appointments, contacts, inbox threads, or all three by default.

## April 26, 2026 Mobile Fix Pass

- `[x]` Added property/address capture to mobile booking from an inbox thread.
- `[x]` Added simple full-address detection from recent thread messages and prefill during booking.
- `[x]` Booking a new address now saves it to the contact before creating the appointment.
- `[x]` Added inbox auto-refresh on an interval, focus, and return-from-background.
- `[x]` Tightened bottom navigation labels and sizing to avoid overlapping text.
- `[x]` Hid the Open Tasks card from mobile My Day until a 24-hour inbox cleanup workflow exists.
- `[x]` Added mobile job/quote completion controls in My Day and Calendar.
- `[x]` Consolidated duplicate Jeffrey records in production data and updated commission/crew constants to the single Jeffrey account.
- `[x]` Commission policy updated: sales commission retired, management raised to 20% split 10% Jeffrey / 10% Austin, and labor fixed at 25% with Jeffrey + Austin + Devon split 7.5% / 7.5% / 10%.
