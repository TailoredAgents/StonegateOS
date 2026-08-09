import type { NextRequest } from "next/server";

const mockGetDb = jest.fn();
const mockRequirePermission = jest.fn();
const mockIsAdminRequest = jest.fn();
const mockForwardGeocode = jest.fn();
const mockRecordAuditEvent = jest.fn();
const mockGetAuditActorFromRequest = jest.fn();
const mockEq = jest.fn((...values: unknown[]) => values);

jest.mock("drizzle-orm", () => ({
  and: jest.fn((...values: unknown[]) => values),
  asc: jest.fn((value: unknown) => value),
  desc: jest.fn((value: unknown) => value),
  eq: mockEq,
  ilike: jest.fn((...values: unknown[]) => values),
  inArray: jest.fn((...values: unknown[]) => values),
  or: jest.fn((...values: unknown[]) => values),
  sql: jest.fn(),
}));

jest.mock("@/db", () => ({
  getDb: mockGetDb,
  contacts: {
    id: "contacts.id",
    firstName: "contacts.first_name",
    lastName: "contacts.last_name",
    email: "contacts.email",
    phone: "contacts.phone",
    phoneE164: "contacts.phone_e164",
    salespersonMemberId: "contacts.salesperson_member_id",
    source: "contacts.source",
    createdAt: "contacts.created_at",
    updatedAt: "contacts.updated_at",
  },
  properties: {
    id: "properties.id",
    contactId: "properties.contact_id",
    addressKey: "properties.address_key",
    addressLine1: "properties.address_line1",
    addressLine2: "properties.address_line2",
    city: "properties.city",
    state: "properties.state",
    postalCode: "properties.postal_code",
    lat: "properties.lat",
    lng: "properties.lng",
    createdAt: "properties.created_at",
    updatedAt: "properties.updated_at",
  },
  contactProperties: {
    id: "contact_properties.id",
    contactId: "contact_properties.contact_id",
    propertyId: "contact_properties.property_id",
  },
  appointments: {},
  quotes: {},
  crmPipeline: {},
  crmTasks: {},
}));

jest.mock("@/lib/audit", () => ({
  getAuditActorFromRequest: mockGetAuditActorFromRequest,
  recordAuditEvent: mockRecordAuditEvent,
}));

jest.mock("@/lib/contact-assignees", () => ({
  getContactAssigneeMap: jest.fn(),
  setContactAssignee: jest.fn(),
}));

jest.mock("@/lib/geocode", () => ({
  forwardGeocode: mockForwardGeocode,
}));

jest.mock("@/lib/permissions", () => ({
  requirePermission: mockRequirePermission,
}));

jest.mock("@/lib/sales-scorecard", () => ({
  getDefaultSalesAssigneeMemberId: jest.fn(),
}));

jest.mock("../../app/api/web/admin", () => ({
  isAdminRequest: mockIsAdminRequest,
}));

import { POST as createContact } from "../../app/api/admin/contacts/route";
import { POST as createProperty } from "../../app/api/admin/contacts/[contactId]/properties/route";
import { PATCH as updateProperty } from "../../app/api/admin/contacts/[contactId]/properties/[propertyId]/route";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const PROPERTY_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_CONTACT_ID = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-08-08T12:00:00.000Z");

type PropertyRow = {
  id: string;
  contactId: string;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  lat: string | null;
  lng: string | null;
  updatedAt: Date;
};

const BASE_PROPERTY: PropertyRow = {
  id: PROPERTY_ID,
  contactId: CONTACT_ID,
  addressLine1: "10 Existing Street",
  addressLine2: "Unit 4",
  city: "Baltimore",
  state: "MD",
  postalCode: "21201",
  lat: "39.290400",
  lng: "-76.612200",
  updatedAt: NOW,
};

function request(body: unknown): NextRequest & { json: jest.Mock } {
  const json = jest.fn(() => Promise.resolve(body));
  return {
    headers: new Headers(),
    nextUrl: new URL("https://api.example.test/api/admin/contacts"),
    json,
  } as unknown as NextRequest & { json: jest.Mock };
}

function propertyContext(contactId = CONTACT_ID) {
  return { params: Promise.resolve({ contactId }) };
}

function propertyDetailContext() {
  return {
    params: Promise.resolve({
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
    }),
  };
}

