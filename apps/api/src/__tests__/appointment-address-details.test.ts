import type { NextRequest } from "next/server";
import type * as DatabaseSchema from "@/db/schema";

const mockAppointmentRow = {
  id: "11111111-1111-4111-8111-111111111111",
  appointmentType: "job",
  status: "confirmed",
  startAt: new Date("2026-09-16T14:00:00.000Z"),
  createdAt: new Date("2026-09-15T13:00:00.000Z"),
  updatedAt: new Date("2026-09-15T13:00:00.000Z"),
  durationMinutes: 60,
  travelBufferMinutes: 30,
  contactId: "22222222-2222-4222-8222-222222222222",
  contactFirstName: "Jordan",
  contactLastName: "Smith",
  propertyId: "33333333-3333-4333-8333-333333333333",
  addressLine1: "123 Oak Street",
  addressLine2: "Building B, Unit 204" as string | null,
  city: "Atlanta",
  state: "GA",
  postalCode: "30301",
};

function mockSelect(fields: Record<string, unknown>) {
  const rows =
    "rescheduleToken" in fields
      ? [
          Object.fromEntries(
            Object.entries(mockAppointmentRow).filter(([key]) => key in fields),
          ),
        ]
      : [];
  const query = {
    from: () => query,
    leftJoin: () => query,
    where: () => query,
    orderBy: () => query,
    groupBy: () => query,
    limit: () => query,
    then: (
      resolve: (value: unknown[]) => unknown,
      reject: (reason: unknown) => unknown,
    ) => Promise.resolve(rows).then(resolve, reject),
  };
  return query;
}

jest.mock("@/db", () => ({
  ...jest.requireActual<typeof DatabaseSchema>("@/db/schema"),
  getDb: () => ({ select: mockSelect }),
}));
jest.mock("@/lib/eta-agent", () => ({
  getEtaSummariesForAppointments: () => Promise.resolve(new Map()),
}));
jest.mock("@/lib/partner-request-details-store", () => ({
  loadPartnerRequestDetailsForAppointments: () => Promise.resolve(new Map()),
}));
jest.mock("@/lib/permissions", () => ({
  requirePermission: () => Promise.resolve(null),
}));
jest.mock("../../app/api/web/admin", () => ({ isAdminRequest: () => true }));

import { GET } from "../../app/api/appointments/route";

describe("booked property address details", () => {
  it.each(["Building B, Unit 204", "Apt 3", null])(
    "returns the persisted second address line %p for appointment consumers",
    async (addressLine2) => {
      mockAppointmentRow.addressLine2 = addressLine2;
      const response = await GET({
        nextUrl: new URL("https://stonegate.example/api/appointments"),
      } as NextRequest);
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        appointments: Array<{ property: Record<string, unknown> }>;
      };
      expect(body.appointments[0]?.property).toMatchObject({
        addressLine1: "123 Oak Street",
        addressLine2,
        city: "Atlanta",
        state: "GA",
        postalCode: "30301",
      });
    },
  );
});
