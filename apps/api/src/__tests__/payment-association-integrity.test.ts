import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  AttachLegacyPaymentRequestSchema,
  DetachLegacyPaymentRequestSchema,
  nextPaymentAssociationVersion,
  paymentProviderBindingMatches,
} from "@/lib/payment-association";
import { buildStablePaymentAssociationKey } from "../../../site/src/app/team/lib/payment-association-request";
import { parsePaymentAssociationSuccess } from "../../../site/src/app/team/lib/payment-association-result";

const PAYMENT_ID = "11111111-1111-4111-8111-111111111111";
const APPOINTMENT_ID = "22222222-2222-4222-8222-222222222222";
const VERSION = "2026-08-08T14:00:00.000Z";
const PAYMENT_BINDING = {
  provider: "stripe",
  providerPaymentId: "ch_exact_123",
  providerOrderId: null,
  stripeChargeId: "ch_exact_123",
} as const;

function routeSource(name: "attach" | "detach"): string {
  return readFileSync(
    path.resolve(__dirname, `../../app/api/payments/[id]/${name}/route.ts`),
    "utf8",
  );
}

function functionSource(source: string, name: string): string {
  const marker = `export async function ${name}(`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`Missing ${name}`);
  const next = source.indexOf("export async function ", start + marker.length);
  return source.slice(start, next < 0 ? source.length : next);
}

function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (/\.(?:ts|tsx)$/u.test(entry.name)) files.push(absolute);
    }
  };
  visit(root);
  return files;
}

describe("legacy payment association input", () => {
  it("requires exact provider identity and typed attachment confirmation", () => {
    const valid = AttachLegacyPaymentRequestSchema.safeParse({
      appointmentId: APPOINTMENT_ID,
      jobAmountCents: 9_000,
      tipCents: 1_000,
      reviewNote: "Verified against the Stripe receipt.",
      confirmation: "ATTACH PAYMENT",
      paymentBinding: PAYMENT_BINDING,
    });
    expect(valid.success).toBe(true);
    expect(
      AttachLegacyPaymentRequestSchema.safeParse({
        ...(valid.success ? valid.data : {}),
        confirmation: "attach payment",
      }).success,
    ).toBe(false);
    expect(
      AttachLegacyPaymentRequestSchema.safeParse({
        ...(valid.success ? valid.data : {}),
        paymentBinding: {
          ...PAYMENT_BINDING,
          providerPaymentId: null,
          stripeChargeId: null,
        },
      }).success,
    ).toBe(false);
    expect(
      AttachLegacyPaymentRequestSchema.safeParse({
        ...(valid.success ? valid.data : {}),
        ignored: "not allowed",
      }).success,
    ).toBe(false);
  });

  it("requires the exact prior appointment and typed detachment confirmation", () => {
    const valid = DetachLegacyPaymentRequestSchema.safeParse({
      expectedAppointmentId: APPOINTMENT_ID,
      reviewNote: "This belongs to a different completed job.",
      confirmation: "DETACH PAYMENT",
      paymentBinding: PAYMENT_BINDING,
    });
    expect(valid.success).toBe(true);
    expect(
      DetachLegacyPaymentRequestSchema.safeParse({
        ...(valid.success ? valid.data : {}),
        expectedAppointmentId: "not-an-id",
      }).success,
    ).toBe(false);
    expect(
      DetachLegacyPaymentRequestSchema.safeParse({
        ...(valid.success ? valid.data : {}),
        confirmation: "DETACH",
      }).success,
    ).toBe(false);
  });

  it("compares opaque provider IDs exactly and advances frozen versions", () => {
    expect(
      paymentProviderBindingMatches(PAYMENT_BINDING, PAYMENT_BINDING),
    ).toBe(true);
    expect(
      paymentProviderBindingMatches(
        { ...PAYMENT_BINDING, providerPaymentId: "ch_exact_124" },
        PAYMENT_BINDING,
      ),
    ).toBe(false);
    expect(
      paymentProviderBindingMatches(
        { ...PAYMENT_BINDING, providerPaymentId: "CH_EXACT_123" },
        PAYMENT_BINDING,
      ),
    ).toBe(false);
    const previous = new Date(VERSION);
    expect(
      nextPaymentAssociationVersion(previous, new Date(VERSION)).getTime(),
    ).toBe(previous.getTime() + 1);
  });
});

