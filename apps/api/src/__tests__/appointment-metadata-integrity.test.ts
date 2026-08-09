import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  parseAppointmentBookingDetailsMutationSuccess,
  parseAppointmentSoldByMutationSuccess,
} from "../../../site/src/app/team/lib/appointment-metadata-mutation";
import { appointmentBookingDetailsSchema } from "@/lib/appointment-booking-details";
import { buildTeamRouteSecurityContract } from "@/lib/team-route-security-manifest";

const workspaceRoot = resolve(__dirname, "../../../..");
const read = (path: string): string =>
  readFileSync(resolve(workspaceRoot, path), "utf8");

const bookingRoute = read("apps/api/app/api/appointments/[id]/route.ts");
const soldByRoute = read("apps/api/app/api/appointments/[id]/sold-by/route.ts");
const teamActions = read("apps/site/src/app/team/actions.ts");
const editorForms = read(
  "apps/site/src/app/team/components/AppointmentMetadataEditorForms.tsx",
);
const myDay = read("apps/site/src/app/team/components/MyDaySection.tsx");
const actionManifest = read("apps/site/src/app/team/action-policy-manifest.ts");
const routeManifest = read("apps/api/src/lib/team-route-security-manifest.ts");

const appointmentId = "11111111-1111-4111-8111-111111111111";
const actorId = "22222222-2222-4222-8222-222222222222";
const sellerId = "33333333-3333-4333-8333-333333333333";
const previousSellerId = "44444444-4444-4444-8444-444444444444";
const payoutRunId = "55555555-5555-4555-8555-555555555555";
const expectedVersion = "2026-08-09T12:00:00.000Z";
const changedVersion = "2026-08-09T12:00:00.001Z";

const bookingDetails = {
  serviceType: "junk_removal" as const,
  source: { type: "google" as const },
  pricing: {
    mode: "exact" as const,
    rangeMinCents: null,
    rangeMaxCents: null,
  },
  loadSize: { kind: "quarter_to_half" as const, customLoads: null },
};

function successReceipt(version: string) {
  return {
    operationId: "66666666-6666-4666-8666-666666666666",
    correlationId: "appointment-metadata-test",
    actorId,
    committedAt: changedVersion,
    auditEventId: "77777777-7777-4777-8777-777777777777",
    entityType: "appointment" as const,
    entityId: appointmentId,
    version,
  };
}

function bookingSuccess(changed = true) {
  const version = changed ? changedVersion : expectedVersion;
  return {
    ok: true as const,
    data: {
      appointmentId,
      quotedTotalCents: 45_000,
      bookingDetails,
      changed,
      version,
    },
    receipt: successReceipt(version),
  };
}

function soldBySuccess(
  changed = true,
  appointmentStatus:
    | "requested"
    | "confirmed"
    | "completed"
    | "no_show"
    | "canceled" = "completed",
) {
  const version = changed ? changedVersion : expectedVersion;
  const commissionsRefreshed = changed && appointmentStatus === "completed";
  return {
    ok: true as const,
    data: {
      appointmentId,
      appointmentStatus,
      soldByMemberId: sellerId,
      previousSoldByMemberId: changed ? previousSellerId : sellerId,
      changed,
      commissionsRefreshed,
      payoutRunIds: commissionsRefreshed ? [payoutRunId] : [],
      version,
    },
    receipt: successReceipt(version),
  };
}

