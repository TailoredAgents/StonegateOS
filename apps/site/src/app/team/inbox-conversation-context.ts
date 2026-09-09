type ExternalInboxChannel = "sms" | "email" | "dm";

export function resolveInboxConversationContext(input: {
  activeThread: {
    channel: string;
    contact: { id: string } | null;
    partnerJob?: { accountId: string; jobId: string } | null;
  } | null;
  requestedChannel: ExternalInboxChannel | null;
  requestedContactId: string | null;
}): {
  isPartnerConversation: boolean;
  requestedChannel: ExternalInboxChannel | "web";
  activeContactId: string | null;
} {
  const thread = input.activeThread;
  // Explicit account/job context is authoritative for portal conversations.
  // An unrelated CRM contact/channel in the URL cannot remap that history.
  if (thread?.partnerJob) {
    return {
      isPartnerConversation: true,
      requestedChannel: "web",
      activeContactId: null,
    };
  }
  const channel = thread?.channel;
  return {
    isPartnerConversation: false,
    requestedChannel:
      input.requestedChannel ??
      (channel === "sms" || channel === "email" || channel === "dm"
        ? channel
        : "sms"),
    activeContactId: input.requestedContactId ?? thread?.contact?.id ?? null,
  };
}