describe("legacy payment association caller and receipt", () => {
  it("derives a stable request key from canonical payload and record version", () => {
    const first = buildStablePaymentAssociationKey({
      action: "attach",
      paymentId: PAYMENT_ID,
      expectedVersion: VERSION,
      payload: { b: 2, a: { z: 3, y: 1 } },
    });
    const reordered = buildStablePaymentAssociationKey({
      action: "attach",
      paymentId: PAYMENT_ID,
      expectedVersion: VERSION,
      payload: { a: { y: 1, z: 3 }, b: 2 },
    });
    const changed = buildStablePaymentAssociationKey({
      action: "attach",
      paymentId: PAYMENT_ID,
      expectedVersion: VERSION,
      payload: { a: { y: 1, z: 4 }, b: 2 },
    });
    expect(first).toBe(reordered);
    expect(first).not.toBe(changed);
    expect(first).toMatch(/^payment-association:attach:[0-9a-f]{64}$/u);
  });

  it("accepts only the expected link plus a transaction-bound receipt", () => {
    const payload = {
      ok: true,
      data: {
        action: "attach",
        paymentId: PAYMENT_ID,
        appointmentId: APPOINTMENT_ID,
        provider: "stripe",
        canonicalStatus: "completed",
        providerEffect: "none",
        appointmentTipSynchronized: true,
        version: VERSION,
      },
      receipt: {
        operationId: "operation-123",
        correlationId: "correlation-123",
        actorId: "actor-123",
        auditEventId: "audit-123",
        entityType: "payment",
        entityId: PAYMENT_ID,
        committedAt: VERSION,
        version: VERSION,
      },
    };
    expect(
      parsePaymentAssociationSuccess(payload, {
        action: "attach",
        paymentId: PAYMENT_ID,
        appointmentId: APPOINTMENT_ID,
      }),
    ).toEqual({
      action: "attach",
      paymentId: PAYMENT_ID,
      appointmentId: APPOINTMENT_ID,
      version: VERSION,
    });
    expect(
      parsePaymentAssociationSuccess(
        {
          ...payload,
          receipt: { ...payload.receipt, auditEventId: null },
        },
        {
          action: "attach",
          paymentId: PAYMENT_ID,
          appointmentId: APPOINTMENT_ID,
        },
      ),
    ).toBeNull();
    expect(
      parsePaymentAssociationSuccess(
        {
          ...payload,
          data: { ...payload.data, appointmentId: PAYMENT_ID },
        },
        {
          action: "attach",
          paymentId: PAYMENT_ID,
          appointmentId: APPOINTMENT_ID,
        },
      ),
    ).toBeNull();
  });

  it("requires the prior appointment and review state in a detach receipt", () => {
    const payload = {
      ok: true,
      data: {
        action: "detach",
        paymentId: PAYMENT_ID,
        appointmentId: null,
        previousAppointmentId: APPOINTMENT_ID,
        provider: "stripe",
        canonicalStatus: "needs_review",
        providerEffect: "none",
        previousAppointmentTipSynchronized: true,
        version: VERSION,
      },
      receipt: {
        operationId: "operation-123",
        correlationId: "correlation-123",
        actorId: "actor-123",
        auditEventId: "audit-123",
        entityType: "payment",
        entityId: PAYMENT_ID,
        committedAt: VERSION,
        version: VERSION,
      },
    };
    const expected = {
      action: "detach" as const,
      paymentId: PAYMENT_ID,
      appointmentId: null,
      previousAppointmentId: APPOINTMENT_ID,
    };
    expect(parsePaymentAssociationSuccess(payload, expected)).toEqual({
      action: "detach",
      paymentId: PAYMENT_ID,
      appointmentId: null,
      version: VERSION,
    });
    expect(
      parsePaymentAssociationSuccess(
        {
          ...payload,
          data: { ...payload.data, canonicalStatus: "completed" },
        },
        expected,
      ),
    ).toBeNull();
    expect(
      parsePaymentAssociationSuccess(
        {
          ...payload,
          data: { ...payload.data, previousAppointmentId: PAYMENT_ID },
        },
        expected,
      ),
    ).toBeNull();
  });
});

