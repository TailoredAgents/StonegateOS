const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  moduleName: string,
  factory: () => Record<string, unknown>,
) => void;

const mockResolveOrCreateContactProperty = jest.fn<
  Promise<unknown>,
  [unknown, unknown]
>();

mockModule("@/lib/property-write", () => ({
  resolveOrCreateContactProperty: mockResolveOrCreateContactProperty,
}));

const {
  isReusablePartnerOperationalContact,
  resolvePartnerBookingContactAndProperty,
} = await import("@/lib/partner-portal-v2-scheduling/service");
const { auditLogs, contacts, partnerAccountLocations, partnerAccounts } =
  await import("@/db");

const ACCOUNT_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const MEMBERSHIP_ID = "44444444-4444-4444-8444-444444444444";
const LOCATION_ID = "55555555-5555-4555-8555-555555555555";
const CONTACT_ID = "66666666-6666-4666-8666-666666666666";
const STALE_CONTACT_ID = "77777777-7777-4777-8777-777777777777";
const PROPERTY_ID = "88888888-8888-4888-8888-888888888888";
const NOW = new Date("2026-08-31T16:00:00.000Z");

type Captures = {
  contactInserts: Array<Record<string, unknown>>;
  accountUpdates: Array<Record<string, unknown>>;
  locationUpdates: Array<Record<string, unknown>>;
  auditInserts: Array<Record<string, unknown>>;
};

function queryResult<T>(rows: readonly T[]) {
  const query = {
    from: () => query,
    where: () => query,
    for: () => query,
    limit: async () => [...rows],
  };
  return query;
}

function awaitableMutation<T>(returningRows: readonly T[] = []) {
  const mutation = {
    returning: async () => [...returningRows],
    then: <R1 = void, R2 = never>(
      resolve?: ((value: void) => R1 | PromiseLike<R1>) | null,
      reject?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
    ) => Promise.resolve().then(resolve, reject),
  };
  return mutation;
}

function transactionDouble(input: {
  selections: readonly (readonly unknown[])[];
  projectedContactId?: string;
  updatedLocation?: boolean;
}) {
  const selections = [...input.selections];
  const captures: Captures = {
    contactInserts: [],
    accountUpdates: [],
    locationUpdates: [],
    auditInserts: [],
  };
  const tx = {
    select: () => queryResult(selections.shift() ?? []),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        if (table === contacts) {
          captures.contactInserts.push(values);
          return awaitableMutation([
            { id: input.projectedContactId ?? CONTACT_ID },
          ]);
        }
        if (table === auditLogs) captures.auditInserts.push(values);
        return awaitableMutation();
      },
    }),
    update: (table: unknown) => ({
      set: (values: Record<string, unknown>) => ({
        where: () => {
          if (table === partnerAccounts) {
            captures.accountUpdates.push(values);
            return awaitableMutation();
          }
          if (table === partnerAccountLocations) {
            captures.locationUpdates.push(values);
            return awaitableMutation(
              input.updatedLocation === false ? [] : [{ id: LOCATION_ID }],
            );
          }
          return awaitableMutation();
        },
      }),
    }),
  };
  return { tx, captures };
}

function actor() {
  return {
    accountId: ACCOUNT_ID,
    membershipId: MEMBERSHIP_ID,
    partnerUserId: USER_ID,
    email: "scheduler@example.com",
    sessionId: "99999999-9999-4999-8999-999999999999",
    accessLevel: "account" as const,
    canReadRates: true,
    locationIds: [] as string[],
    propertyIds: [] as string[],
  };
}