function patchDatabase(
  options: {
    current?: PropertyRow;
    updateError?: unknown;
  } = {},
) {
  const current = options.current ?? { ...BASE_PROPERTY };
  let capturedUpdates: Record<string, unknown> = {};
  const forUpdate = jest.fn().mockResolvedValue([current]);
  const returning = jest.fn(() =>
    options.updateError
      ? Promise.reject(toError(options.updateError))
      : Promise.resolve([
          {
            ...current,
            ...capturedUpdates,
            updatedAt: capturedUpdates["updatedAt"] as Date,
          },
        ]),
  );
  const tx = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn(() => ({ for: forUpdate })),
        })),
      })),
    })),
    update: jest.fn(() => ({
      set: jest.fn((updates: Record<string, unknown>) => {
        capturedUpdates = updates;
        return {
          where: jest.fn(() => ({ returning })),
        };
      }),
    })),
  };
  const transaction = jest.fn(
    async (callback: (transaction: typeof tx) => Promise<unknown>) =>
      callback(tx),
  );
  mockGetDb.mockReturnValue({ transaction });

  return {
    forUpdate,
    get capturedUpdates() {
      return capturedUpdates;
    },
  };
}

function createPropertyDatabase(
  options: {
    insertError?: unknown;
    existingProperty?: {
      id: string;
      addressLine1: string;
      addressLine2: string | null;
      city: string;
      state: string;
      postalCode: string;
      createdAt: Date;
    };
  } = {},
) {
  let capturedInsert: Record<string, unknown> = {};
  let capturedAssociation: Record<string, unknown> = {};
  const propertyInsertReturning = jest.fn(() =>
    options.insertError
      ? Promise.reject(toError(options.insertError))
      : Promise.resolve([
          {
            id: PROPERTY_ID,
            addressLine1: capturedInsert["addressLine1"],
            addressLine2: capturedInsert["addressLine2"],
            city: capturedInsert["city"],
            state: capturedInsert["state"],
            postalCode: capturedInsert["postalCode"],
            createdAt: NOW,
          },
        ]),
  );
  const tx = {
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest
            .fn()
            .mockResolvedValue(
              options.existingProperty ? [options.existingProperty] : [],
            ),
        })),
      })),
    })),
    insert: jest.fn((table: Record<string, unknown>) => ({
      values: jest.fn((values: Record<string, unknown>) => {
        const isPhysicalProperty = "addressLine1" in table;
        if (isPhysicalProperty) {
          capturedInsert = values;
        } else {
          capturedAssociation = values;
        }
        return {
          onConflictDoNothing: jest.fn(() => ({
            returning: isPhysicalProperty
              ? propertyInsertReturning
              : jest
                  .fn()
                  .mockResolvedValue([
                    { id: "55555555-5555-4555-8555-555555555555" },
                  ]),
          })),
        };
      }),
    })),
  };
  mockGetDb.mockReturnValue({
    select: jest.fn(() => ({
      from: jest.fn(() => ({
        where: jest.fn(() => ({
          limit: jest.fn().mockResolvedValue([{ id: CONTACT_ID }]),
        })),
      })),
    })),
    transaction: jest.fn(
      async (callback: (transaction: typeof tx) => Promise<unknown>) =>
        callback(tx),
    ),
  });

  return {
    get capturedInsert() {
      return capturedInsert;
    },
    get capturedAssociation() {
      return capturedAssociation;
    },
  };
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  const error = new Error("database operation failed");
  if (typeof value === "object" && value !== null) {
    Object.assign(error, value);
  }
  return error;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) {
    return value as Record<string, unknown>;
  }
  throw new Error("Expected an object response value");
}

