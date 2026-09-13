Mobile booking card implementation plan — September 12, 2026

Status: implemented locally following approval. Production has not been deployed. The sections below record the accepted design and operational constraints.

September 13 update: Square launch controls and setup instructions are hidden by default at the user's request. Payment balances, history, receipts, cash/check recording, and job completion remain available under their existing permissions. Existing payment callbacks and processing are retained. To restore the mobile controls later, set `MOBILE_SQUARE_PAYMENTS_ENABLED=true` in the site environment and restart/redeploy the site. Use the same flag in the test runner and site when exercising the retained Square browser scenarios; the provider's existing backend enablement is separate.

The new view is enabled by default in this code. Set `MOBILE_BOOKING_CARDS_V2_ENABLED=false` in the site environment to use the previous online card and completion presentation. The additive calendar fields remain compatible with either renderer; there is no database migration. The offline job list uses the compact card and accepts older snapshots without category or partner fields.

Local verification commands:

- `corepack pnpm test:mobile-booking-cards` checks narrow-phone rendering, keyboard and browser navigation, saved totals/crew/hours, draft recovery, version conflicts, uncertain retries, and server-action contracts.
- `corepack pnpm test:mobile-booking-page` runs the actual Next mobile page in a disposable site copy against a loopback mock API. It covers Today, Schedule, Messages, note/completion mutations, and completed grouping, without copying local environment files or contacting production.
- API identity tests cover all saved categories, partner source precedence, missing/duplicated enrichment, and the bounded lookup fallback. Existing completion-total, idempotency, and Square-return contracts also remain part of verification.

Device-specific camera capture, background uploads, and a real Square handoff still need a physical-phone rollout check. Local mocks do not establish real provider connectivity or database deployment readiness. Completion remains an online server-confirmed action; only drafts and existing photo queues persist locally.

Validation recorded on September 12: API and site type checks passed; changed application files passed scoped lint and formatting. The combined mobile suite passed 26 tests, including 12 browser recovery scenarios and a server-action harness with 40 runtime checks. Five focused API suites passed 105 tests. The actual Next page passed the loopback-API journey at 390px and 320px. The full database-backed end-to-end suite was not run. Broader repository checks have existing unrelated failures in the calendar source-contract test (an obsolete desktop prop-order expectation) and the quote zoom test's accessibility-state type; these were left outside this change.

The goal is to help crews identify a booking, reach its everyday actions and finish the job with less scrolling and repeated entry. Every new reminder or display field is optional. The redesign must add zero new conditions for completing a job.

1. **Give every booking a clear identity.**

   Display three separate pieces of information: service category, appointment status, and partner affiliation. A moving job should read “Moving” with a separate “Confirmed” status, instead of combining both into one badge.

   | Existing service value | Mobile label    |
   | ---------------------- | --------------- |
   | `junk_removal`         | Junk Removal    |
   | `demolition`           | Demo            |
   | `moving`               | Moving          |
   | `land_clearing`        | Land Clearing   |
   | `rental_dumpster`      | Dumpster Rental |

   These labels change presentation only. Keep the stored service values, prices, payout rules and integrations intact. Show “In-person quote” as the appointment purpose, independently of the service and status. External calendar entries retain “Calendar event.”

   Use a valid saved service type first, including the existing legacy load-size fallback. Partner bookings sometimes store their service only in the linked partner booking, so also support reviewed mappings from that service key. For unmapped services, use the authorized catalog label or “Job.” Never guess a category from a name, price or work description. For example, “demo hauloff” must not automatically become demolition work.

   Missing category data creates no crew task, warning badge or required selection. An unknown category must not prevent the card from rendering or its actions from working.

2. **Add a slim Partner banner.**

   Put “Partner” or “Partner · Company name” in one narrow strip at the top of the booking card. Keep it visible when the card is closed and after the job is complete. Use a quiet, distinct accent rather than a warning color or a large company logo.

   Planning assumption: show the banner when the booking itself is linked to a partner booking or partner account. A customer’s partner relationship alone is a separate case. If the desired policy is to label every booking for a partner customer, change the display rule using the separate contact affiliation data; this must not change billing or job behavior.

   Resolve the affiliation from the linked partner booking first, then an appointment-bound account. A verified legacy partner booking without an account still gets a generic Partner banner. If saved account links conflict, avoid naming the wrong company; retain a generic banner and record the inconsistency for staff review. Do not infer partnership from a company name, referral note, email domain, or prospect status.

   The banner is informational. It never changes who receives a message, who pays, proof requirements, permissions or commissions. Partner information must be limited to what the current staff member is allowed to see.

