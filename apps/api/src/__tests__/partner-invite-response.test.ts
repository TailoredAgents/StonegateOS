import {
  parsePartnerInviteSuccess,
  parsePartnerPortalAccessChangeData,
  parsePartnerPortalAccessChangeSuccess,
} from "../../../site/src/app/team/partner-page";

const ORG_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const ACTOR_ID = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const AUDIT_ID = "55555555-5555-4555-8555-555555555555";

function successPayload(): Record<string, unknown> {
  return {
    ok: true,
    data: {
      user: {
        id: USER_ID,
        orgContactId: ORG_ID,
        email: "portal@example.test",
        phone: "+1 404-555-0123",
        phoneE164: "+14045550123",
        name: "Portal User",
        active: true,
        createdAt: "2026-08-08T12:00:00.000Z",
      },
      delivery: {
        state: "succeeded",
        acceptedChannels: ["email"],
        failedChannels: ["sms"],
        uncertainChannels: [],
        providerOperationIds: ["email-message-1"],
        providerExactlyOnceClaimed: false,
      },
    },
    receipt: {
      operationId: OPERATION_ID,
      correlationId: "partner-invite-correlation",
      actorId: ACTOR_ID,
      committedAt: "2026-08-08T12:00:01.000Z",
      auditEventId: AUDIT_ID,
      entityType: "partner_user",
      entityId: USER_ID,
      providerOperationId: "email-message-1",
    },
  };
}

const expected = {
  orgContactId: ORG_ID,
  email: "portal@example.test",
  requestedChannels: ["email", "sms"] as const,
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Expected a test object.");
  }
  return value as Record<string, unknown>;
}

function user(payload: Record<string, unknown>): Record<string, unknown> {
  return record(record(payload["data"])["user"]);
}

function delivery(payload: Record<string, unknown>): Record<string, unknown> {
  return record(record(payload["data"])["delivery"]);
}

function receipt(payload: Record<string, unknown>): Record<string, unknown> {
  return record(payload["receipt"]);
}

const INVALID_MUTATIONS: Array<
  [string, (payload: Record<string, unknown>) => void]
> = [
  [
    "missing receipt",
    (payload) => {
      delete payload["receipt"];
    },
  ],
  [
    "wrong organization",
    (payload) => {
      user(payload)["orgContactId"] = ACTOR_ID;
    },
  ],
  [
    "wrong recipient",
    (payload) => {
      user(payload)["email"] = "other@example.test";
    },
  ],
  [
    "wrong entity receipt",
    (payload) => {
      receipt(payload)["entityId"] = ACTOR_ID;
    },
  ],
  [
    "uncertain channel",
    (payload) => {
      delivery(payload)["uncertainChannels"] = ["sms"];
    },
  ],
  [
    "missing requested channel",
    (payload) => {
      delivery(payload)["failedChannels"] = [];
    },
  ],
  [
    "duplicate channel",
    (payload) => {
      delivery(payload)["acceptedChannels"] = ["email", "email"];
    },
  ],
  [
    "false exactly-once claim",
    (payload) => {
      delivery(payload)["providerExactlyOnceClaimed"] = true;
    },
  ],
  [
    "unexpected field",
    (payload) => {
      delivery(payload)["delivered"] = true;
    },
  ],
];

describe("partner invite Site receipt", () => {
  it("accepts an exact, correlated terminal success", () => {
    expect(parsePartnerInviteSuccess(successPayload(), expected)).toMatchObject(
      {
        data: {
          user: { id: USER_ID, orgContactId: ORG_ID, active: true },
          delivery: {
            state: "succeeded",
            acceptedChannels: ["email"],
            failedChannels: ["sms"],
            uncertainChannels: [],
          },
        },
        receipt: {
          operationId: OPERATION_ID,
          auditEventId: AUDIT_ID,
          entityId: USER_ID,
        },
      },
    );
  });

  it.each(INVALID_MUTATIONS)("rejects %s", (_label, mutate) => {
    const payload = successPayload();
    mutate(payload);
    expect(parsePartnerInviteSuccess(payload, expected)).toBeNull();
  });
});

