import { z } from "zod";
import type {
  SalesEscalationCallDeliveryCertainty,
  SalesEscalationCallOperationState,
} from "@/db";
import { TeamMutationFailure } from "@/lib/team-mutation";

const CALL_SID_PATTERN = /^CA[0-9a-f]{32}$/iu;
const PROVIDER_EVIDENCE = [
  "provider_call_record",
  "provider_support_response",
] as const;
const TWILIO_CALL_STATUSES = [
  "queued",
  "initiated",
  "ringing",
  "answered",
  "in-progress",
  "completed",
  "busy",
  "no-answer",
  "failed",
  "canceled",
] as const;

export const SalesEscalationCallReconciliationSchema = z
  .object({
    salesEscalationOperationId: z.string().uuid(),
    confirmation: z.literal("RECONCILE CALL"),
    outcome: z.enum([
      "confirmed_dispatched",
      "confirmed_connected",
      "confirmed_not_dispatched",
    ]),
    evidenceType: z.enum([
      "provider_call_record",
      "provider_no_matching_call",
      "provider_support_response",
    ]),
    providerOperationId: z.string().trim().max(64).nullable().optional(),
    providerCustomerOperationId: z
      .string()
      .trim()
      .max(64)
      .nullable()
      .optional(),
    providerCallStatus: z.enum(TWILIO_CALL_STATUSES).nullable().optional(),
    providerCustomerStatus: z.enum(TWILIO_CALL_STATUSES).nullable().optional(),
    connectedDurationSec: z
      .number()
      .int()
      .min(1)
      .max(86_400)
      .nullable()
      .optional(),
    reason: z.string().trim().min(20).max(1000),
  })
  .strict()
  .superRefine((value, context) => {
    const parentSid = value.providerOperationId ?? null;
    const customerSid = value.providerCustomerOperationId ?? null;
    const parentStatus = value.providerCallStatus ?? null;
    const customerStatus = value.providerCustomerStatus ?? null;
    const durationSec = value.connectedDurationSec ?? null;

    for (const [path, sid] of [
      ["providerOperationId", parentSid],
      ["providerCustomerOperationId", customerSid],
    ] as const) {
      if (sid && !CALL_SID_PATTERN.test(sid)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [path],
          message: "Use the exact Twilio call SID from the reviewed record.",
        });
      }
    }
    if (parentSid && customerSid && parentSid === customerSid) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerCustomerOperationId"],
        message: "The parent and customer call SIDs must be different.",
      });
    }

    if (value.outcome === "confirmed_not_dispatched") {
      if (
        !["provider_no_matching_call", "provider_support_response"].includes(
          value.evidenceType,
        ) ||
        parentSid !== null ||
        customerSid !== null ||
        parentStatus !== null ||
        customerStatus !== null ||
        durationSec !== null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["evidenceType"],
          message:
            "Not dispatched requires conclusive provider evidence and no call-leg identifiers or statuses.",
        });
      }
      return;
    }

    if (
      !PROVIDER_EVIDENCE.includes(
        value.evidenceType as (typeof PROVIDER_EVIDENCE)[number],
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["evidenceType"],
        message: "A provider call record or support response is required.",
      });
    }
    if (!parentSid || !parentStatus) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerOperationId"],
        message:
          "The parent Twilio call SID and its current status are required.",
      });
    }

    if (value.outcome === "confirmed_dispatched") {
      if (
        customerSid !== null ||
        customerStatus !== null ||
        durationSec !== null
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["providerCustomerOperationId"],
          message:
            "Customer-leg evidence is only accepted when confirming a completed connection.",
        });
      }
      return;
    }

    if (
      !customerSid ||
      parentStatus !== "completed" ||
      customerStatus !== "completed" ||
      durationSec === null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["providerCustomerOperationId"],
        message:
          "Connected requires completed parent and customer records, both exact SIDs, and a positive customer duration.",
      });
    }
  });

export type SalesEscalationCallReconciliationInput = z.infer<
  typeof SalesEscalationCallReconciliationSchema
>;

export type SalesEscalationCallbackEvidenceSummary = {
  count: number;
  hasAppliedEvidence: boolean;
  hasAnomaly: boolean;
};

export type SalesEscalationReconciliationOperationSnapshot = {
  state: SalesEscalationCallOperationState;
  reconciliationResolutionId: string | null;
  terminalAt: Date | null;
  deliveryCertainty: SalesEscalationCallDeliveryCertainty | null;
  providerOperationId: string | null;
  providerCustomerOperationId: string | null;
};

export type SalesEscalationReconciliationPlan = {
  decisive: boolean;
  terminalOutcome: "connected" | "not_dispatched" | null;
  outcomeReason:
    | "operator_confirmed_connected"
    | "operator_confirmed_not_dispatched"
    | null;
  providerOperationId: string | null;
  providerCustomerOperationId: string | null;
};

export type SalesEscalationReconciliationSidEvidence = {
  operationId: string;
  providerOperationId: string | null;
  providerCustomerOperationId: string | null;
};

export type SalesEscalationReconciliationSidOwner = {
  sid: string;
  operationId: string;
  leg: "parent" | "customer";
};

/**
 * Enforce the functional dependency Twilio SID -> operation/leg across prior
 * reviews. This closes the gap where a nondecisive dispatch review does not
 * bind its operator-supplied SID onto the immutable provider operation row.
 */