3. **Use a compact card and one focused job view.**

   The closed card shows the time, status, customer, category, address, optional Partner strip and a brief useful service detail when trustworthy saved data exists. The main open action is labeled “Open job.” Remove the competing “Show details” label.

   Example using fictional information:

   ```text
   Partner · Oak Property Management
   9:00–10:00 AM                 Confirmed
   Demo · Jordan Smith
   123 Oak Street               Directions
   Deck removal · Haul away

   [ Call ]   [ Message ]   [ Open job ]
   ```

   The address itself remains the directions link; do not add a second Map control. Allow long addresses, names and labels to wrap where needed. Do not enforce a fixed card height that cuts off useful information.

   Move the full, unchanged work description to the first section of the open job view. Keep existing identifiable access instructions or exclusions prominent there. Do not create an AI summary, silently discard instructions, or require crews to write a new summary. A preview is only an aid; the full agreed work remains immediately accessible. Existing tests that require the entire description on the closed card must be deliberately updated to verify complete text in the open view.

   Show one compact attention line only when relevant, such as “Payment needs review” or “Upload failed.” Put routine photo counts and processing totals in Photos. Consolidate money into one readable line and avoid showing the same total in several badges. If multiple issues exist, show the most urgent and a clearly labeled route to the rest; do not lose any issue information.

   Opening a job presents a full-height mobile panel with the customer and category at the top, the work details immediately below, and a close/back control that returns to the same date and scroll position. Maintain a stable appointment link so browser Back, refresh, messages and payment returns restore the correct job. Keep only one active job view mounted, with drafts stored outside that view before it can unmount.

4. **Put frequent actions in consistent places.**

   | Action                                                        | Placement and behavior                                                                                                |
   | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
   | Directions                                                    | Linked address on the closed card and open job view. For Moving, clearly label pickup and destination inside the job. |
   | Call / Message                                                | Compact card actions using existing authorized contact and conversation routing. Opening a message must not send one. |
   | Take photo                                                    | Near the top of the open job, before the photo gallery. Reuse existing capture and upload behavior.                   |
   | Add note                                                      | Beside the photo action in the open job; existing notes remain easy to find.                                          |
   | Finish job                                                    | A prominent bottom action in the open job, opening the compact completion review.                                     |
   | Payment                                                       | One section showing amount due and the appropriate existing collection action.                                        |
   | Reschedule, cancel, corrections, photo management and history | A clearly labeled More menu, respecting existing permissions.                                                         |

   The More menu reduces visible controls; it does not delete working capabilities. Keep action availability consistent between Today and Schedule wherever permissions and job state allow. Do not add arrival buttons, tracking stages, mandatory start/stop timers, repeated acknowledgements, signatures or a new job-status workflow.

   Use one bottom action area in the focused job view so navigation and Finish job do not compete or cover content. Account for the phone keyboard and safe area. Buttons retain text labels, visible focus and generous tap areas. Target at least 44 by 44 CSS pixels for controls, following [W3C touchscreen target guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-enhanced.html). Allow zoom and larger text; review the current viewport restriction rather than shrinking text to fit.

5. **Make completion a short review with no new barriers.**

   Finish job opens one review screen, with the existing total and selected crew already shown. Use Change total and Change crew to expand editing only when needed. Collapsed editors must retain saved submission values and must not leave hidden invalid inputs that stop browser submission. Unchanged valid data must submit directly. Keep Moving rates and hours attached to their correct crew members; prefer hours and minutes in the interface while retaining the existing minute-based values and calculations. Never invent a price, crew member, time, rate or proof exception.

   Show payment status here, but payment and work completion remain separate. A paid booking is not automatically completed, and completion must not silently collect money. Preserve the current optional review-message choice with no automatic opt-in.

   New photo suggestions, notes, category information, partner labels and review reminders must have no mandatory acknowledgement. The normal Finish job action remains available when these new items are empty, ignored, loading or unavailable. Do not add a separate “skip checklist” step; skipping optional material must require no extra work.

   Implement this rule across the browser and server: no new `required` fields, completion preconditions, validation-dependent disabled buttons, mandatory reasons, or approval checks for any of these additions. An optional gallery, banner, reminder or metadata request cannot become a dependency of completion. Optional reminder errors must not prevent the existing completion request.

   There are already completion constraints in the current system. Regular job completion needs a final total and crew; Moving also needs valid rates and hours. The existing work-description rule can also prevent completion where applicable. Some partner jobs need their existing proof policy satisfied or the existing authorized exception. Permissions, stale-record checks, payment conflicts and locked payout periods also remain in force. This redesign does not claim those existing rules disappear. Reusing saved values and surfacing precise existing errors should make them easier to handle without creating additional rules.

   Hide the generic proof-exception form from ordinary jobs. Present it contextually for actual partner proof issues, retaining its current permission and reason rules. Keep the existing authorized exception reachable if optional proof-status loading fails. Never treat ordinary photo totals, uploaded gallery images or device-queued photos as proof-policy compliance: partner proof has its own authoritative evidence linkage.

   If the server rejects a completion under an existing rule, retain every typed value, show the specific problem and allow retry in place. Keep duplicate-submit protection. Preserve the submitted request key, payload and booking version while resolving an uncertain result; restoring a draft must not create a fresh completion request or reuse an old key with changed data. Only show “Job completed” after the server confirms it. Optional reminders must not create automatic customer messages or new background follow-up jobs.