describe("contact property write integrity", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsAdminRequest.mockReturnValue(true);
    mockRequirePermission.mockResolvedValue(null);
    mockGetAuditActorFromRequest.mockReturnValue({
      id: "44444444-4444-4444-8444-444444444444",
      role: "owner",
    });
    mockRecordAuditEvent.mockResolvedValue(undefined);
    mockForwardGeocode.mockResolvedValue({ lat: 40.1, lng: -75.2 });
  });

  it.each([
    [
      "street",
      { addressLine1: " 99 New Road " },
      {
        addressLine1: "99 New Road",
        addressLine2: BASE_PROPERTY.addressLine2,
        city: BASE_PROPERTY.city,
        state: BASE_PROPERTY.state,
        postalCode: BASE_PROPERTY.postalCode,
      },
      "addressLine1",
      "99 New Road",
    ],
    [
      "city",
      { city: " Annapolis " },
      {
        addressLine1: BASE_PROPERTY.addressLine1,
        addressLine2: BASE_PROPERTY.addressLine2,
        city: "Annapolis",
        state: BASE_PROPERTY.state,
        postalCode: BASE_PROPERTY.postalCode,
      },
      "city",
      "Annapolis",
    ],
    [
      "state",
      { state: " pa " },
      {
        addressLine1: BASE_PROPERTY.addressLine1,
        addressLine2: BASE_PROPERTY.addressLine2,
        city: BASE_PROPERTY.city,
        state: "PA",
        postalCode: BASE_PROPERTY.postalCode,
      },
      "state",
      "PA",
    ],
    [
      "postal code",
      { postalCode: " 21401 " },
      {
        addressLine1: BASE_PROPERTY.addressLine1,
        addressLine2: BASE_PROPERTY.addressLine2,
        city: BASE_PROPERTY.city,
        state: BASE_PROPERTY.state,
        postalCode: "21401",
      },
      "postalCode",
      "21401",
    ],
  ])(
    "merges a partial %s edit with the locked persisted address",
    async (_label, patch, expectedGeocodeInput, changedKey, changedValue) => {
      const database = patchDatabase();

      const response = await updateProperty(
        request(patch),
        propertyDetailContext(),
      );

      expect(response.status).toBe(200);
      expect(database.forUpdate).toHaveBeenCalledWith("update");
      expect(mockForwardGeocode).toHaveBeenCalledWith(
        expect.objectContaining(expectedGeocodeInput),
      );
      expect(database.capturedUpdates).toEqual(
        expect.objectContaining({
          [changedKey]: changedValue,
          lat: "40.1",
          lng: "-75.2",
        }),
      );
      expect(database.capturedUpdates["updatedAt"]).toBeInstanceOf(Date);
      for (const key of ["addressLine1", "city", "state", "postalCode"]) {
        if (key !== changedKey) {
          expect(database.capturedUpdates).not.toHaveProperty(key);
        }
      }
      const body = await json(response);
      expect(asRecord(body["property"])["id"]).toBe(PROPERTY_ID);
    },
  );

  it("retains prior coordinates when geocoding fails", async () => {
    const database = patchDatabase();
    mockForwardGeocode.mockResolvedValue(null);

    const response = await updateProperty(
      request({ city: "Frederick" }),
      propertyDetailContext(),
    );
    const body = await json(response);

    expect(response.status).toBe(200);
    expect(database.capturedUpdates).not.toHaveProperty("lat");
    expect(database.capturedUpdates).not.toHaveProperty("lng");
    const property = asRecord(body["property"]);
    expect(property["id"]).toBe(PROPERTY_ID);
    expect(property["city"]).toBe("Frederick");
    expect(property["lat"]).toBe(BASE_PROPERTY.lat);
    expect(property["lng"]).toBe(BASE_PROPERTY.lng);
  });

  it("does not geocode a unit-only edit or overwrite linked identifiers", async () => {
    const database = patchDatabase();

    const response = await updateProperty(
      request({ addressLine2: "" }),
      propertyDetailContext(),
    );

    expect(response.status).toBe(200);
    expect(mockForwardGeocode).not.toHaveBeenCalled();
    expect(database.capturedUpdates).toEqual({
      addressLine2: null,
      addressKey: "10 existing street||baltimore|md|21201",
      updatedAt: database.capturedUpdates["updatedAt"],
    });
    expect(database.capturedUpdates["updatedAt"]).toBeInstanceOf(Date);
    expect(database.capturedUpdates).not.toHaveProperty("id");
    expect(database.capturedUpdates).not.toHaveProperty("contactId");
    const body = await json(response);
    expect(asRecord(body["property"])["id"]).toBe(PROPERTY_ID);
    expect(mockEq).toHaveBeenCalledWith("properties.id", PROPERTY_ID);
  });

  it("rejects an empty patch before database or geocoder I/O", async () => {
    const input = request({});

    const response = await updateProperty(input, propertyDetailContext());

    expect(response.status).toBe(400);
    expect(await json(response)).toEqual({ error: "no_updates_provided" });
    expect(mockGetDb).not.toHaveBeenCalled();
    expect(mockForwardGeocode).not.toHaveBeenCalled();
  });

  it("reports a property conflict instead of a duplicate contact on update", async () => {
    patchDatabase({
      updateError: {
        code: "23505",
        constraint_name: "properties_address_key",
      },
    });

    const response = await updateProperty(
      request({ postalCode: "21401" }),
      propertyDetailContext(),
    );
    const body = await json(response);

    expect(response.status).toBe(409);
    expect(body).toEqual(
      expect.objectContaining({ error: "property_already_exists" }),
    );
    expect(body["error"]).not.toBe("contact_already_exists");
  });

  it("creates a property with the exact contact link and complete address", async () => {
    const database = createPropertyDatabase();

    const response = await createProperty(
      request({
        addressLine1: " 20 New Street ",
        addressLine2: " Suite 5 ",
        city: " Annapolis ",
        state: " md ",
        postalCode: " 21401 ",
      }),
      propertyContext(),
    );

    expect(response.status).toBe(200);
    expect(mockForwardGeocode).toHaveBeenCalledWith(
      expect.objectContaining({
        addressLine1: "20 New Street",
        addressLine2: "Suite 5",
        city: "Annapolis",
        state: "MD",
        postalCode: "21401",
      }),
    );
    expect(database.capturedInsert).toEqual(
      expect.objectContaining({
        contactId: CONTACT_ID,
        addressKey: "20 new street|suite 5|annapolis|md|21401",
        addressLine1: "20 New Street",
        addressLine2: "Suite 5",
        city: "Annapolis",
        state: "MD",
        postalCode: "21401",
      }),
    );
    expect(database.capturedAssociation).toEqual({
      contactId: CONTACT_ID,
      propertyId: PROPERTY_ID,
      relationship: "customer",
    });
  });

  it("links a second contact to an existing physical address without duplicating it", async () => {
    const existingProperty = {
      id: PROPERTY_ID,
      addressLine1: "20 New Street",
      addressLine2: "Suite 5",
      city: "Annapolis",
      state: "MD",
      postalCode: "21401",
      createdAt: NOW,
    };
    const database = createPropertyDatabase({ existingProperty });

    const response = await createProperty(
      request({
        addressLine1: " 20   NEW Street ",
        addressLine2: " suite 5 ",
        city: " ANNAPOLIS ",
        state: " md ",
        postalCode: " 21401 ",
      }),
      propertyContext(OTHER_CONTACT_ID),
    );
    const body = await json(response);
    const property = asRecord(body["property"]);

    expect(response.status).toBe(200);
    expect(database.capturedInsert).toEqual({});
    expect(database.capturedAssociation).toEqual({
      contactId: OTHER_CONTACT_ID,
      propertyId: PROPERTY_ID,
      relationship: "customer",
    });
    expect(property["id"]).toBe(PROPERTY_ID);
    expect(property["shared"]).toBe(true);
  });

  it("reports a property conflict from the dedicated create route", async () => {
    createPropertyDatabase({
      insertError: {
        code: "23505",
        constraint_name: "properties_address_key",
      },
    });

    const response = await createProperty(
      request({
        addressLine1: "20 New Street",
        city: "Annapolis",
        state: "MD",
        postalCode: "21401",
      }),
      propertyContext(),
    );

    expect(response.status).toBe(409);
    expect(await json(response)).toEqual(
      expect.objectContaining({ error: "property_already_exists" }),
    );
  });

  it("does not mislabel an inline property conflict as an existing contact", async () => {
    mockGetDb.mockReturnValue({
      transaction: jest.fn().mockRejectedValue({
        code: "23505",
        constraint_name: "properties_address_key",
      }),
    });

    const response = await createContact(
      request({
        firstName: "Taylor",
        lastName: "Customer",
        property: {
          addressLine1: "20 New Street",
          city: "Annapolis",
          state: "MD",
          postalCode: "21401",
        },
      }),
    );
    const body = await json(response);

    expect(response.status).toBe(409);
    expect(body).toEqual(
      expect.objectContaining({ error: "property_already_exists" }),
    );
    expect(body["error"]).not.toBe("contact_already_exists");
  });

  it.each([
    ["update", updateProperty, propertyDetailContext],
    ["create", createProperty, propertyContext],
  ])(
    "rejects unauthorized property %s before parameters, body, database, or geocoder I/O",
    async (_label, handler, makeContext) => {
      mockRequirePermission.mockResolvedValue(
        Response.json({ error: "forbidden" }, { status: 403 }),
      );
      const input = request({ addressLine1: "must not parse" });

      const response = await handler(input, makeContext());

      expect(response.status).toBe(403);
      expect(input.json).not.toHaveBeenCalled();
      expect(mockGetDb).not.toHaveBeenCalled();
      expect(mockForwardGeocode).not.toHaveBeenCalled();
    },
  );

  it("never changes a property link when a different contact ID is present in the payload", async () => {
    const database = patchDatabase();

    const response = await updateProperty(
      request({ addressLine2: "Suite 8", contactId: OTHER_CONTACT_ID }),
      propertyDetailContext(),
    );

    expect(response.status).toBe(200);
    expect(database.capturedUpdates).not.toHaveProperty("contactId");
    expect(
      mockEq.mock.calls.some((call) => call.includes(OTHER_CONTACT_ID)),
    ).toBe(false);
  });
});