function location(overrides: Record<string, unknown> = {}) {
  return {
    id: LOCATION_ID,
    partnerAccountId: ACCOUNT_ID,
    propertyId: null,
    siteName: "North warehouse",
    externalPropertyId: null,
    addressLine1: "100 Main Street",
    addressLine2: null,
    city: "Marietta",
    state: "GA",
    postalCode: "30060",
    timezone: "America/New_York",
    locale: "en-US",
    latitude: "33.952602",
    longitude: "-84.549934",
    geocodeStatus: "verified",
    serviceAreaStatus: "eligible",
    accessInstructions: null,
    parkingInstructions: null,
    loadingInstructions: null,
    accessSecretCiphertext: null,
    accessSecretKeyVersion: null,
    onSiteContact: null,
    active: true,
    version: 1,
    createdByMembershipId: MEMBERSHIP_ID,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function account(portalContactId: string | null) {
  return {
    id: ACCOUNT_ID,
    name: "Northstar Property Group",
    segment: "property_manager",
    portalContactId,
    portalAccessEnabled: true,
  };
}

describe("partner booking operational projection", () => {
  beforeEach(() => {
    jest.resetAllMocks();
    mockResolveOrCreateContactProperty.mockResolvedValue({
      property: { id: PROPERTY_ID },
      propertyCreated: false,
      associationCreated: true,
    });
  });

  it("projects a downstream contact for an active membership with no contact pointer", async () => {
    const { tx, captures } = transactionDouble({
      selections: [[account(null)], [{ id: MEMBERSHIP_ID }]],
    });

    const result = await resolvePartnerBookingContactAndProperty({
      tx: tx as never,
      actor: actor(),
      location: location() as never,
      now: NOW,
    });

    expect(result).toEqual({ contactId: CONTACT_ID, propertyId: PROPERTY_ID });
    expect(captures.contactInserts).toEqual([
      expect.objectContaining({
        email: null,
        partnerAccountId: ACCOUNT_ID,
        partnerStatus: "partner",
        source: "partner_portal_v2_projection",
      }),
    ]);
    expect(captures.accountUpdates).toEqual([
      expect.objectContaining({ portalContactId: CONTACT_ID }),
    ]);
    expect(captures.locationUpdates).toEqual([
      expect.objectContaining({ propertyId: PROPERTY_ID, version: 2 }),
    ]);
    expect(mockResolveOrCreateContactProperty).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        contactId: CONTACT_ID,
        relationship: "partner_service_location",
        addressLine1: "100 Main Street",
      }),
    );
  });

  it.each([
    {
      label: "cross-account",
      candidate: {
        id: STALE_CONTACT_ID,
        partnerAccountId: OTHER_ACCOUNT_ID,
        partnerStatus: "partner",
        deletedAt: null,
      },
    },
    {
      label: "inactive",
      candidate: {
        id: STALE_CONTACT_ID,
        partnerAccountId: ACCOUNT_ID,
        partnerStatus: "inactive",
        deletedAt: null,
      },
    },
    {
      label: "deleted",
      candidate: {
        id: STALE_CONTACT_ID,
        partnerAccountId: ACCOUNT_ID,
        partnerStatus: "partner",
        deletedAt: NOW,
      },
    },
  ])(
    "replaces a $label contact pointer instead of reusing it",
    async ({ candidate }) => {
      const { tx, captures } = transactionDouble({
        selections: [
          [account(STALE_CONTACT_ID)],
          [{ id: MEMBERSHIP_ID }],
          [candidate],
        ],
      });

      const result = await resolvePartnerBookingContactAndProperty({
        tx: tx as never,
        actor: actor(),
        location: location() as never,
        now: NOW,
      });

      expect(result.contactId).toBe(CONTACT_ID);
      expect(captures.contactInserts).toHaveLength(1);
      expect(captures.accountUpdates).toEqual([
        expect.objectContaining({ portalContactId: CONTACT_ID }),
      ]);
      expect(mockResolveOrCreateContactProperty).toHaveBeenCalledWith(
        tx,
        expect.objectContaining({ contactId: CONTACT_ID }),
      );
    },
  );

  it("refuses projection after the actor membership is suspended or removed", async () => {
    const { tx, captures } = transactionDouble({
      selections: [[account(null)], []],
    });

    await expect(
      resolvePartnerBookingContactAndProperty({
        tx: tx as never,
        actor: actor(),
        location: location() as never,
        now: NOW,
      }),
    ).rejects.toMatchObject({
      code: "account_access_required",
      status: 403,
    });
    expect(captures.contactInserts).toHaveLength(0);
    expect(mockResolveOrCreateContactProperty).not.toHaveBeenCalled();
  });

  it("rejects a cross-account location before creating any association", async () => {
    const { tx, captures } = transactionDouble({ selections: [] });

    await expect(
      resolvePartnerBookingContactAndProperty({
        tx: tx as never,
        actor: actor(),
        location: location({ partnerAccountId: OTHER_ACCOUNT_ID }) as never,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    expect(captures.contactInserts).toHaveLength(0);
    expect(mockResolveOrCreateContactProperty).not.toHaveBeenCalled();
  });

  it("recognizes only active account-owned operational contacts", () => {
    expect(
      isReusablePartnerOperationalContact({
        accountId: ACCOUNT_ID,
        contact: {
          id: CONTACT_ID,
          partnerAccountId: ACCOUNT_ID,
          partnerStatus: "partner",
          deletedAt: null,
        },
      }),
    ).toBe(true);
    expect(
      isReusablePartnerOperationalContact({
        accountId: ACCOUNT_ID,
        contact: {
          id: CONTACT_ID,
          partnerAccountId: OTHER_ACCOUNT_ID,
          partnerStatus: "partner",
          deletedAt: null,
        },
      }),
    ).toBe(false);
  });
});
