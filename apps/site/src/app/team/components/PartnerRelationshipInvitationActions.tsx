"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { managePartnerRelationshipInvitation } from "../actions/partner-relationships";
import { teamButtonClass } from "./team-ui";

export function PartnerRelationshipInvitationActions({
  accountId,
  invitationId,
  etag,
  actions,
}: {
  accountId: string;
  invitationId: string;
  etag: string;
  actions: Array<"resend" | "revoke">;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [completed, setCompleted] = useState(false);
  const operation = useRef<{ signature: string; key: string } | null>(null);
  async function run(action: "resend" | "revoke") {
    if (busy || completed) return;
    setBusy(true);
    setMessage("");
    const signature = invitationId + ":" + etag + ":" + action;
    if (operation.current?.signature !== signature)
      operation.current = {
        signature,
        key: "staff-partner-invitation:" + crypto.randomUUID(),
      };
    const result = await managePartnerRelationshipInvitation({
      accountId,
      invitationId,
      etag,
      action,
      operationKey: operation.current.key,
    });
    setBusy(false);
    setMessage(result.message);
    if (result.ok) {
      setCompleted(true);
      router.refresh();
    }
  }
  return (
    <div className="mt-4 space-y-2">
      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <button
            key={action}
            type="button"
            disabled={busy || completed}
            onClick={() => void run(action)}
            className={teamButtonClass("secondary", "sm")}
          >
            {busy
              ? "Working…"
              : action === "resend"
                ? "Send a new invitation"
                : "Revoke invitation & setup"}
          </button>
        ))}
      </div>
      {message ? (
        <p role="status" className="text-sm">
          {message}
        </p>
      ) : null}
    </div>
  );
}