6. **Make Today easier for crews to use.**

   Default crew members who can read appointments to Today; preserve explicit links to other permitted screens. Keep the existing appropriate start experience for office, sales and owner roles.

   Replace the large boxes above the bookings with a compact date selector and one line such as “5 jobs · 2 finished · 3 remaining.” Remove duplicate Inbox/Calendar shortcuts from this area. Keep manager-oriented totals accessible in the appropriate view.

   Show remaining jobs in scheduled order, highlight the next scheduled job without inventing an in-progress state, and place completed jobs in an expandable group below. Keep canceled bookings accessible in Schedule/history. Completed bookings with payment or upload issues must remain discoverable through a compact attention count. Completing a job must not abruptly move the user while they are reading its result; regroup after they return to the list.

   Use Today, Schedule, Messages and More as the primary crew navigation, showing only permitted destinations. Move less frequent tools into More. Keep the selected date and list position when opening and closing a booking. Date headings must correctly describe the selected day rather than always saying Today.

   Do not introduce required assignments or silently narrow the visible schedule. If reliable crew assignments are available, they can support an optional My crew filter later; they are not a prerequisite for this redesign.

7. **Protect drafts and existing offline behavior.**

   Keep completion entries and notes when closing a job, switching cards, refreshing, opening Messages, returning from Square or retrying a failed save. Store drafts by employee and appointment, including the booking version they were based on. Restore them without overwriting newer server data; preserve existing conflict handling and let the user review changed fields.

   Use a small shared draft layer outside the open panel. Follow the existing per-employee IndexedDB/storage conventions where suitable, with identity isolation, clear/logout behavior and bounded retention. Persistence is best effort; do not imply it is encrypted or guaranteed. Do not store payment card numbers or payment credentials. If local persistence fails, retain the current session’s entries, show the limitation accurately and leave core actions usable.

   Preserve existing offline photo bytes, queues, retries and snapshot compatibility. Add category and partner display data as optional snapshot fields; an old saved job must remain readable without clearing local storage. Reuse the same identity presentation in the offline job list.

   Use precise feedback: “Draft saved on this phone,” “Photo uploading,” “Photo uploaded,” and “Job completed.” Today, offline completion is not a supported mutation queue. Keep draft recovery distinct from server-confirmed completion, and do not introduce automatic replay of completion, payment or customer-message actions as part of this UI work.

8. **Implement the shared data and components once.**

   | Area                                                                                                        | Planned change                                                                                                                                                                                                           |
   | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | `apps/api/app/api/admin/calendar/feed/route.ts`                                                             | Add optional category, partner affiliation and authorized action/contact metadata using bounded joins or batched reads. Return one record per appointment; no per-card requests. Preserve existing permission filtering. |
   | Small API presentation helper                                                                               | Resolve category and affiliation with explicit source precedence and tested fallbacks. Keep contact-only affiliation distinct from a partner booking. No schema mutation or operational enum changes for labels.         |
   | `apps/site/src/app/mobile/page.tsx`                                                                         | Extend CalendarEvent, both card call sites and offline snapshot mapping; simplify Today; extract duplicated booking action composition.                                                                                  |
   | `MobileAppointmentCard.tsx` and `mobile-appointment-card-styles.ts`                                         | Compact identity layout, independent category/status, Partner strip, attention line and consistent open action.                                                                                                          |
   | `MobileAppointmentDetail.tsx` and a shared mobile job-view component                                        | Focused job view, direct actions, full work details, accessible close/back behavior and stable job links.                                                                                                                |
   | `MobileQuotedWorkPanel.tsx`                                                                                 | Move camera access above the gallery, make labels work for all service types, and keep management controls under More.                                                                                                   |
   | Completion form extracted from `page.tsx`, `MobileCompletionFinalTotalFields.tsx`, `MobilePaymentPanel.tsx` | Compact review, one money summary, saved-value confirmation, optional reminders and precise save feedback. Reuse existing mutations.                                                                                     |
   | `actions.ts`, `payment-return/routing.ts`, message/conversation return links                                | Preserve appointment/date/screen context across actions and provider returns; adapt status/note error handling for retry in place with retained drafts and request identity. Keep business validation intact.            |
   | `CrewPayoutSelector.tsx` / mobile wrapper                                                                   | Show selected crew first through a mobile-specific presentation option. Preserve desktop behavior and existing calculation/parsing contracts.                                                                            |
   | `mobile-appointment-summary.ts`                                                                             | Preserve immediate scope/payment/media updates; extend only if needed for new display metadata changes.                                                                                                                  |
   | Draft helper, `lib/offline-media.ts`, `MobileOfflineRuntime.tsx`, `offline/page.tsx`                        | Scoped draft recovery and backward-compatible category/banner snapshots. Keep uploads independent of the open panel.                                                                                                     |
   | `layout.tsx`                                                                                                | Review zoom and keyboard/safe-area behavior for the new panel.                                                                                                                                                           |

   Partner-service and company lookups must not make the calendar unusable when optional enrichment fails. Use a bounded lookup budget, safe generic fallbacks and internal diagnostics; avoid creating a second business-data source. Do not wait for photos, payment history or optional checklist data before displaying the booking’s essential information.

   Source findings: the existing card embeds Moving in status; other categories already exist in bookingDetails; canonical partner bookings can store category only in `partnerBookings.serviceKey`; the current mobile feed and offline snapshots do not expose partner affiliation. The completion form currently lives after multiple collapsed sections, and its browser/action/API validations already contain the rules described above.