function sliceBetween(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("standalone appointment booking-details integrity", () => {
  it("verifies a human and both financial capabilities before params, body, or DB", () => {
    const boundary = bookingRoute.indexOf(
      "const boundary = await beginTeamMutation(request, {",
    );
    const params = bookingRoute.indexOf("await context.params", boundary);
    const body = bookingRoute.indexOf(
      "await readBoundedJsonRequest(request",
      params,
    );
    const database = bookingRoute.indexOf("const database = getDb()", body);

    expect(boundary).toBeGreaterThan(0);
    expect(params).toBeGreaterThan(boundary);
    expect(body).toBeGreaterThan(params);
    expect(database).toBeGreaterThan(body);
    expect(bookingRoute).toContain('principalTypes: ["human"]');
    expect(bookingRoute).toContain(
      'requiredPermissions: ["appointments.update", "payments.collect"]',
    );
    expect(bookingRoute).toContain('risk: "financial"');
    expect(bookingRoute).toContain("requiresIdempotency: true");
    expect(bookingRoute).not.toContain("isAdminRequest");
    expect(bookingRoute).not.toContain("recordAuditEvent");
  });

  it("rejects query smuggling, malformed IDs/versions, unknown fields, and oversized bodies", () => {
    expect(bookingRoute).toContain("request.nextUrl.search.length > 0");
    expect(bookingRoute).toContain(
      "APPOINTMENT_ID_PATTERN.test(appointmentId)",
    );
    expect(bookingRoute).toContain('value === "*"');
    expect(bookingRoute).toContain("new Date(value).toISOString() !== value");
    expect(bookingRoute).toContain(
      "BOOKING_DETAILS_REQUEST_MAXIMUM_BYTES = 8_192",
    );
    expect(bookingRoute).toContain("readBoundedJsonRequest(request");
    expect(bookingRoute).toContain("PatchSchema.safeParse(body)");
    expect(bookingRoute).toContain(".strict()");
    expect(bookingRoute).not.toContain("request.json(");
  });

  it("allows only nonterminal jobs and locks active team attribution", () => {
    expect(bookingRoute).toContain("isQuoteOnlyAppointmentType(");
    for (const status of ["completed", "canceled", "no_show"]) {
      expect(bookingRoute).toContain(`appointment.status === "${status}"`);
    }
    expect(bookingRoute).toContain(
      'parsed.data.bookingDetails.source.type === "team_member"',
    );
    expect(bookingRoute).toContain("eq(teamMembers.active, true)");
    expect(bookingRoute).toContain('.for("share")');
    expect(bookingRoute).toContain(
      "The selected lead-source team member is inactive",
    );
  });

  it("co-commits CAS, audit evidence, receipt, and idempotency settlement", () => {
    const transaction = bookingRoute.indexOf(
      "await database.transaction(async (tx)",
    );
    const rowLock = bookingRoute.indexOf('.for("update")', transaction);
    const stale = bookingRoute.indexOf(
      "currentVersion !== expectedVersion",
      rowLock,
    );
    const cas = bookingRoute.indexOf(
      "eq(appointments.updatedAt, appointment.updatedAt)",
      stale,
    );
    const audit = bookingRoute.indexOf(
      "await mutation.audit.insertSuccess(tx",
      cas,
    );
    const receipt = bookingRoute.indexOf(
      "teamMutationSuccessResult<BookingDetailsData>",
      audit,
    );
    const settle = bookingRoute.indexOf(
      "await completeTeamMutationIdempotency(",
      receipt,
    );

    expect(rowLock).toBeGreaterThan(transaction);
    expect(stale).toBeGreaterThan(rowLock);
    expect(cas).toBeGreaterThan(stale);
    expect(audit).toBeGreaterThan(cas);
    expect(receipt).toBeGreaterThan(audit);
    expect(settle).toBeGreaterThan(receipt);
    expect(bookingRoute).toContain(
      'route: "PATCH /api/appointments/:appointmentId"',
    );
    expect(bookingRoute).toContain("payload: parsed.data");
    expect(bookingRoute).toContain(
      "teamMutationIdempotencyReplayResponse(claimed.replay)",
    );
    expect(bookingRoute).toContain("mutation.audit.insertFailure");
    expect(
      bookingRoute.indexOf("await mutation.audit.insertFailure(tx"),
    ).toBeLessThan(
      bookingRoute.indexOf("await completeTeamMutationIdempotency("),
    );
    expect(bookingRoute).toContain("settleTeamMutationIdempotencyFailure(");
  });
});

describe("standalone seller-attribution integrity", () => {
  it("uses permission authority, never a shared override secret", () => {
    const boundary = soldByRoute.indexOf(
      "const boundary = await beginTeamMutation(request, {",
    );
    const params = soldByRoute.indexOf("await context.params", boundary);
    const body = soldByRoute.indexOf(
      "await readBoundedJsonRequest(request",
      params,
    );
    const database = soldByRoute.indexOf("const database = getDb()", body);

    expect(boundary).toBeGreaterThan(0);
    expect(params).toBeGreaterThan(boundary);
    expect(body).toBeGreaterThan(params);
    expect(database).toBeGreaterThan(body);
    expect(soldByRoute).toContain(
      'requiredPermissions: ["appointments.update", "commissions.manage"]',
    );
    expect(soldByRoute).toContain('risk: "financial"');
    expect(soldByRoute).not.toContain("SOLD_BY_OVERRIDE_CODE");
    expect(soldByRoute).not.toContain("soldByOverrideCode");
    expect(soldByRoute).not.toContain("isAdminRequest");
  });

  it("strictly validates request identity and body before durable claim", () => {
    expect(soldByRoute).toContain("request.nextUrl.search.length > 0");
    expect(soldByRoute).toContain("SOLD_BY_REQUEST_MAXIMUM_BYTES = 1_024");
    expect(soldByRoute).toContain("UpdateSoldBySchema.safeParse(body)");
    expect(soldByRoute).toContain(".strict()");
    expect(soldByRoute).toContain('value === "*"');
    expect(soldByRoute).toContain(
      'route: "POST /api/appointments/:appointmentId/sold-by"',
    );
    expect(soldByRoute).toContain("payload: parsed.data");
    expect(soldByRoute).not.toContain("request.json(");
  });

  it("uses the shared serialized payout-period lock before changing attribution", () => {
    const transaction = soldByRoute.indexOf(
      "await database.transaction(async (tx)",
    );
    const appointmentLock = soldByRoute.indexOf('.for("update")', transaction);
    const sellerLock = soldByRoute.indexOf('.for("share")', appointmentLock);
    const payoutPeriodLock = soldByRoute.indexOf(
      "await lockCompletedAppointmentPayoutPeriodInTransaction(",
      sellerLock,
    );
    const appointmentWrite = soldByRoute.indexOf(
      ".update(appointments)",
      payoutPeriodLock,
    );
    const commissions = soldByRoute.indexOf(
      "recalculateAppointmentCommissionsAndRefreshDraftPayoutsInTransaction(",
      appointmentWrite,
    );
    const audit = soldByRoute.indexOf(
      "await mutation.audit.insertSuccess(tx",
      commissions,
    );
    const receipt = soldByRoute.indexOf(
      "teamMutationSuccessResult<SoldByData>",
      audit,
    );

    expect(appointmentLock).toBeGreaterThan(transaction);
    expect(sellerLock).toBeGreaterThan(appointmentLock);
    expect(payoutPeriodLock).toBeGreaterThan(sellerLock);
    expect(appointmentWrite).toBeGreaterThan(payoutPeriodLock);
    expect(commissions).toBeGreaterThan(appointmentWrite);
    expect(audit).toBeGreaterThan(commissions);
    expect(receipt).toBeGreaterThan(audit);
    expect(soldByRoute).toContain("eq(teamMembers.active, true)");
    expect(soldByRoute).toContain(
      'payoutPeriod.reason === "completion_time_missing"',
    );
    expect(soldByRoute).toContain("payoutPeriod.payoutRunIds");
    expect(soldByRoute).not.toContain("getOrCreateCommissionSettings");
    expect(soldByRoute).not.toContain("DateTime.fromJSDate");
    expect(soldByRoute).toContain(
      "eq(appointments.updatedAt, appointment.updatedAt)",
    );
    expect(soldByRoute).toContain("{ payoutRunIds }");
  });

  it("leaves the real version and finances untouched for a seller no-op", () => {
    expect(soldByRoute).toContain(
      "const changed = previousSoldByMemberId !== activeSeller.id",
    );
    expect(soldByRoute).toContain("const appointmentVersionAt = changed");
    expect(soldByRoute).toContain(": appointment.updatedAt;");
    expect(soldByRoute).toContain("if (changed) {");
    expect(soldByRoute).toContain('if (appointment.status === "completed")');
    expect(soldByRoute).toContain("commissionsRefreshed");
    expect(soldByRoute).toContain("mutation.audit.insertFailure");
    expect(soldByRoute).toContain("settleTeamMutationIdempotencyFailure(");
  });
});

describe("booking-details schema adversarial bounds", () => {
  const valid = {
    serviceType: "junk_removal",
    source: { type: "google" },
    pricing: {
      mode: "exact",
      rangeMinCents: null,
      rangeMaxCents: null,
    },
    loadSize: { kind: "quarter_to_half", customLoads: null },
  };

  it("accepts and canonically normalizes one valid exact booking", () => {
    const parsed = appointmentBookingDetailsSchema.parse({
      ...valid,
      source: { type: "google", teamMemberId: null, referralName: null },
      landClearing: null,
    });
    expect(parsed).toEqual(bookingDetails);
    expect(bookingRoute).toContain("payload: parsed.data");
  });

  it.each([
    {
      ...valid,
      source: { type: "google", teamMemberId: sellerId },
    },
    {
      ...valid,
      pricing: {
        mode: "exact",
        rangeMinCents: 100,
        rangeMaxCents: 200,
      },
    },
    {
      ...valid,
      loadSize: { kind: "custom", customLoads: 101 },
    },
    {
      ...valid,
      landClearing: {
        areaScope: "yard",
        accessDifficulty: "easy",
        haulAway: true,
      },
    },
    {
      ...valid,
      source: { type: "google", unexpected: "silently dropped" },
    },
    {
      ...valid,
      pricing: {
        mode: "range",
        rangeMinCents: 0,
        rangeMaxCents: 2_147_483_648,
      },
    },
    {
      serviceType: "rental_dumpster",
      source: { type: "facebook" },
      pricing: {
        mode: "exact",
        rangeMinCents: null,
        rangeMaxCents: null,
      },
      rentalDumpster: {
        dumpsterSize: "10_yard",
        pickupDate: "2026-02-31",
        placementLocation: "Driveway",
      },
    },
  ])("rejects malformed or semantically irrelevant input %#", (value) => {
    expect(appointmentBookingDetailsSchema.safeParse(value).success).toBe(
      false,
    );
  });
});

describe("Team appointment metadata receipts and forms", () => {
  it("accepts exact actor/entity/version-bound booking and seller receipts", () => {
    expect(
      parseAppointmentBookingDetailsMutationSuccess(bookingSuccess(), {
        appointmentId,
        actorId,
        expectedVersion,
        quotedTotalCents: 45_000,
        bookingDetails,
      }),
    ).toEqual(bookingSuccess());
    expect(
      parseAppointmentSoldByMutationSuccess(soldBySuccess(), {
        appointmentId,
        actorId,
        expectedVersion,
        soldByMemberId: sellerId,
        expectedStatus: "completed",
      }),
    ).toEqual(soldBySuccess());
  });

  it("keeps the submitted version for genuine no-op receipts", () => {
    expect(
      parseAppointmentBookingDetailsMutationSuccess(bookingSuccess(false), {
        appointmentId,
        actorId,
        expectedVersion,
        quotedTotalCents: 45_000,
        bookingDetails,
      })?.data.version,
    ).toBe(expectedVersion);
    expect(
      parseAppointmentSoldByMutationSuccess(soldBySuccess(false), {
        appointmentId,
        actorId,
        expectedVersion,
        soldByMemberId: sellerId,
        expectedStatus: "completed",
      })?.data.version,
    ).toBe(expectedVersion);
  });

  it.each([
    {
      ...bookingSuccess(),
      receipt: { ...bookingSuccess().receipt, actorId: sellerId },
    },
    {
      ...bookingSuccess(),
      receipt: { ...bookingSuccess().receipt, auditEventId: undefined },
    },
    {
      ...bookingSuccess(),
      receipt: { ...bookingSuccess().receipt, entityId: sellerId },
    },
    {
      ...bookingSuccess(),
      receipt: { ...bookingSuccess().receipt, version: expectedVersion },
    },
    {
      ...bookingSuccess(),
      data: { ...bookingSuccess().data, appointmentId: sellerId },
    },
    {
      ...bookingSuccess(),
      data: { ...bookingSuccess().data, quotedTotalCents: 45_001 },
    },
    { ...bookingSuccess(), data: { ...bookingSuccess().data, changed: false } },
    { ...bookingSuccess(), forged: true },
    { ...bookingSuccess(), data: { ...bookingSuccess().data, forged: true } },
    {
      ...bookingSuccess(),
      receipt: { ...bookingSuccess().receipt, forged: true },
    },
  ])("rejects malformed booking-details success %#", (value) => {
    expect(
      parseAppointmentBookingDetailsMutationSuccess(value, {
        appointmentId,
        actorId,
        expectedVersion,
        quotedTotalCents: 45_000,
        bookingDetails,
      }),
    ).toBeNull();
  });

  it.each([
    {
      ...soldBySuccess(),
      receipt: { ...soldBySuccess().receipt, actorId: previousSellerId },
    },
    {
      ...soldBySuccess(),
      receipt: { ...soldBySuccess().receipt, entityType: "contact" },
    },
    {
      ...soldBySuccess(),
      data: { ...soldBySuccess().data, soldByMemberId: previousSellerId },
    },
    {
      ...soldBySuccess(),
      data: { ...soldBySuccess().data, payoutRunIds: ["bad"] },
    },
    {
      ...soldBySuccess(false),
      data: { ...soldBySuccess(false).data, commissionsRefreshed: true },
    },
    {
      ...soldBySuccess(false),
      data: {
        ...soldBySuccess(false).data,
        previousSoldByMemberId: previousSellerId,
      },
    },
    {
      ...soldBySuccess(),
      data: {
        ...soldBySuccess().data,
        previousSoldByMemberId: sellerId,
      },
    },
    { ...soldBySuccess(), forged: true },
    { ...soldBySuccess(), data: { ...soldBySuccess().data, forged: true } },
    {
      ...soldBySuccess(),
      receipt: { ...soldBySuccess().receipt, forged: true },
    },
    {
      ...soldBySuccess(true, "confirmed"),
      data: {
        ...soldBySuccess(true, "confirmed").data,
        commissionsRefreshed: true,
        payoutRunIds: [payoutRunId],
      },
    },
  ])("rejects malformed seller-attribution success %#", (value) => {
    expect(
      parseAppointmentSoldByMutationSuccess(value, {
        appointmentId,
        actorId,
        expectedVersion,
        soldByMemberId: sellerId,
        expectedStatus: "completed",
      }),
    ).toBeNull();
  });

  it("binds commission refresh claims to the loaded appointment status", () => {
    const confirmed = soldBySuccess(true, "confirmed");
    expect(
      parseAppointmentSoldByMutationSuccess(confirmed, {
        appointmentId,
        actorId,
        expectedVersion,
        soldByMemberId: sellerId,
        expectedStatus: "confirmed",
      }),
    ).toEqual(confirmed);
    expect(
      parseAppointmentSoldByMutationSuccess(
        {
          ...confirmed,
          data: {
            ...confirmed.data,
            commissionsRefreshed: true,
            payoutRunIds: [payoutRunId],
          },
        },
        {
          appointmentId,
          actorId,
          expectedVersion,
          soldByMemberId: sellerId,
          expectedStatus: "confirmed",
        },
      ),
    ).toBeNull();
  });

  it("uses stable safe-replay headers and never claims malformed 2xx success", () => {
    const bookingAction = sliceBetween(
      teamActions,
      "export async function updateAppointmentBookingDetailsAction",
      "function withResolvedLeadSourceFields",
    );
    const soldByAction = sliceBetween(
      teamActions,
      "export async function updateAppointmentSoldByAction",
      "export async function scheduleQuoteFollowupAction",
    );
    for (const source of [bookingAction, soldByAction]) {
      expect(source).toContain("callAdminMutationWithSafeReplay(");
      expect(source).toContain('"Idempotency-Key": idempotencyKey');
      expect(source).toContain('"If-Match":');
      expect(source).toContain("principal.memberId");
      expect(source).toContain("no success is being claimed");
    }
    expect(bookingAction).toContain(
      'hasTeamPermission(principal, "payments.collect")',
    );
    expect(soldByAction).toContain(
      'hasTeamPermission(principal, "commissions.manage")',
    );
    expect(soldByAction).not.toContain("soldByOverrideCode");
  });

  it("preserves recoverable input and renders controls only with exact permissions", () => {
    expect(editorForms).toContain(
      "React.useState<AppointmentMetadataActionResult",
    );
    expect(editorForms).toContain("if (result.ok)");
    expect(editorForms).toContain("setRequestIdentity({");
    expect(editorForms).toContain("Your entries are still here");
    expect(editorForms).toContain("Your selection is still here");
    expect(editorForms).toContain(
      'aria-live={feedback.ok ? "polite" : "assertive"}',
    );
    expect(editorForms).not.toContain("soldByOverrideCode");
    expect(myDay).toContain(
      "!isCompleted &&\n                canUpdateAppointments &&\n                canCollectPayments",
    );
    expect(myDay).toContain(
      "canUpdateAppointments &&\n                canManageCommissions",
    );
    expect(myDay).toContain(
      "idempotencyKey={`appointment-booking-details:${randomUUID()}`}",
    );
    expect(myDay).toContain(
      "idempotencyKey={`appointment-sold-by:${randomUUID()}`}",
    );
    expect(myDay).not.toContain("Seller override code");
  });

  it("declares maximum financial risk and exact permissions in both manifests", () => {
    for (const route of [
      '"app/api/appointments/[id]/route.ts#PATCH": "financial"',
      '"app/api/appointments/[id]/sold-by/route.ts#POST": "financial"',
    ]) {
      expect(routeManifest).toContain(route);
    }
    const bookingPolicy = sliceBetween(
      actionManifest,
      "updateAppointmentBookingDetailsAction: humanAction(",
      "convertAppointmentToJobAction: humanAction(",
    );
    const soldByPolicy = sliceBetween(
      actionManifest,
      "updateAppointmentSoldByAction: humanAction(",
      "scheduleQuoteFollowupAction: humanAction(",
    );
    expect(bookingPolicy).toContain('"appointments.update"');
    expect(bookingPolicy).toContain('"payments.collect"');
    expect(bookingPolicy).toContain('"financial"');
    expect(soldByPolicy).toContain('"appointments.update"');
    expect(soldByPolicy).toContain('"commissions.manage"');
    expect(soldByPolicy).toContain('"financial"');

    expect(
      buildTeamRouteSecurityContract({
        route: "app/api/appointments/[id]/route.ts",
        method: "PATCH",
        permissions: ["appointments.update", "payments.collect"],
      }),
    ).toMatchObject({ risk: "financial", requiresIdempotency: true });
    expect(
      buildTeamRouteSecurityContract({
        route: "app/api/appointments/[id]/sold-by/route.ts",
        method: "POST",
        permissions: ["appointments.update", "commissions.manage"],
      }),
    ).toMatchObject({ risk: "financial", requiresIdempotency: true });
  });
});
