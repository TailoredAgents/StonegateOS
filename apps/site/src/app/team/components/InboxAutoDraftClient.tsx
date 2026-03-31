"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

function getComposeTextarea(): HTMLTextAreaElement | null {
  const node = document.getElementById("inbox-thread-body");
  return node instanceof HTMLTextAreaElement ? node : null;
}

function isComposeDirty(): boolean {
  const textarea = getComposeTextarea();
  return Boolean(textarea?.value?.trim().length);
}

function isComposeFocused(): boolean {
  const textarea = getComposeTextarea();
  return Boolean(textarea && document.activeElement === textarea);
}

type Props = {
  threadId: string | null;
  channel: "sms" | "email" | "dm";
  latestInboundAt: string | null;
  latestOutboundAt: string | null;
  latestAiDraftAt: string | null;
};

export function InboxAutoDraftClient({
  threadId,
  channel,
  latestInboundAt,
  latestOutboundAt,
  latestAiDraftAt,
}: Props): React.ReactElement | null {
  const router = useRouter();
  const inFlightRef = React.useRef(false);

  React.useEffect(() => {
    if (!threadId || !latestInboundAt) return;
    if (isComposeDirty() || isComposeFocused()) return;

    const inboundMs = Date.parse(latestInboundAt);
    if (!Number.isFinite(inboundMs)) return;

    const outboundMs = latestOutboundAt ? Date.parse(latestOutboundAt) : Number.NaN;
    if (Number.isFinite(outboundMs) && outboundMs >= inboundMs) return;

    const aiDraftMs = latestAiDraftAt ? Date.parse(latestAiDraftAt) : Number.NaN;
    if (Number.isFinite(aiDraftMs) && aiDraftMs >= inboundMs) return;

    if (inFlightRef.current) return;
    inFlightRef.current = true;

    void (async () => {
      try {
        const response = await fetch(`/api/team/inbox/threads/${encodeURIComponent(threadId)}/suggest`, {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({ auto: true, channel }),
        });
        const payload = (await response.json().catch(() => null)) as
          | { ok?: boolean; created?: boolean }
          | null;
        if (response.ok && payload?.ok && payload.created === true) {
          router.refresh();
        }
      } catch {
        // ignore auto-draft failures
      } finally {
        inFlightRef.current = false;
      }
    })();
  }, [threadId, channel, latestInboundAt, latestOutboundAt, latestAiDraftAt, router]);

  return null;
}
