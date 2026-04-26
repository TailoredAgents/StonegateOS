# Mobile UX Audit

Date: 2026-04-26

## Fixed In Current Pass

- Booking from a message thread now has a property/address path.
- Full addresses in recent thread messages are detected and prefilled into booking.
- New booking addresses are saved back to the contact before the appointment is created.
- Inbox refreshes automatically while open and when the phone returns to the app.
- Bottom navigation uses shorter labels and tighter sizing to avoid overlap.
- Open Tasks is hidden from My Day until there is a useful inbox/task cleanup workflow.
- My Day and Calendar now support marking quote visits done and jobs complete.
- Duplicate Jeffrey team records were consolidated into one active Jeffrey account.

## Quote Workflow Decision

Creating a quote is useful when the customer needs a written price before they commit, when photos need a formal estimate, or when Devon needs to send a clean price without booking yet.

It does not currently book an appointment by itself. The best next version is a `Book from quote` action that carries over the contact, property, quoted total, and notes into a scheduled job.

## Highest-Value Next Features

- `Book from quote`: one tap to turn an accepted quote into a job.
- Inbox `Done/Snooze`: messages leave the active inbox after a clear rule, such as done for 24 hours.
- Message send state: show sending/sent/failed inline instead of only refreshing the thread.
- Job checklist: arrival photo, before photo, after photo, receipt, final amount, complete.
- Fast customer card: call, text, map, book, quote, note in one compact action row.
- Day route view: today’s stops ordered by time with map buttons and projected total.
- Follow-up reminders from quote visits: if a quote visit is marked done but not booked, prompt for a follow-up date.
- Contact duplicate warnings on mobile when a phone/email already exists.
- Owner-only daily closeout: completed jobs, collected amount, missing receipts/photos, failed sends.
- Real push notifications later if polling and existing Twilio alerts are not enough.

## UX Rules Going Forward

- Keep Inbox, Today, Calendar, and Contacts as the fastest paths.
- Avoid showing owner/revenue data to sales beyond the projected day amount.
- Put destructive actions behind clear labels and keep completion flows explicit.
- Do not bring back Open Tasks until tasks have a clear lifecycle and disappear from the active work view.
- Prefer one-screen forms with sensible defaults over hidden desktop-style configuration.
