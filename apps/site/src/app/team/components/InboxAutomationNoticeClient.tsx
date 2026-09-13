"use client";

import React from "react";

type Props = {
  contactId: string;
  channel?: string;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function concernMessage(payload: unknown, channel?: string): string | null {
  const data = asRecord(payload);
  if (data?.["ok"] !== true) return null;
  const nextAction = asRecord(data["nextAction"]);
  const autopilot = asRecord(data["autopilot"]);
  const plannerChannel = autopilot?.["channel"] ?? nextAction?.["channel"];
  const selectedChannel = channel ?? plannerChannel;
  const automation = asRecord(data["liveContext"])?.["automation"];
  const rows = Array.isArray(automation)
    ? automation
        .map(asRecord)
        .filter(
          (row) =>
            row && (!selectedChannel || row["channel"] === selectedChannel),
        )
    : [];

  if (rows.some((row) => row?.["dnc"] === true)) {
    return "Do not contact is active for this conversation.";
  }
  if (rows.some((row) => row?.["humanTakeover"] === true)) {
    return "Human takeover is active. Automation is paused.";
  }
  if (rows.some((row) => row?.["paused"] === true)) {
    return "Automation is paused for this conversation.";
  }

  // The API execution state belongs to its planner channel, which may differ
  // from the conversation staff are currently reading.
  if (channel && plannerChannel && channel !== plannerChannel) return null;
  switch (asRecord(data["executionState"])?.["code"]) {
    case "human_takeover":
      return "Human takeover is active. Automation is paused.";
    case "paused":
      return "Automation is paused for this conversation.";
    case "human_review":
      return "Automation is waiting for human review.";
    case "blocked":
      return nextAction?.["actionType"] === "do_not_contact"
        ? "Do not contact is active for this conversation."
        : "Automation is blocked for this conversation.";
    default:
      return null;
  }
}

export function InboxAutomationNoticeClient({
  contactId,
  channel,
}: Props): React.ReactElement | null {
  const identity = `${contactId}:${channel ?? ""}`;
  const [revision, setRevision] = React.useState(0);
  const [notice, setNotice] = React.useState<{
    identity: string;
    message: string | null;
  } | null>(null);

  React.useEffect(() => {
    const onUpdated = (event: Event) => {
      if (
        (event as CustomEvent<{ contactId?: string }>).detail?.contactId ===
        contactId
      )
        setRevision((value) => value + 1);
    };
    window.addEventListener("stonegate:inbox-automation-updated", onUpdated);
    return () =>
      window.removeEventListener(
        "stonegate:inbox-automation-updated",
        onUpdated,
      );
  }, [contactId]);

  React.useEffect(() => {
    const controller = new AbortController();
    setNotice(null);
    if (!contactId.trim()) return () => controller.abort();

    void (async () => {
      try {
        const response = await fetch(
          `/api/team/contacts/sales-agent-next-action?contactId=${encodeURIComponent(contactId)}`,
          {
            method: "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
            signal: controller.signal,
          },
        );
        if (!response.ok || controller.signal.aborted) return;
        const data: unknown = await response.json();
        if (controller.signal.aborted) return;
        setNotice({ identity, message: concernMessage(data, channel) });
      } catch {
        // Optional context must never interrupt reading or sending messages.
      }
    })();

    return () => controller.abort();
  }, [contactId, channel, identity, revision]);

  if (notice?.identity !== identity || !notice.message) return null;
  return (
    <p
      role="status"
      className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900"
    >
      {notice.message}
    </p>
  );
}