9. **Ship in small, reversible phases.**

   | Phase                      | Deliverable                                                                                                     | Release condition                                                                             |
   | -------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
   | 1. Identity                | Category resolver, Partner data, labels and slim banner in the existing card and offline snapshot.              | Known, legacy and partner-only service cases render correctly; actions behave as before.      |
   | 2. Card and actions        | Compact card, focused job view, camera placement, shared Today/Schedule actions and session draft preservation. | Direct actions, Back, scrolling, full instructions and per-job drafts work on phones.         |
   | 3. Completion              | Compact saved-value review and optional reminders; contextual existing proof handling.                          | Same completion eligibility as before, no new blockers, no duplicate writes or money changes. |
   | 4. Navigation and recovery | Crew Today default, compact day overview, completed grouping and persistent draft recovery.                     | Permissions, payment returns, offline photos, old snapshots and draft restoration all pass.   |

   Keep the previous renderer behind a mobile presentation switch during rollout. Introduce optional read fields before the UI consumes them, and keep old/new versions compatible. Test with seeded internal jobs and real phones before enabling the new view for daily work. Roll back the presentation if actions become inaccessible or completion errors increase; preserve accepted changes, saved drafts and queued photos. Avoid a database cleanup or destructive migration in these phases.

10. **Verify the behaviors that affect daily operations.**
    - Identity: all five service categories, unknown/malformed legacy data, partner services without bookingDetails, null or conflicting partner links, partner-contact-only bookings, long company names, quotes and external calendar events.
    - Availability: new reminders absent, skipped, hidden or failed; category/partner lookup failure; slow or failed galleries. All otherwise-valid existing completion actions must still work.
    - Existing completion: saved crew, changed crew, zero total, changed total, Moving hours/rates, unpaid jobs, completed-job corrections, valid/missing partner proof, authorized exceptions and limited permissions.
    - Recovery: close/reopen, switch jobs, refresh, Messages/Square return, failed save, lost response, duplicate tap, stale booking and a different employee on the same device. No lost or mixed drafts and no duplicate effects.
    - Offline: cached jobs and photos remain usable, queued photos stay recoverable, old snapshots render, local-storage failure is honest, and no false completion/payment success is shown.
    - Mobile layout: narrow phones, long text, large text/zoom, keyboard, touch targets, focus, screen-reader labels and bottom controls that do not cover fields.
    - Shared behavior: Today, Schedule and offline identity match; desktop booking, payment and payout workflows retain their current behavior.

    Extend the existing mobile appointment workflow, role-gating, payment/payout and contact-thread browser suites. Reuse the appointment status, final-total, idempotency, external-effects, partner-proof and crew-payout tests for business behavior. Adjust tests that intentionally assert the old card presentation or component location; retain their meaningful workflow assertions. Run the affected type checks, lint and focused suites once the implementation exists.

    Capture a baseline before rollout, then compare taps to directions/camera/completion, scrolling needed to finish, lost-draft reports, completion-error rate and duplicate actions. Targets are one tap to directions from the card, camera access without gallery scrolling, one tap to completion review from the open job, a direct Finish job action when existing data is valid, zero added requirements and zero draft loss in the tested recovery cases. Timing or speed improvements remain targets until measured.

    The design approach of keeping frequent actions visible and secondary controls available on demand follows [Nielsen Norman Group’s guidance on progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/). These are proposed changes; implementation tests and production verification have not been run for this plan.