export function assertSalesEscalationReconciliationSidConsistency(
  input: {
    operationId: string;
    providerOperationId: string | null;
    providerCustomerOperationId: string | null;
  },
  priorEvidence: readonly SalesEscalationReconciliationSidEvidence[],
  existingOwners: readonly SalesEscalationReconciliationSidOwner[],
): void {
  const priorParentSids = new Set(
    priorEvidence
      .map((review) => review.providerOperationId)
      .filter((sid): sid is string => Boolean(sid)),
  );
  const priorCustomerSids = new Set(
    priorEvidence
      .map((review) => review.providerCustomerOperationId)
      .filter((sid): sid is string => Boolean(sid)),
  );
  if (
    (!input.providerOperationId && priorParentSids.size > 0) ||
    (input.providerOperationId &&
      [...priorParentSids].some((sid) => sid !== input.providerOperationId)) ||
    (!input.providerCustomerOperationId && priorCustomerSids.size > 0) ||
    (input.providerCustomerOperationId &&
      [...priorCustomerSids].some(
        (sid) => sid !== input.providerCustomerOperationId,
      ))
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The reviewed Twilio call SIDs conflict with earlier append-only evidence for this operation.",
      { fieldErrors: { evidence: "Use the SIDs from the earlier review." } },
    );
  }

  for (const owner of existingOwners) {
    const expectedLeg =
      owner.sid === input.providerOperationId
        ? "parent"
        : owner.sid === input.providerCustomerOperationId
          ? "customer"
          : null;
    if (
      (expectedLeg &&
        (owner.operationId !== input.operationId ||
          owner.leg !== expectedLeg)) ||
      (!expectedLeg && owner.operationId === input.operationId)
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "A reviewed Twilio call SID is already owned by another operation or call leg.",
        { fieldErrors: { evidence: "Verify both Twilio call SIDs." } },
      );
    }
  }
}

/**
 * Pure evidence gate used before any task, call-record, or operation update.
 * Operator evidence can settle a quarantined operation, but it never changes
 * the original delivery certainty, provider status, failure, or callback facts.
 */
export function planSalesEscalationCallReconciliation(
  operation: SalesEscalationReconciliationOperationSnapshot,
  callbackEvidence: SalesEscalationCallbackEvidenceSummary,
  input: SalesEscalationCallReconciliationInput,
): SalesEscalationReconciliationPlan {
  if (
    operation.state !== "reconciliation_required" ||
    operation.reconciliationResolutionId ||
    operation.terminalAt
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "This escalation call is no longer awaiting reconciliation. Refresh the queue.",
    );
  }

  const parentSid = input.providerOperationId ?? null;
  const customerSid = input.providerCustomerOperationId ?? null;
  if (
    parentSid &&
    operation.providerOperationId &&
    parentSid !== operation.providerOperationId
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The reviewed parent call SID conflicts with the operation evidence.",
      {
        fieldErrors: { providerOperationId: "Use the stored parent call SID." },
      },
    );
  }
  if (
    customerSid &&
    operation.providerCustomerOperationId &&
    customerSid !== operation.providerCustomerOperationId
  ) {
    throw new TeamMutationFailure(
      "conflict",
      "The reviewed customer call SID conflicts with the operation evidence.",
      {
        fieldErrors: {
          providerCustomerOperationId: "Use the stored customer call SID.",
        },
      },
    );
  }

  if (input.outcome === "confirmed_not_dispatched") {
    if (
      operation.deliveryCertainty !== "uncertain" ||
      operation.providerOperationId ||
      operation.providerCustomerOperationId ||
      callbackEvidence.count > 0
    ) {
      throw new TeamMutationFailure(
        "conflict",
        "Not dispatched cannot be confirmed because the CRM already has provider or signed callback evidence. Review the evidence again.",
        {
          fieldErrors: { outcome: "Provider evidence prevents this outcome." },
        },
      );
    }
    return {
      decisive: true,
      terminalOutcome: "not_dispatched",
      outcomeReason: "operator_confirmed_not_dispatched",
      providerOperationId: null,
      providerCustomerOperationId: null,
    };
  }

  if (!parentSid) {
    throw new TeamMutationFailure(
      "invalid",
      "The exact parent Twilio call SID is required.",
      { fieldErrors: { providerOperationId: "Enter the parent call SID." } },
    );
  }
  if (input.outcome === "confirmed_dispatched") {
    return {
      decisive: false,
      terminalOutcome: null,
      outcomeReason: null,
      providerOperationId: parentSid,
      providerCustomerOperationId: null,
    };
  }
  if (!customerSid) {
    throw new TeamMutationFailure(
      "invalid",
      "The exact customer-leg Twilio call SID is required.",
      {
        fieldErrors: {
          providerCustomerOperationId: "Enter the customer call SID.",
        },
      },
    );
  }
  return {
    decisive: true,
    terminalOutcome: "connected",
    outcomeReason: "operator_confirmed_connected",
    providerOperationId: parentSid,
    providerCustomerOperationId: customerSid,
  };
}

export type SalesEscalationTaskSnapshot = {
  contactId: string;
  assignedTo: string | null;
  status: string;
  updatedAt: Date;
};

export function classifySalesEscalationReconciliationTaskEffect(
  task: SalesEscalationTaskSnapshot | null,
  operation: {
    contactId: string;
    agentMemberId: string;
    taskUpdatedAt: Date;
  },
): "complete" | "stale" | "already_terminal" {
  if (!task || task.status !== "open") return "already_terminal";
  if (
    task.contactId !== operation.contactId ||
    task.assignedTo !== operation.agentMemberId ||
    task.updatedAt.getTime() !== operation.taskUpdatedAt.getTime()
  ) {
    return "stale";
  }
  return "complete";
}
