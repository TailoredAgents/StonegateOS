import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TeamMutationFailure } from "@/lib/team-mutation";
import { notificationOperationDedupeKey } from "@/lib/notifications";
import { normalizeSystemOutboundDedupeKey } from "@/lib/system-outbound";

const source = readFileSync(
  resolve(__dirname, "../lib/system-outbound.ts"),
  "utf8",
);

describe("system outbound idempotency", () => {
  it("accepts bounded stable operation keys and normalizes surrounding space", () => {
    expect(
      normalizeSystemOutboundDedupeKey(
        "  estimate.confirmation:appointment-id:event-id:sms  ",
      ),
    ).toBe("estimate.confirmation:appointment-id:event-id:sms");
    expect(normalizeSystemOutboundDedupeKey(undefined)).toBeNull();
    expect(normalizeSystemOutboundDedupeKey(null)).toBeNull();
  });

  it("deduplicates one worker retry but distinguishes later real transitions", () => {
    const base = "estimate.confirmation:appointment-id:rescheduled";
    const first = notificationOperationDedupeKey(base, "outbox-event-one");

    expect(notificationOperationDedupeKey(base, "outbox-event-one")).toBe(
      first,
    );
    expect(notificationOperationDedupeKey(base, "outbox-event-two")).not.toBe(
      first,
    );
  });

  it.each([
    "",
    "short",
    "contains spaces in the key",
    `system:${"x".repeat(241)}`,
    "system:key:with/slash",
  ])("rejects an unsafe operation key: %j", (value) => {
    expect(() => normalizeSystemOutboundDedupeKey(value)).toThrow(
      TeamMutationFailure,
    );
  });

  it("serializes contact/channel selection before resolving a thread", () => {
    const lock = source.indexOf("pg_advisory_xact_lock");
    const dedupeLookup = source.indexOf(".innerJoin(", lock);
    const threadSelection = source.indexOf(
      "await ensureThreadForContactChannel",
      dedupeLookup,
    );

    expect(lock).toBeGreaterThan(0);
    expect(dedupeLookup).toBeGreaterThan(lock);
    expect(threadSelection).toBeGreaterThan(dedupeLookup);
    expect(source).toContain(
      "system-outbound:${input.contactId}:${input.channel}",
    );
  });

  it("deduplicates across every thread for the same contact and channel", () => {
    expect(source).toContain(
      "eq(conversationThreads.id, conversationMessages.threadId)",
    );
    expect(source).toContain(
      "eq(conversationThreads.contactId, input.contactId)",
    );
    expect(source).toContain("eq(conversationThreads.channel, input.channel)");
    expect(source).toContain(
      "sql`${conversationMessages.metadata} ->> 'dedupeKey' = ${dedupeKey}`",
    );
    expect(source).not.toContain("eq(conversationMessages.threadId, threadId)");
  });
});
