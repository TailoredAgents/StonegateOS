"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { createPortalOperationKey, partnerPortalFetch } from "../lib/portal-v2";
import { PartnerNotice, partnerSecondaryButtonClass } from "./PartnerPortalUi";

export function PartnerRescheduleRequestActions({
  jobId,
  requestId,
  etag,
  canWithdraw,
}: {
  jobId: string;
  requestId: string;
  etag: string;
  canWithdraw: boolean;
}) {
  const router = useRouter();
  const key = useRef(createPortalOperationKey("reschedule-withdraw"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const withdraw = async () => {
    if (
      !window.confirm(
        "Withdraw this time-change request and keep your current schedule?",
      )
    )
      return;
    setBusy(true);
    setError(null);
    const result = await partnerPortalFetch(
      `jobs/${jobId}/reschedule-requests/${requestId}/withdraw`,
      {
        method: "POST",
        headers: { "Idempotency-Key": key.current, "If-Match": etag },
      },
    );
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    router.refresh();
  };
  return (
    <PartnerNotice tone="warning">
      <p>
        A time-change request is awaiting Stonegate review. Your current arrival
        window remains scheduled.
      </p>
      {error ? (
        <p role="alert" className="mt-2">
          {error}
        </p>
      ) : null}
      {canWithdraw ? (
        <button
          type="button"
          className={`${partnerSecondaryButtonClass} mt-3`}
          disabled={busy}
          onClick={() => void withdraw()}
        >
          {busy ? "Withdrawing…" : "Keep current schedule"}
        </button>
      ) : null}
    </PartnerNotice>
  );
}
