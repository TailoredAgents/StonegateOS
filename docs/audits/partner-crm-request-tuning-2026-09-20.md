# Easier partner service confirmation

The owner identified choosing the date and confirming service as the awkward part of the opened CRM request. This tuning pass makes each client-requested date selectable, preserves the explicit planned start time, and shows a clear result after the saved request is refreshed.

## Result

The scheduling panel shows date buttons with the client's time preference on a separate line. Selecting a button updates the actual submitted date, highlights the selection, focuses Planned start time, and refreshes the arrival preview. The button's wording deliberately promises only to fill the date. It does not guess a time from “morning” or “afternoon,” claim availability, reserve capacity, or submit the request. Dates requested in another explicit time zone remain visible with instructions for entering the matching Eastern date.

Manual and shortcut edits both mark the request as having unsaved changes. The confirmation button requires a matching successful arrival preview. Schedule controls cannot change during submission. Existing permission, approval, resource, capacity, version, and retry protections remain in the canonical scheduling flow.

After confirmation, the screen reloads the saved request and focuses its scheduling result. Confirmed, in-progress, and completed jobs have distinct headings. The confirmed arrival window appears once prominently, and Open in calendar selects that appointment on its scheduled day. Original scheduling details remain available in an expandable section. Pending or client-approval-blocked work is never described as confirmed.

Supporting details use explicit Call and Email actions, including an email-only contact. Repeated contact-name and PO prefixes were removed from review summaries. Verified empty optional photo/requirement sections take no space, while required or unknown proof values, actual supplied data, permission restrictions, and load errors remain visible. Existing Calendar and Mobile booking-card presentation remains unchanged.

## Validation and rollout

Validation and exact-source release evidence are recorded below after the required production journey and deployment complete. The design work changes Site presentation. During live preflight, suspicious command-execution and credential-file-read errors required a separate framework security patch before deployment. The owner confirmed no known authorized security test and explicitly approved taking the public website, Partner Portal, and CRM offline until patched. Site suspension was accepted at 2026-09-21T00:15:59Z and verified suspended with a 503 response at 00:16:22Z.

The combined release now updates all workspace copies of Next.js to 15.5.24, React/React DOM to 19.1.5, and Sharp to 0.35.4. The lockfile contains no old 15.5.5 or 19.1.0 copies. This follows the [maintained Next.js security release](https://nextjs.org/blog/august-2026-security-release), [RSC advisory](https://nextjs.org/blog/CVE-2025-66478), and [Sharp advisory](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c). API and Site typechecks and synthetic image processing passed; the targeted package audit reports no Next/React/RSC/Sharp findings. Unrelated dependency audit findings are outside this bounded patch.

The suspicious logs are incident evidence, not proof that data was or was not accessed. Patching does not replace credential rotation and incident follow-up. Relevant raw logs were preserved outside the repository in a restricted local file. No credentials or customer access codes are included in this document. API/worker/Site deployment and any authorized credential changes must be recorded separately below; no additional owner test text is part of this release.
