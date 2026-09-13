import React from "react";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  loadInboxConversation,
  loadInboxList,
  type InboxInput,
} from "../inbox-loader";
import { InboxView } from "./InboxView";

/** Essential reads only: optional tools cannot delay this conversation. */
export async function InboxSection(
  input: InboxInput,
): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const read = (path: string) => callAdminApiAs(principal, path);
  const [list, conversation] = await Promise.all([
    loadInboxList(input, read),
    loadInboxConversation(input, read),
  ]);
  return (
    <InboxView
      input={input}
      access={{
        employeeId: principal.memberId,
        canSend: hasTeamPermission(principal, "messages.send"),
        canDraft: hasTeamPermission(principal, "messages.write"),
        canEditContact: hasTeamPermission(principal, "contacts.write"),
        canPlaceCalls: hasTeamPermission(principal, "calls.place"),
        canReadContacts: hasTeamPermission(principal, "contacts.read"),
      }}
      list={list}
      conversation={conversation}
    />
  );
}
