# Easier partner service confirmation

The owner identified choosing the date and confirming service as the awkward part of the opened CRM request. This tuning pass makes each client-requested date selectable, preserves the explicit planned start time, and shows a clear result after the saved request is refreshed.

## Result

The scheduling panel shows date buttons with the client's time preference on a separate line. Selecting a button updates the actual submitted date, highlights the selection, focuses Planned start time, and refreshes the arrival preview. The button's wording deliberately promises only to fill the date. It does not guess a time from “morning” or “afternoon,” claim availability, reserve capacity, or submit the request. Dates requested in another explicit time zone remain visible with instructions for entering the matching Eastern date.

Manual and shortcut edits both mark the request as having unsaved changes. The confirmation button requires a matching successful arrival preview. Schedule controls cannot change during submission. Existing permission, approval, resource, capacity, version, and retry protections remain in the canonical scheduling flow.

After confirmation, the screen reloads the saved request and focuses its scheduling result. Confirmed, in-progress, and completed jobs have distinct headings. The confirmed arrival window appears once prominently, and Open in calendar selects that appointment on its scheduled day. Original scheduling details remain available in an expandable section. Pending or client-approval-blocked work is never described as confirmed.

Supporting details use explicit Call and Email actions, including an email-only contact. Repeated contact-name and PO prefixes were removed from review summaries. Verified empty optional photo/requirement sections take no space, while required or unknown proof values, actual supplied data, permission restrictions, and load errors remain visible. Existing Calendar and Mobile booking-card presentation remains unchanged.

## Validation and rollout

Validation and exact-source release evidence are recorded below after the required production journey and deployment complete. This release changes Site presentation only; it does not require API/worker changes or another owner test message.
