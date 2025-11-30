import React from "react";
import { TeamChatClient } from "./TeamChatClient";
import { callAdminApi } from "./lib/api";

type ContactOption = {
  id: string;
  name: string;
  properties: Array<{ id: string; label: string }>;
};

export async function ChatSection(): Promise<React.ReactElement> {
  const response = await callAdminApi("/api/admin/contacts?limit=100");
  if (!response.ok) {
    throw new Error("Failed to load contacts");
  }
  const payload = (await response.json()) as {
    contacts?: Array<{
      id: string;
      name: string;
      properties: Array<{
        id: string;
        addressLine1: string;
        city: string;
        state: string;
        postalCode: string;
      }>;
    }>;
  };

  const contacts: ContactOption[] =
    payload.contacts?.map((c) => ({
      id: c.id,
      name: c.name,
      properties: c.properties.map((p) => ({
        id: p.id,
        label: `${p.addressLine1}, ${p.city}, ${p.state} ${p.postalCode}`
      }))
    })) ?? [];

  return (
    <section className="space-y-6">
      <TeamChatClient contacts={contacts} />
    </section>
  );
}