describe("partner portal access-change Site data", () => {
  const data = {
    userId: USER_ID,
    orgContactId: ORG_ID,
    active: false,
    version: "2026-08-08T12:00:02.000Z",
    sessionsRevoked: 2,
    tokensInvalidated: 1,
  };

  it("accepts an exact deactivation result bound to the selected user", () => {
    expect(
      parsePartnerPortalAccessChangeData(data, {
        userId: USER_ID,
        orgContactId: ORG_ID,
        active: false,
      }),
    ).toEqual(data);
  });

  it.each([
    { ...data, userId: ACTOR_ID },
    { ...data, orgContactId: ACTOR_ID },
    { ...data, active: true },
    { ...data, version: "not-a-version" },
    { ...data, sessionsRevoked: -1 },
    { ...data, tokensInvalidated: 1.5 },
    { ...data, hidden: true },
  ])("rejects malformed or mismatched deactivation data %#", (candidate) => {
    expect(
      parsePartnerPortalAccessChangeData(candidate, {
        userId: USER_ID,
        orgContactId: ORG_ID,
        active: false,
      }),
    ).toBeNull();
  });

  it("requires activation to restore zero old sessions and links", () => {
    expect(
      parsePartnerPortalAccessChangeData(
        { ...data, active: true, sessionsRevoked: 0, tokensInvalidated: 0 },
        { userId: USER_ID, orgContactId: ORG_ID, active: true },
      ),
    ).not.toBeNull();
    expect(
      parsePartnerPortalAccessChangeData(
        { ...data, active: true, sessionsRevoked: 1, tokensInvalidated: 0 },
        { userId: USER_ID, orgContactId: ORG_ID, active: true },
      ),
    ).toBeNull();
  });
});

describe("partner portal access-change request-bound receipt", () => {
  function accessPayload(): Record<string, unknown> {
    const committedAt = new Date().toISOString();
    return {
      ok: true,
      data: {
        userId: USER_ID,
        orgContactId: ORG_ID,
        active: false,
        version: committedAt,
        sessionsRevoked: 2,
        tokensInvalidated: 1,
      },
      receipt: {
        operationId: OPERATION_ID,
        correlationId: "partner-access-correlation",
        actorId: ACTOR_ID,
        committedAt,
        auditEventId: AUDIT_ID,
        entityType: "partner_user",
        entityId: USER_ID,
        version: committedAt,
      },
    };
  }

  const expectedAccess = {
    userId: USER_ID,
    orgContactId: ORG_ID,
    active: false,
    actorId: ACTOR_ID,
  };

  it("accepts only the exact actor, entity, version, and commit-bound envelope", () => {
    expect(
      parsePartnerPortalAccessChangeSuccess(accessPayload(), expectedAccess),
    ).toMatchObject({
      data: { userId: USER_ID, orgContactId: ORG_ID, active: false },
      receipt: {
        operationId: OPERATION_ID,
        actorId: ACTOR_ID,
        auditEventId: AUDIT_ID,
        entityId: USER_ID,
      },
    });
  });

  it.each([
    [
      "wrong actor",
      (payload: Record<string, unknown>) => {
        receipt(payload)["actorId"] = USER_ID;
      },
    ],
    [
      "wrong entity",
      (payload: Record<string, unknown>) => {
        receipt(payload)["entityId"] = ACTOR_ID;
      },
    ],
    [
      "receipt/data version mismatch",
      (payload: Record<string, unknown>) => {
        receipt(payload)["version"] = "2026-08-08T12:00:00.000Z";
      },
    ],
    [
      "commit/data version mismatch",
      (payload: Record<string, unknown>) => {
        receipt(payload)["committedAt"] = "2026-08-08T12:00:00.000Z";
      },
    ],
    [
      "unexpected receipt field",
      (payload: Record<string, unknown>) => {
        receipt(payload)["unverified"] = true;
      },
    ],
  ] as const)("rejects %s", (_label, mutate) => {
    const payload = accessPayload();
    mutate(payload);
    expect(
      parsePartnerPortalAccessChangeSuccess(payload, expectedAccess),
    ).toBeNull();
  });
});