describe("legacy payment association source contract", () => {
  it.each(["attach", "detach"] as const)(
    "serializes %s through appointment/payment locks and a link-version CAS",
    (action) => {
      const method = functionSource(routeSource(action), "POST");
      expect(method.indexOf(".from(appointments)")).toBeLessThan(
        method.indexOf(".from(payments)"),
      );
      expect(method.match(/\.for\("update"\)/gu)).toHaveLength(2);
      expect(method).toContain(
        "assertTeamMutationExpectedVersion(mutation, before.updatedAt)",
      );
      if (action === "attach") {
        const resolver = readFileSync(
          path.resolve(__dirname, "../lib/payment-reconciliation.ts"),
          "utf8",
        );
        expect(resolver).toContain("eq(payments.updatedAt, payment.updatedAt)");
        expect(resolver).toContain("isNull(payments.appointmentId)");
        expect(resolver).toContain("if (!updated)");
      } else {
        expect(method).toContain("eq(payments.updatedAt, before.updatedAt)");
        expect(method).toContain("eq(payments.appointmentId, appointment.id)");
        expect(method).toContain("if (!detached)");
      }
    },
  );

  it.each(["attach", "detach"] as const)(
    "puts verified human policy before parsing and makes %s atomic",
    (action) => {
      const source = routeSource(action);
      const method = functionSource(source, "POST");
      const boundary = method.indexOf("beginTeamMutation(request");
      expect(boundary).toBeGreaterThanOrEqual(0);
      expect(method).toContain('principalTypes: ["human"]');
      expect(method).toContain(
        'requiredPermissions: ["payments.reconcile", "payments.manage"]',
      );
      expect(method).toContain('risk: "financial"');
      expect(method).toContain("requiresIdempotency: true");
      for (const sensitive of ["context.params", "request.json()", "getDb()"]) {
        expect(boundary).toBeLessThan(method.indexOf(sensitive));
      }
      expect(method).toContain("mutation.expectedVersion === null");
      expect(method).toContain("claimTeamMutationIdempotency(");
      expect(method).toContain("paymentProviderBindingMatches(");
      const casSource =
        action === "attach"
          ? `${method}\n${readFileSync(
              path.resolve(__dirname, "../lib/payment-reconciliation.ts"),
              "utf8",
            )}`
          : method;
      expect(casSource).toContain(
        action === "attach"
          ? "eq(payments.updatedAt, payment.updatedAt)"
          : "eq(payments.updatedAt, before.updatedAt)",
      );
      expect(method).toContain("mutation.audit.insertSuccess(tx");
      expect(method).toContain("completeTeamMutationIdempotency(");
      expect(method.indexOf("mutation.audit.insertSuccess(tx")).toBeLessThan(
        method.indexOf("completeTeamMutationIdempotency("),
      );
      expect(method).not.toContain("recordAuditEvent(");
      expect(method).not.toContain("getAuditActorFromRequest(");
    },
  );

  it("keeps every team/mobile caller on the hardened request contract", () => {
    const siteRoot = path.resolve(__dirname, "../../../site/src/app");
    const references = listSourceFiles(siteRoot)
      .flatMap((file) => {
        const source = readFileSync(file, "utf8");
        return source.includes("/api/payments/${") &&
          (source.includes("}/attach") || source.includes("}/detach"))
          ? [path.relative(siteRoot, file)]
          : [];
      })
      .sort();
    expect(references).toEqual(["team/actions.ts"]);

    const actions = readFileSync(
      path.join(siteRoot, "team/actions.ts"),
      "utf8",
    );
    for (const action of ["attachPaymentAction", "detachPaymentAction"]) {
      const source = functionSource(actions, action);
      expect(
        source.indexOf("paymentAssociationPermissionDenied("),
      ).toBeLessThan(source.indexOf("readFormString(formData"));
      expect(source).toContain("buildStablePaymentAssociationKey(");
      expect(source).toContain('"Idempotency-Key": idempotencyKey');
      expect(source).toContain('"If-Match": expectedVersion');
      expect(source).toContain("parsePaymentAssociationSuccess(");
    }

    const paymentList = readFileSync(
      path.join(siteRoot, "team/PaymentsList.tsx"),
      "utf8",
    );
    for (const field of [
      "expectedVersion",
      "expectedAppointmentId",
      "expectedProvider",
      "expectedProviderPaymentId",
      "expectedProviderOrderId",
      "expectedStripeChargeId",
      "confirmation",
    ]) {
      expect(paymentList).toContain(`name="${field}"`);
    }
    expect(paymentList).toContain("canChangeAssociations");
    expect(paymentList).toContain("Type DETACH PAYMENT to confirm");
    expect(paymentList).toContain("Type ATTACH PAYMENT to confirm");
  });
});
