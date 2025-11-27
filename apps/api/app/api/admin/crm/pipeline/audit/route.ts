import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { desc, eq, inArray } from "drizzle-orm";
import { getDb, contacts, outboxEvents } from "@/db";
import { isAdminRequest } from "../../../../web/admin";

type AuditEvent = {
  id: string;
  contactId: string | null;
  contactName: string | null;
  fromStage: string | null;
  toStage: string | null;
  reason: string | null;
  createdAt: string;
  meta?: Record<string, unknown> | null;
};

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const db = getDb();
  const rows = await db
    .select({
      id: outboxEvents.id,
      payload: outboxEvents.payload,
      createdAt: outboxEvents.createdAt
    })
    .from(outboxEvents)
    .where(eq(outboxEvents.type, "pipeline.auto_stage_change"))
    .orderBy(desc(outboxEvents.createdAt))
    .limit(50);

  const contactIds = Array.from(
    new Set(
      rows
        .map((row) => {
          const payload = row.payload as Record<string, unknown> | null;
          const contactId = payload && typeof payload["contactId"] === "string" ? payload["contactId"] : null;
          return contactId ?? undefined;
        })
        .filter((v): v is string => Boolean(v))
    )
  );

  const contactNames: Map<string, string> = new Map();
  if (contactIds.length > 0) {
    const contactsRows = await db
      .select({
        id: contacts.id,
        firstName: contacts.firstName,
        lastName: contacts.lastName
      })
      .from(contacts)
      .where(inArray(contacts.id, contactIds));

    for (const row of contactsRows) {
      const name = [row.firstName, row.lastName].filter(Boolean).join(" ").trim();
      contactNames.set(row.id, name || "Contact");
    }
  }

  const events: AuditEvent[] = rows.map((row) => {
    const payload = row.payload as Record<string, unknown> | null;
    const contactId = payload && typeof payload["contactId"] === "string" ? payload["contactId"] : null;
    const fromStage = payload && typeof payload["fromStage"] === "string" ? payload["fromStage"] : null;
    const toStage = payload && typeof payload["toStage"] === "string" ? payload["toStage"] : null;
    const reason = payload && typeof payload["reason"] === "string" ? payload["reason"] : null;
    const meta = payload && typeof payload["meta"] === "object" ? (payload["meta"] as Record<string, unknown>) : null;

    return {
      id: row.id,
      contactId,
      contactName: contactId ? contactNames.get(contactId) ?? null : null,
      fromStage,
      toStage,
      reason,
      createdAt: row.createdAt.toISOString(),
      meta
    };
  });

  return NextResponse.json({ events });
}
