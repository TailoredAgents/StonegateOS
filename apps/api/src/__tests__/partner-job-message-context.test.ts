import { createHash } from "node:crypto";
import { sendStaffPartnerJobMessageInTransaction } from "@/lib/partner-job-communication";
import type {
  TeamMutationContext,
  TeamMutationTransaction,
} from "@/lib/team-mutation";

jest.mock("@/lib/partner-portal-v2-media", () => ({
  loadReadyPartnerJobMessageAttachments: jest.fn(),
}));
jest.mock("@/lib/partner-notification-delivery", () => ({
  queuePartnerJobAudienceNotification: jest.fn(),
}));

const mutation = {
  actor: { id: "staff-1" },
  idempotencyKeyHash: "a".repeat(64),
} as TeamMutationContext;
const legacyInput = {
  threadId: "thread-1",
  audience: "partner" as const,
  body: "Job update",
  attachmentIds: [],
  mutation,
};
function setup(
  options: {
    thread?: Record<string, unknown>;
    fingerprint?: { expectedContactId: string | null; channel: string };
  } = {},
) {
  const requestHash = createHash("sha256")
    .update(
      JSON.stringify({
        threadId: legacyInput.threadId,
        audience: legacyInput.audience,
        body: legacyInput.body,
        attachmentIds: legacyInput.attachmentIds,
        ...options.fingerprint,
      }),
    )
    .digest("hex");
  const replies = [
    [
      {
        id: "thread-1",
        partnerAccountId: "account-1",
        partnerBookingId: "job-1",
        contactId: null,
        channel: "web",
        ...options.thread,
      },
    ],
    [{ id: "job-1", accountEnabled: true }],
    [
      {
        id: "message-1",
        direction: "outbound",
        deliveryStatus: "delivered",
        createdAt: new Date("2026-09-13T12:00:00Z"),
        metadata: { requestHash, staffActorId: "staff-1" },
      },
    ],
  ];
  const query = {
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    for: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    leftJoin: jest.fn().mockReturnThis(),
    limit: jest.fn(() => Promise.resolve(replies.shift())),
  };
  const db = {
    select: jest.fn(() => query),
    insert: jest.fn(),
    update: jest.fn(),
  };
  return { tx: db as unknown as TeamMutationTransaction, db, query };
}

describe("partner job message expected recipient context", () => {
  it("keeps the existing no-context replay fingerprint backward compatible", async () => {
    const { tx, db } = setup();
    expect(
      await sendStaffPartnerJobMessageInTransaction(tx, legacyInput),
    ).toMatchObject({ id: "message-1", channel: "web" });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it("replays a matching bound partner message without additional writes", async () => {
    const { tx, db, query } = setup({
      fingerprint: { expectedContactId: null, channel: "web" },
    });
    expect(
      await sendStaffPartnerJobMessageInTransaction(tx, {
        ...legacyInput,
        expectedContactId: null,
        expectedChannel: "web",
      }),
    ).toMatchObject({ id: "message-1", channel: "web" });
    expect(query.for).toHaveBeenCalledWith("update");
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("does not reuse a legacy key after adding recipient context", async () => {
    const { tx, db } = setup();
    await expect(
      sendStaffPartnerJobMessageInTransaction(tx, {
        ...legacyInput,
        expectedContactId: null,
        expectedChannel: "web",
      }),
    ).rejects.toMatchObject({
      code: "conflict",
      message: "This send key belongs to a different message.",
    });
    expect(db.insert).not.toHaveBeenCalled();
  });

  it.each([
    {
      input: { expectedContactId: "other-contact", expectedChannel: "web" },
      thread: {},
    },
    { input: { expectedContactId: null, expectedChannel: "sms" }, thread: {} },
    {
      input: { expectedContactId: null, expectedChannel: "web" },
      thread: { contactId: "linked-crm-contact" },
    },
    {
      input: { expectedContactId: null, expectedChannel: "web" },
      thread: { channel: "sms" },
    },
  ])(
    "checks actual locked thread context before job/attachment reads and writes: %j",
    async ({ input, thread }) => {
      const { tx, db } = setup({ thread });
      await expect(
        sendStaffPartnerJobMessageInTransaction(tx, {
          ...legacyInput,
          ...input,
        }),
      ).rejects.toMatchObject({
        code: "conflict",
        message: "thread_context_mismatch",
        retryable: false,
      });
      expect(db.select).toHaveBeenCalledTimes(1);
      expect(db.insert).not.toHaveBeenCalled();
      expect(db.update).not.toHaveBeenCalled();
    },
  );
});
