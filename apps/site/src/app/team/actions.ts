"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
  type TeamRequestPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "./lib/api";
import {
  buildStoredContactSource,
  parseAppointmentBookingFormData,
  parseLeadSourceFormData,
  resolveBookingSelection,
} from "./lib/booking-details";
import {
  readTeamMutationError,
  readTeamMutationException,
  readTeamMutationSuccess,
  resolveTeamMutationFeedback,
  type TeamMutationFeedback,
} from "./lib/mutation-feedback";
import { parsePaymentReconciliationSuccess } from "./lib/payment-reconciliation-result";
import { parsePaymentAssociationSuccess } from "./lib/payment-association-result";
import { buildStablePaymentAssociationKey } from "./lib/payment-association-request";
import {
  isManualCallReconciliationSuccess,
  readManualCallAttemptResponseMetadata,
  readManualCallMutationSuccess,
  type ManualCallReconciliationEvidenceType,
  type ManualCallReconciliationOutcome,
} from "./lib/manual-call-result";
import {
  isSalesEscalationCallReconciliationSuccess,
  type SalesEscalationCallReconciliationEvidenceType,
  type SalesEscalationCallReconciliationOutcome,
} from "./lib/sales-escalation-call-reconciliation-result";
import {
  buildCallReconciliationIdempotencyKey,
  buildCallReconciliationScope,
} from "./lib/call-reconciliation-idempotency";
import {
  findManualCallAttempt,
  MANUAL_CALL_ATTEMPT_COOKIE,
  manualCallAttemptScope,
  parseManualCallAttemptStore,
  removeManualCallAttempt,
  storeManualCallAttempt,
} from "@/lib/manual-call-attempt-store";
import {
  isOutboundTaskReference,
  outboundBulkVersion,
  parseOutboundCallbackLocal,
  parseOutboundBulkMutationSuccess,
  parseOutboundTaskMutationSuccess,
  type OutboundTaskReference,
} from "./lib/outbound-mutation-result";
import {
  callAdminMutationWithSafeReplay,
  createAdminMutationRequest,
} from "./lib/team-mutation-transport";
import { teamSurfaceHref } from "./surface-registry";
import { quoteWorkspaceHref } from "./quotes-workspace";
import { parsePartnerRateCsv } from "./lib/partner-rate-input";
import {
  parsePartnerInviteSuccess,
  parsePartnerPortalAccessChangeSuccess,
} from "./partner-page";
import { parseInboxNewLeadAcknowledgementSuccess } from "./inbox-new-leads";
import { parseReminderMutationSuccess } from "./lib/reminder-mutation";
import { POLICY_TEMPLATE_CHANNELS } from "./components/policy-center-model";
import {
  isPipelineExpectedVersion,
  isPipelineStage,
  PipelineStageRequestError,
  requestPipelineStageMutation,
} from "./lib/pipeline-stage-mutation";
import {
  isMergePreviewHash,
  parseContactMergeSuccess,
  parseMergeDeclineSuccess,
  parseMergeScanSuccess,
} from "./lib/merge-mutation-result";
import {
  isExactAppointmentVersion,
  parseAppointmentBookingDetailsMutationSuccess,
  parseAppointmentSoldByMutationSuccess,
} from "./lib/appointment-metadata-mutation";

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

type AppointmentMutationStatus =
  | "requested"
  | "confirmed"
  | "completed"
  | "no_show"
  | "canceled";

function isAppointmentMutationStatus(
  value: unknown,
): value is AppointmentMutationStatus {
  return (
    typeof value === "string" &&
    ["requested", "confirmed", "completed", "no_show", "canceled"].includes(
      value,
    )
  );
}

function parseNullableUuid(value: unknown): string | null | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.normalize("NFKC").trim();
  if (!normalized) return null;
  return isUuid(normalized) ? normalized : undefined;
}

function isValidTeamIdempotencyKey(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u.test(value)
  );
}

function readStatusMessageIntent(
  formData: FormData,
  name: "sendCustomerNotification" | "sendReviewRequest",
): boolean | null {
  const values = formData.getAll(name);
  if (values.length === 0) return false;
  return values.length === 1 && values[0] === "on" ? true : null;
}

type OutboundMutationPath =
  | "/api/admin/outbound/start"
  | "/api/admin/outbound/disposition"
  | "/api/admin/outbound/bulk";

async function callOutboundMutationWithSafeReplay(
  principal: TeamRequestPrincipal,
  path: OutboundMutationPath,
  init: RequestInit,
): Promise<Response> {
  // These endpoints persist their idempotency result with the mutation. A
  // single transport retry reuses this exact key, version, and body so a
  // committed first attempt is replayed instead of performed twice.
  return callAdminMutationWithSafeReplay(principal, path, init);
}

async function setMutationFlash(feedback: TeamMutationFeedback): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: feedback.ok ? "myst-flash" : "myst-flash-error",
    value: feedback.message,
    path: "/",
  });
}

export async function updateApptStatus(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const id = formData.get("appointmentId");
  const status = formData.get("status");
  const crew = formData.get("crew");
  const owner = formData.get("owner");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  const sendCustomerNotification = readStatusMessageIntent(
    formData,
    "sendCustomerNotification",
  );
  const sendReviewRequest = readStatusMessageIntent(
    formData,
    "sendReviewRequest",
  );
  const proofOverrideReasonRaw = formData.get("proofOverrideReason");
  const proofOverrideReason =
    typeof proofOverrideReasonRaw === "string"
      ? proofOverrideReasonRaw.trim()
      : "";
  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    typeof status !== "string" ||
    status.trim().length === 0 ||
    typeof expectedVersion !== "string" ||
    expectedVersion.trim().length === 0 ||
    !isValidTeamIdempotencyKey(idempotencyKey) ||
    sendCustomerNotification === null ||
    sendReviewRequest === null
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "The appointment, status, current version, and retry key are required. Refresh and try again.",
    });
    revalidatePath("/team");
    return;
  }
  if (
    proofOverrideReason &&
    (proofOverrideReason.length < 10 || proofOverrideReason.length > 500)
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "A proof exception reason must be between 10 and 500 characters.",
    });
    revalidatePath("/team");
    return;
  }
  if (
    proofOverrideReason &&
    !hasTeamPermission(principal, "appointment_media.manage")
  ) {
    await setMutationFlash({
      ok: false,
      message: "You do not have permission to record a proof exception.",
    });
    revalidatePath("/team");
    return;
  }
  if (
    (sendCustomerNotification || sendReviewRequest) &&
    !hasTeamPermission(principal, "messages.send")
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "You can update the appointment, but you do not have permission to message the customer.",
    });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    status,
    sendCustomerNotification,
    sendReviewRequest,
  };
  if (proofOverrideReason) payload["proofOverrideReason"] = proofOverrideReason;
  if (typeof crew === "string") payload["crew"] = crew.length ? crew : null;
  if (typeof owner === "string") payload["owner"] = owner.length ? owner : null;

  if (status === "completed") {
    const finalTotalCents = parseUsdToCents(formData.get("finalTotal"));
    const same = formData.get("finalTotalSameAsQuoted");
    const finalTotalSameAsQuoted =
      typeof same === "string" && (same === "true" || same === "on");

    if (finalTotalCents !== null) {
      payload["finalTotalCents"] = finalTotalCents;
    } else if (finalTotalSameAsQuoted) {
      payload["finalTotalSameAsQuoted"] = true;
    }
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(
      principal,
      `/api/appointments/${encodeURIComponent(id.trim())}/status`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey.trim(),
          "If-Match": expectedVersion.trim(),
        },
        body: JSON.stringify(payload),
      },
    ),
    {
      success: "Appointment updated",
      failure: "Unable to update appointment",
      requireReceipt: true,
    },
  );
  await setMutationFlash(feedback);
  revalidatePath("/team");
}

export async function updateAppointmentEtaStatusAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const id = formData.get("appointmentId");
  const status = formData.get("etaStatus");
  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    typeof status !== "string" ||
    status.trim().length === 0
  ) {
    await setMutationFlash({
      ok: false,
      message: "Appointment and ETA status are required.",
    });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(
      principal,
      `/api/appointments/${encodeURIComponent(id.trim())}/eta-status`,
      {
        method: "POST",
        body: JSON.stringify({ status, source: "crm" }),
      },
    ),
    {
      success: "ETA status saved",
      failure: "Unable to save ETA status",
    },
  );
  await setMutationFlash(feedback);
  revalidatePath("/team");
}

export async function sendEtaDraftAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const draftId = formData.get("draftId");
  if (typeof draftId !== "string" || draftId.trim().length === 0) {
    await setMutationFlash({ ok: false, message: "ETA draft ID is missing." });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(
      principal,
      `/api/admin/eta/drafts/${encodeURIComponent(draftId.trim())}/send`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    ),
    {
      success: "ETA update queued",
      failure: "Unable to send ETA draft",
    },
  );
  await setMutationFlash(feedback);
  revalidatePath("/team");
}

export async function dismissEtaDraftAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const draftId = formData.get("draftId");
  if (typeof draftId !== "string" || draftId.trim().length === 0) {
    await setMutationFlash({ ok: false, message: "ETA draft ID is missing." });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(
      principal,
      `/api/admin/eta/drafts/${encodeURIComponent(draftId.trim())}/dismiss`,
      {
        method: "POST",
        body: JSON.stringify({}),
      },
    ),
    {
      success: "ETA draft dismissed",
      failure: "Unable to dismiss ETA draft",
    },
  );
  await setMutationFlash(feedback);
  revalidatePath("/team");
}

export async function addApptNote(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const id = formData.get("appointmentId");
  const body = formData.get("body");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    typeof body !== "string" ||
    body.trim().length === 0 ||
    typeof expectedVersion !== "string" ||
    expectedVersion.trim().length === 0 ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "The appointment, current version, note text, and retry key are required. Refresh and try again.",
    });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminMutationWithSafeReplay(
      principal,
      `/api/appointments/${encodeURIComponent(id.trim())}/notes`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey.trim(),
          "If-Match": expectedVersion.trim(),
        },
        body: JSON.stringify({ body: body.trim() }),
      },
    ),
    {
      success: "Note added",
      failure: "Unable to add note",
      requireReceipt: true,
    },
  );
  await setMutationFlash(feedback);
  revalidatePath("/team");
}

export async function sendQuoteAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const id = formData.get("quoteId");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  const confirmation = formData.get("confirmation");
  const jar = await cookies();
  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    typeof expectedVersion !== "string" ||
    expectedVersion.trim().length === 0 ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length < 16 ||
    confirmation !== "send_quote"
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "The quote send request is incomplete. Refresh and try again.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(
      principal,
      `/api/quotes/${encodeURIComponent(id.trim())}/send`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey.trim(),
          "If-Match": expectedVersion.trim(),
        },
        body: JSON.stringify({ confirmation }),
      },
    ),
    {
      success:
        "Quote delivery requested. Track channel status in Quotes or Inbox.",
      failure: "Unable to send quote",
      requireReceipt: true,
    },
  );
  jar.set({
    name: feedback.ok ? "myst-flash" : "myst-flash-error",
    value: feedback.message,
    path: "/",
  });
  revalidatePath("/team");
}

type InboxWorkflowActionResult = {
  ok: boolean;
  error?: string;
  draftText?: string;
  recordId?: string;
  refreshKey?: string;
};

function readFormString(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function firstNameFromDisplayName(value: string): string {
  const cleaned = value.trim();
  if (!cleaned) return "there";
  return cleaned.split(/\s+/)[0] ?? "there";
}

function formatInboxAppointmentTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

function buildLocalStartAt(formData: FormData): string {
  const startAt = readFormString(formData, "startAt");
  if (startAt) return startAt;
  const preferredDate = readFormString(formData, "preferredDate");
  const startTime = readFormString(formData, "startTime");
  return preferredDate && startTime ? `${preferredDate}T${startTime}` : "";
}

export async function createInboxQuoteAction(
  formData: FormData,
): Promise<InboxWorkflowActionResult> {
  const principal = await requireCurrentTeamPrincipal();
  try {
    const contactId = readFormString(formData, "contactId");
    const contactName = readFormString(formData, "contactName");
    let propertyId = readFormString(formData, "propertyId");
    const zoneId = readFormString(formData, "zoneId");
    const servicesRaw = readFormString(formData, "services");
    const serviceOverridesRaw = readFormString(formData, "serviceOverrides");
    const idempotencyKey = readFormString(formData, "idempotencyKey");
    const confirmation = readFormString(formData, "confirmation");

    if (
      !contactId ||
      !propertyId ||
      !zoneId ||
      !isValidTeamIdempotencyKey(idempotencyKey) ||
      confirmation !== "create_quote"
    ) {
      return { ok: false, error: "Missing quote details" };
    }

    if (propertyId === "__new") {
      const addressLine1 = readFormString(formData, "newAddressLine1");
      const addressLine2 = readFormString(formData, "newAddressLine2");
      const city = readFormString(formData, "newCity");
      const state = readFormString(formData, "newState");
      const postalCode = readFormString(formData, "newPostalCode");

      if (!addressLine1 || !city || !state || !postalCode) {
        return {
          ok: false,
          error: "Enter the new property address before creating the quote.",
        };
      }

      const propertyResponse = await callAdminApiAs(
        principal,
        `/api/admin/contacts/${encodeURIComponent(contactId)}/properties`,
        {
          method: "POST",
          body: JSON.stringify({
            addressLine1,
            ...(addressLine2 ? { addressLine2 } : {}),
            city,
            state,
            postalCode,
          }),
        },
      );
      const propertyData = (await propertyResponse
        .json()
        .catch(() => null)) as {
        property?: { id?: string };
        error?: string;
        message?: string;
      } | null;

      if (!propertyResponse.ok || !propertyData?.property?.id) {
        return {
          ok: false,
          error:
            propertyData?.message ??
            propertyData?.error ??
            "Unable to add address for this quote",
        };
      }

      propertyId = propertyData.property.id;
    }

    let services: string[] = [];
    try {
      const parsed = JSON.parse(servicesRaw) as unknown;
      services = Array.isArray(parsed)
        ? parsed.filter(
            (item): item is string =>
              typeof item === "string" && item.trim().length > 0,
          )
        : [];
    } catch {
      services = [];
    }

    if (!services.length) {
      return { ok: false, error: "Select at least one service" };
    }

    const payload: Record<string, unknown> = {
      contactId,
      propertyId,
      zoneId,
      selectedServices: services,
      makeShareable: true,
      confirmation: "create_quote",
    };

    const depositRate = Number(readFormString(formData, "depositRate"));
    if (Number.isFinite(depositRate) && depositRate > 0 && depositRate <= 1) {
      payload["depositRate"] = depositRate;
    }

    const expiresInDays = Number(readFormString(formData, "expiresInDays"));
    if (Number.isFinite(expiresInDays) && expiresInDays > 0) {
      payload["expiresInDays"] = Math.trunc(expiresInDays);
    }

    const jobDurationMinutes = Number(
      readFormString(formData, "jobDurationMinutes"),
    );
    if (
      Number.isFinite(jobDurationMinutes) &&
      jobDurationMinutes >= 30 &&
      jobDurationMinutes <= 8 * 60
    ) {
      payload["jobDurationMinutes"] = Math.trunc(jobDurationMinutes);
    }

    const notes = readFormString(formData, "notes");
    if (notes) payload["notes"] = notes;

    const clientScope = readFormString(formData, "clientScope");
    if (clientScope) payload["clientScope"] = clientScope;

    if (serviceOverridesRaw) {
      try {
        const parsed = JSON.parse(serviceOverridesRaw) as Record<
          string,
          unknown
        >;
        const sanitized: Record<string, number> = {};
        for (const [key, value] of Object.entries(parsed)) {
          const numeric = typeof value === "number" ? value : Number(value);
          if (Number.isFinite(numeric) && numeric > 0 && key !== "driveway") {
            sanitized[key] = numeric;
          }
        }
        if (Object.keys(sanitized).length > 0) {
          payload["serviceOverrides"] = sanitized;
        }
      } catch {
        // ignore malformed overrides
      }
    }

    const response = await callAdminApiAs(principal, "/api/quotes", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      return {
        ok: false,
        error: await readTeamMutationError(response, "Unable to create quote"),
      };
    }
    const envelope = await readTeamMutationSuccess<{
      quote?: { id?: string };
      shareUrl?: string | null;
    }>(response);
    if (!envelope) {
      return {
        ok: false,
        error:
          "The quote service returned an unreadable success receipt. Refresh Quotes before retrying.",
      };
    }

    const recordId = envelope.data.quote?.id ?? undefined;
    const shareLink = envelope.data.shareUrl ?? null;
    if (!shareLink) {
      return {
        ok: false,
        error:
          "Quote was created, but no share link was returned. Open Quotes to send or preview it before messaging the customer.",
        recordId,
      };
    }
    const draftText = `Hi ${firstNameFromDisplayName(contactName)}, I put together your quote here: ${shareLink}. Take a look and reply with any questions.`;

    revalidatePath("/team");
    return {
      ok: true,
      draftText,
      recordId,
      refreshKey: String(Date.now()),
    };
  } catch (error) {
    return {
      ok: false,
      error: formatActionError(error, "Unable to create quote"),
    };
  }
}

export async function quoteDecisionAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const id = formData.get("quoteId");
  const decision = formData.get("decision");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  const confirmation = formData.get("confirmation");
  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    (decision !== "accepted" && decision !== "declined") ||
    typeof expectedVersion !== "string" ||
    expectedVersion.trim().length === 0 ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length < 16 ||
    confirmation !== "set_quote_decision"
  ) {
    await setMutationFlash({
      ok: false,
      message: "A valid quote decision is required.",
    });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(
      principal,
      `/api/quotes/${encodeURIComponent(id.trim())}/decision`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey.trim(),
          "If-Match": expectedVersion.trim(),
        },
        body: JSON.stringify({ decision, confirmation }),
      },
    ),
    {
      success:
        "Quote decision recorded internally. No customer message was sent.",
      failure: "Unable to record the quote decision",
      requireReceipt: true,
    },
  );
  await setMutationFlash(feedback);
  revalidatePath("/team");
}

export async function deleteQuoteAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const id = formData.get("quoteId");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  const confirmation = formData.get("confirmation");
  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    typeof expectedVersion !== "string" ||
    expectedVersion.trim().length === 0 ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length < 16 ||
    confirmation !== "delete_quote"
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "The quote deletion request is incomplete. Refresh and try again.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(principal, `/api/quotes/${encodeURIComponent(id.trim())}`, {
      method: "DELETE",
      headers: {
        "Idempotency-Key": idempotencyKey.trim(),
        "If-Match": expectedVersion.trim(),
      },
      body: JSON.stringify({ confirmation }),
    }),
    {
      success: "Quote deleted",
      failure: "Unable to delete quote",
      requireReceipt: true,
    },
  );
  jar.set({
    name: feedback.ok ? "myst-flash" : "myst-flash-error",
    value: feedback.message,
    path: "/",
  });
  revalidatePath("/team");
}

export async function deleteInstantQuoteAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const id = formData.get("instantQuoteId");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  if (typeof id !== "string" || id.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Instant quote ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (
    typeof expectedVersion !== "string" ||
    expectedVersion.trim().length === 0 ||
    expectedVersion.length > 200
  ) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The instant quote changed or its version is missing. Refresh and try again.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (
    typeof idempotencyKey !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u.test(idempotencyKey)
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "The delete request expired. Refresh the page and try again.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/admin/instant-quotes/${encodeURIComponent(id.trim())}`,
    {
      method: "DELETE",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "x-expected-version": expectedVersion,
      },
    },
  );
  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to delete instant quote",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Instant quote deleted", path: "/" });
  revalidatePath("/team");
}

type PaymentProviderBindingPayload = {
  provider: string;
  providerPaymentId: string | null;
  providerOrderId: string | null;
  stripeChargeId: string | null;
};

const PAYMENT_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;

function paymentProviderBindingFromForm(
  formData: FormData,
): PaymentProviderBindingPayload | null {
  const provider = readFormString(formData, "expectedProvider").toLowerCase();
  const values = {
    providerPaymentId: readFormString(formData, "expectedProviderPaymentId"),
    providerOrderId: readFormString(formData, "expectedProviderOrderId"),
    stripeChargeId: readFormString(formData, "expectedStripeChargeId"),
  };
  if (!/^[a-z][a-z0-9_-]{0,31}$/u.test(provider)) return null;
  if (
    Object.values(values).some(
      (value) => value.length > 0 && !PAYMENT_PROVIDER_ID_PATTERN.test(value),
    )
  ) {
    return null;
  }
  return {
    provider,
    providerPaymentId: values.providerPaymentId || null,
    providerOrderId: values.providerOrderId || null,
    stripeChargeId: values.stripeChargeId || null,
  };
}

async function paymentAssociationPermissionDenied(
  principal: TeamRequestPrincipal,
): Promise<boolean> {
  if (
    hasTeamPermission(principal, "payments.reconcile") &&
    hasTeamPermission(principal, "payments.manage")
  ) {
    return false;
  }
  await setMutationFlash({
    ok: false,
    message:
      "You do not have permission to change payment appointment links. No change was made.",
  });
  revalidatePath("/team");
  return true;
}

export async function attachPaymentAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  if (await paymentAssociationPermissionDenied(principal)) return;

  const paymentId = readFormString(formData, "paymentId");
  const appointmentId = readFormString(formData, "appointmentId");
  const expectedVersion = readFormString(formData, "expectedVersion");
  const reviewNote = readFormString(formData, "reviewNote");
  const confirmation = readFormString(formData, "confirmation");
  const paymentBinding = paymentProviderBindingFromForm(formData);
  const jobAmountCents = parseUsdToCents(formData.get("jobAmount"));
  const tipCents = parseUsdToCents(formData.get("tipAmount"));
  if (
    !isUuid(paymentId) ||
    !isUuid(appointmentId) ||
    expectedVersion.length === 0 ||
    expectedVersion.length > 200 ||
    expectedVersion === "*" ||
    reviewNote.length < 3 ||
    reviewNote.length > 500 ||
    confirmation !== "ATTACH PAYMENT" ||
    paymentBinding?.provider !== "stripe" ||
    (!paymentBinding.providerPaymentId && !paymentBinding.stripeChargeId) ||
    jobAmountCents === null ||
    jobAmountCents > 100_000_000 ||
    tipCents === null ||
    tipCents > 10_000_000
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "Refresh the payment, confirm ATTACH PAYMENT, and provide the appointment, allocation, and review reason. No change was made.",
    });
    revalidatePath("/team");
    return;
  }

  const payload = {
    appointmentId,
    jobAmountCents,
    tipCents,
    reviewNote,
    confirmation,
    paymentBinding,
  };
  const idempotencyKey = buildStablePaymentAssociationKey({
    action: "attach",
    paymentId,
    expectedVersion,
    payload,
  });

  try {
    const response = await callAdminApiAs(
      principal,
      `/api/payments/${encodeURIComponent(paymentId)}/attach`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": expectedVersion,
        },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      await setMutationFlash({
        ok: false,
        message: await readTeamMutationError(
          response,
          "The payment attachment could not be confirmed",
        ),
      });
      revalidatePath("/team");
      return;
    }
    const body: unknown = await response.json().catch(() => null);
    const success = parsePaymentAssociationSuccess(body, {
      action: "attach",
      paymentId,
      appointmentId,
    });
    if (!success) {
      await setMutationFlash({
        ok: false,
        message:
          "The server returned an incomplete payment receipt. No success is being claimed; refresh and verify the link before retrying.",
      });
      revalidatePath("/team");
      return;
    }
    await setMutationFlash({
      ok: true,
      message:
        "Stripe payment attached and reconciled. The appointment balance and tip summary were refreshed.",
    });
  } catch (error) {
    await setMutationFlash({
      ok: false,
      message: readTeamMutationException(
        error,
        "The payment attachment could not be confirmed",
      ),
    });
  }
  revalidatePath("/team");
}

export async function detachPaymentAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  if (await paymentAssociationPermissionDenied(principal)) return;

  const paymentId = readFormString(formData, "paymentId");
  const expectedAppointmentId = readFormString(
    formData,
    "expectedAppointmentId",
  );
  const expectedVersion = readFormString(formData, "expectedVersion");
  const reviewNote = readFormString(formData, "reviewNote");
  const confirmation = readFormString(formData, "confirmation");
  const paymentBinding = paymentProviderBindingFromForm(formData);
  if (
    !isUuid(paymentId) ||
    !isUuid(expectedAppointmentId) ||
    expectedVersion.length === 0 ||
    expectedVersion.length > 200 ||
    expectedVersion === "*" ||
    reviewNote.length < 3 ||
    reviewNote.length > 500 ||
    confirmation !== "DETACH PAYMENT" ||
    !paymentBinding
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "Refresh the payment, type DETACH PAYMENT, and provide a review reason. No change was made.",
    });
    revalidatePath("/team");
    return;
  }

  const payload = {
    expectedAppointmentId,
    reviewNote,
    confirmation,
    paymentBinding,
  };
  const idempotencyKey = buildStablePaymentAssociationKey({
    action: "detach",
    paymentId,
    expectedVersion,
    payload,
  });

  try {
    const response = await callAdminApiAs(
      principal,
      `/api/payments/${encodeURIComponent(paymentId)}/detach`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": expectedVersion,
        },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      await setMutationFlash({
        ok: false,
        message: await readTeamMutationError(
          response,
          "The payment detachment could not be confirmed",
        ),
      });
      revalidatePath("/team");
      return;
    }
    const body: unknown = await response.json().catch(() => null);
    const success = parsePaymentAssociationSuccess(body, {
      action: "detach",
      paymentId,
      appointmentId: null,
      previousAppointmentId: expectedAppointmentId,
    });
    if (!success) {
      await setMutationFlash({
        ok: false,
        message:
          "The server returned an incomplete payment receipt. No success is being claimed; refresh and verify the link before retrying.",
      });
      revalidatePath("/team");
      return;
    }
    await setMutationFlash({
      ok: true,
      message:
        "Payment detached and returned to owner review. The previous appointment tip summary was refreshed.",
    });
  } catch (error) {
    await setMutationFlash({
      ok: false,
      message: readTeamMutationException(
        error,
        "The payment detachment could not be confirmed",
      ),
    });
  }
  revalidatePath("/team");
}

export async function paymentReconciliationAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const operation = formData.get("operation");
  const idempotencyKey = formData.get("idempotencyKey");
  const expectedVersion = formData.get("expectedVersion");
  const jar = await cookies();
  const fail = (message: string) => {
    jar.set({
      name: "myst-flash-error",
      value: message,
      path: "/",
    });
    revalidatePath("/team");
  };
  if (typeof operation !== "string") {
    fail("Missing reconciliation action");
    return;
  }
  if (!isValidTeamIdempotencyKey(idempotencyKey)) {
    fail(
      "This reconciliation request expired. Refresh the page and try again.",
    );
    return;
  }
  const requiresVersion = operation !== "run_square_reconciliation_sweep";
  if (
    requiresVersion &&
    (typeof expectedVersion !== "string" ||
      expectedVersion.trim().length === 0 ||
      expectedVersion.trim() === "*")
  ) {
    fail("This reconciliation record is stale. Refresh it before continuing.");
    return;
  }

  const stringValue = (name: string): string | null => {
    const value = formData.get(name);
    return typeof value === "string" && value.trim().length > 0
      ? value.trim()
      : null;
  };
  const reviewNote = stringValue("reviewNote");
  const confirmation = stringValue("confirmation");
  let payload: Record<string, unknown>;

  switch (operation) {
    case "run_square_reconciliation_sweep":
      if (confirmation !== "RUN SQUARE CHECK") {
        fail("Confirm the Square check before running it.");
        return;
      }
      payload = { operation, confirmation };
      break;
    case "retry_square_attempt": {
      const attemptId = stringValue("attemptId");
      if (!attemptId || confirmation !== "RETRY SQUARE ATTEMPT") {
        fail("The Square attempt or its confirmation is missing.");
        return;
      }
      payload = { operation, attemptId, confirmation };
      break;
    }
    case "dismiss_square_attempt": {
      const attemptId = stringValue("attemptId");
      if (!attemptId || !reviewNote || confirmation !== "NO SQUARE CHARGE") {
        fail(
          "Confirm NO SQUARE CHARGE and provide the provider-review reason before dismissing.",
        );
        return;
      }
      payload = { operation, attemptId, reviewNote, confirmation };
      break;
    }
    case "retry_square_event": {
      const eventId = stringValue("eventId");
      if (!eventId || confirmation !== "RETRY SQUARE EVENT") {
        fail("The Square event or its confirmation is missing.");
        return;
      }
      payload = { operation, eventId, confirmation };
      break;
    }
    case "retry_square_payment": {
      const paymentId = stringValue("paymentId");
      const providerPaymentId = stringValue("providerPaymentId");
      if (
        !paymentId ||
        !providerPaymentId ||
        confirmation !== "RETRY SQUARE PAYMENT"
      ) {
        fail("The local and Square payment IDs must both be confirmed.");
        return;
      }
      payload = { operation, paymentId, providerPaymentId, confirmation };
      break;
    }
    case "retry_square_refund": {
      const refundId = stringValue("refundId");
      const providerRefundId = stringValue("providerRefundId");
      if (
        !refundId ||
        !providerRefundId ||
        confirmation !== "RETRY SQUARE REFUND"
      ) {
        fail("The local and Square refund IDs must both be confirmed.");
        return;
      }
      payload = { operation, refundId, providerRefundId, confirmation };
      break;
    }
    case "acknowledge_refund_impact": {
      const refundId = stringValue("refundId");
      if (
        !refundId ||
        !reviewNote ||
        confirmation !== "ACKNOWLEDGE REFUND IMPACT"
      ) {
        fail(
          "Confirm ACKNOWLEDGE REFUND IMPACT and provide the review reason.",
        );
        return;
      }
      payload = { operation, refundId, reviewNote, confirmation };
      break;
    }
    case "resolve_stripe_payment": {
      const paymentId = stringValue("paymentId");
      const appointmentId = stringValue("appointmentId");
      const jobAmountCents = parseUsdToCents(formData.get("jobAmount"));
      const tipCents = parseUsdToCents(formData.get("tipAmount"));
      if (
        !paymentId ||
        !appointmentId ||
        !reviewNote ||
        jobAmountCents === null ||
        tipCents === null ||
        confirmation !== "ATTACH STRIPE PAYMENT"
      ) {
        fail(
          "Confirm ATTACH STRIPE PAYMENT and provide the appointment, allocation, and review reason.",
        );
        return;
      }
      payload = {
        operation,
        paymentId,
        appointmentId,
        jobAmountCents,
        tipCents,
        reviewNote,
        confirmation,
      };
      break;
    }
    default:
      fail("Unknown reconciliation action");
      return;
  }

  try {
    const response = await callAdminApiAs(
      principal,
      "/api/admin/payments/reconciliation",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          ...(requiresVersion
            ? { "If-Match": (expectedVersion as string).trim() }
            : {}),
        },
        body: JSON.stringify(payload),
        timeoutMs:
          operation === "run_square_reconciliation_sweep" ? 90_000 : 45_000,
      },
    );
    if (!response.ok) {
      fail(
        await readTeamMutationError(
          response,
          "Payment reconciliation could not be confirmed",
        ),
      );
      return;
    }

    const responseBody: unknown = await response.json().catch(() => null);
    const feedback = parsePaymentReconciliationSuccess(responseBody, operation);
    if (!feedback) {
      fail(
        "The server returned an incomplete reconciliation receipt. Refresh the list and verify the record before retrying.",
      );
      return;
    }
    jar.set({
      name: feedback.needsAttention ? "myst-flash-error" : "myst-flash",
      value: feedback.message,
      path: "/",
    });
  } catch (error) {
    fail(
      readTeamMutationException(
        error,
        "Payment reconciliation could not be confirmed",
      ),
    );
    return;
  }
  revalidatePath("/team");
}

export async function rescheduleAppointmentAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const id = formData.get("appointmentId");
  const preferredDate = formData.get("preferredDate");
  const timeWindow = formData.get("timeWindow");
  const startTime = formData.get("startTime");

  const jar = await cookies();

  if (
    typeof id !== "string" ||
    id.trim().length === 0 ||
    typeof preferredDate !== "string" ||
    preferredDate.trim().length === 0
  ) {
    jar.set({ name: "myst-flash-error", value: "Missing date", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {};

  if (typeof startTime === "string" && startTime.trim().length > 0) {
    payload["preferredDate"] = preferredDate;
    payload["startTime"] = startTime.trim();
  } else {
    payload["preferredDate"] = preferredDate;
    if (typeof timeWindow === "string" && timeWindow.length > 0) {
      payload["timeWindow"] = timeWindow;
    }
  }

  if (!payload["startAt"] && !payload["preferredDate"]) {
    jar.set({ name: "myst-flash-error", value: "Missing time", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/web/appointments/${id}/reschedule`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    let message = "Unable to reschedule";
    try {
      const data = (await response.json()) as {
        error?: string;
        message?: string;
      };
      message = data.message ?? data.error ?? message;
    } catch {
      // ignore
    }
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
  } else {
    jar.set({
      name: "myst-flash",
      value: "Appointment rescheduled",
      path: "/",
    });
  }

  revalidatePath("/team");
}

export async function createQuoteAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();

  const contactId = formData.get("contactId");
  const propertyId = formData.get("propertyId");
  const zoneId = formData.get("zoneId");
  const workflow = formData.get("workflow");
  const servicesRaw = formData.get("services");
  const depositRate = formData.get("depositRate");
  const expiresInDays = formData.get("expiresInDays");
  const notes = formData.get("notes");
  const clientScope = formData.get("clientScope");
  const jobDurationMinutes = formData.get("jobDurationMinutes");
  const serviceOverridesRaw = formData.get("serviceOverrides");
  const idempotencyKey = formData.get("idempotencyKey");
  const shouldSend = formData.get("sendQuote") === "on";
  const shouldShare = shouldSend || formData.get("shareQuote") === "on";

  if (
    typeof contactId !== "string" ||
    typeof propertyId !== "string" ||
    typeof zoneId !== "string" ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "Missing quote details",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  let services: string[] = [];
  if (typeof servicesRaw === "string" && servicesRaw.length > 0) {
    try {
      const parsed = JSON.parse(servicesRaw) as string[];
      if (Array.isArray(parsed)) {
        services = parsed;
      }
    } catch {
      // ignore
    }
  }

  if (!services.length) {
    jar.set({
      name: "myst-flash-error",
      value: "No services selected",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    confirmation: "create_quote",
    contactId,
    propertyId,
    zoneId,
    selectedServices: services,
    ...(shouldShare ? { makeShareable: true } : {}),
  };

  if (typeof depositRate === "string" && depositRate.trim().length > 0) {
    const rate = Number(depositRate);
    if (!Number.isNaN(rate) && rate > 0 && rate <= 1) {
      payload["depositRate"] = rate;
    }
  }

  if (typeof expiresInDays === "string" && expiresInDays.trim().length > 0) {
    const days = Number(expiresInDays);
    if (!Number.isNaN(days) && days > 0) {
      payload["expiresInDays"] = days;
    }
  }

  if (
    typeof jobDurationMinutes === "string" &&
    jobDurationMinutes.trim().length > 0
  ) {
    const minutes = Number(jobDurationMinutes);
    if (Number.isFinite(minutes) && minutes >= 30 && minutes <= 8 * 60) {
      payload["jobDurationMinutes"] = Math.trunc(minutes);
    }
  }

  if (typeof notes === "string" && notes.trim().length > 0) {
    payload["notes"] = notes.trim();
  }

  if (typeof clientScope === "string" && clientScope.trim().length > 0) {
    payload["clientScope"] = clientScope.trim();
  }

  if (
    typeof serviceOverridesRaw === "string" &&
    serviceOverridesRaw.trim().length > 0
  ) {
    try {
      const parsed = JSON.parse(serviceOverridesRaw) as Record<string, unknown>;
      const sanitized: Record<string, number> = {};
      for (const [key, value] of Object.entries(parsed)) {
        const numeric = typeof value === "number" ? value : Number(value);
        if (Number.isFinite(numeric) && numeric > 0 && key !== "driveway") {
          sanitized[key] = numeric;
        }
      }
      if (Object.keys(sanitized).length > 0) {
        payload["serviceOverrides"] = sanitized;
      }
    } catch {
      // ignore malformed overrides
    }
  }

  // Removed surface area and concrete surface handling for junk removal

  const response = await callAdminApiAs(principal, `/api/quotes`, {
    method: "POST",
    headers: {
      "Idempotency-Key": `${idempotencyKey}:create`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const message = await readTeamMutationError(
      response,
      "Unable to create quote",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }
  const envelope = await readTeamMutationSuccess<{
    quote?: { id?: string; revision?: number };
    shareUrl?: string | null;
    breakdown?: { total?: number };
  }>(response);
  if (!envelope) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The quote service returned an unreadable success receipt. Refresh Quotes before retrying.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const quoteId = envelope.data.quote?.id ?? null;
  const shareLink = envelope.data.shareUrl ?? null;
  const isCanvass =
    typeof workflow === "string" && workflow.trim().toLowerCase() === "canvass";

  let successMessage = shareLink
    ? "Quote and customer link created"
    : "Quote created";
  let sendError: string | null = null;

  if (shouldSend) {
    const expectedVersion = envelope.data.quote?.revision;
    if (quoteId && Number.isInteger(expectedVersion) && expectedVersion! > 0) {
      const sendResponse = await callAdminApiAs(
        principal,
        `/api/quotes/${encodeURIComponent(quoteId)}/send`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": `${idempotencyKey}:send`,
            "If-Match": String(expectedVersion),
          },
          body: JSON.stringify({ confirmation: "send_quote" }),
        },
      );

      const sendEnvelope = await readTeamMutationSuccess(sendResponse);
      if (sendEnvelope) {
        successMessage = "Quote delivery requested";
      } else {
        sendError = sendResponse.ok
          ? "Quote created, but the delivery service returned an unreadable success receipt. Open Quotes and verify before retrying."
          : await readErrorMessage(
              sendResponse,
              "Quote created, but delivery could not be queued",
            );
      }
    } else {
      sendError =
        "Quote created, but its current version was not returned. Refresh before sending it.";
    }
  }

  jar.set({ name: "myst-flash", value: successMessage, path: "/" });
  if (sendError) {
    jar.set({ name: "myst-flash-error", value: sendError, path: "/" });
  }

  if (isCanvass && quoteId && typeof contactId === "string") {
    const repName = principal.name.trim() || "Stonegate";

    let firstName = "there";
    try {
      const lookup = await callAdminApiAs(
        principal,
        `/api/admin/contacts?contactId=${encodeURIComponent(contactId)}&limit=1`,
      );
      if (lookup.ok) {
        const payload = (await lookup.json()) as {
          contacts?: Array<{ firstName?: string | null }>;
        };
        const candidate = payload.contacts?.[0]?.firstName;
        if (candidate && candidate.trim().length) firstName = candidate.trim();
      }
    } catch {
      // ignore lookup failures
    }

    const total =
      typeof envelope.data.breakdown?.total === "number"
        ? envelope.data.breakdown.total
        : null;
    const totalText = total !== null ? `$${total.toFixed(0)}` : "your total";
    const draftBody = `Hey ${firstName}, this is ${repName} with Stonegate Junk Removal. Your quote total is ${totalText}. What day works best for pickup?`;

    let preparedThreadId: string | null = null;
    try {
      const ensured = await callAdminApiAs(
        principal,
        "/api/admin/inbox/threads/ensure",
        {
          method: "POST",
          body: JSON.stringify({ contactId, channel: "sms" }),
        },
      );
      if (!ensured.ok) {
        const message = await readErrorMessage(
          ensured,
          "Quote created, but the Inbox thread could not be prepared",
        );
        jar.set({ name: "myst-flash-error", value: message, path: "/" });
      } else {
        const ensuredPayload = (await ensured.json()) as { threadId?: string };
        const threadId =
          typeof ensuredPayload.threadId === "string"
            ? ensuredPayload.threadId
            : null;
        if (threadId) {
          const draftResponse = await callAdminApiAs(
            principal,
            `/api/admin/inbox/threads/${threadId}/draft`,
            {
              method: "POST",
              body: JSON.stringify({ channel: "sms", body: draftBody }),
            },
          );
          if (draftResponse.ok) {
            preparedThreadId = threadId;
          } else {
            const message = await readErrorMessage(
              draftResponse,
              "Quote created, but the Inbox draft could not be prepared",
            );
            jar.set({
              name: "myst-flash-error",
              value: message,
              path: "/",
            });
          }
        } else {
          jar.set({
            name: "myst-flash-error",
            value: "Quote created, but the Inbox returned no thread ID",
            path: "/",
          });
        }
      }
    } catch {
      jar.set({
        name: "myst-flash-error",
        value: "Quote created, but the Inbox draft could not be prepared",
        path: "/",
      });
    }

    if (preparedThreadId) {
      jar.set({
        name: "myst-flash",
        value: "Quote created. Draft SMS prepared in Inbox.",
        path: "/",
      });
      redirect(
        teamSurfaceHref("inbox", {
          query: { threadId: preparedThreadId },
        }),
      );
    }
  }

  revalidatePath("/team");
}

export async function createContactAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();

  const firstName = formData.get("firstName");
  const lastName = formData.get("lastName");
  const email = formData.get("email");
  const phone = formData.get("phone");
  const salespersonMemberId = formData.get("salespersonMemberId");
  const pipelineStage = formData.get("pipelineStage");
  const pipelineNotes = formData.get("pipelineNotes");
  const addressLine1 = formData.get("addressLine1");
  const city = formData.get("city");
  const state = formData.get("state");
  const postalCode = formData.get("postalCode");

  if (
    typeof firstName !== "string" ||
    typeof lastName !== "string" ||
    firstName.trim().length === 0 ||
    lastName.trim().length === 0
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "First and last name are required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const sourceResult = parseLeadSourceFormData(formData);
  if (!sourceResult.ok) {
    jar.set({ name: "myst-flash-error", value: sourceResult.error, path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    email:
      typeof email === "string" && email.trim().length
        ? email.trim()
        : undefined,
    phone:
      typeof phone === "string" && phone.trim().length
        ? phone.trim()
        : undefined,
    source: buildStoredContactSource(sourceResult.value),
    pipelineStage:
      typeof pipelineStage === "string" && pipelineStage.trim().length
        ? pipelineStage.trim()
        : undefined,
    pipelineNotes:
      typeof pipelineNotes === "string" && pipelineNotes.trim().length
        ? pipelineNotes.trim()
        : undefined,
  };

  if (typeof salespersonMemberId === "string") {
    const trimmed = salespersonMemberId.trim();
    payload["salespersonMemberId"] = trimmed.length > 0 ? trimmed : null;
  }

  const hasAddress =
    typeof addressLine1 === "string" &&
    typeof city === "string" &&
    typeof state === "string" &&
    typeof postalCode === "string" &&
    addressLine1.trim().length > 0 &&
    city.trim().length > 0 &&
    state.trim().length > 0 &&
    postalCode.trim().length > 0;

  const anyAddressField =
    (typeof addressLine1 === "string" && addressLine1.trim().length > 0) ||
    (typeof city === "string" && city.trim().length > 0) ||
    (typeof state === "string" && state.trim().length > 0) ||
    (typeof postalCode === "string" && postalCode.trim().length > 0);

  if (anyAddressField && !hasAddress) {
    jar.set({
      name: "myst-flash-error",
      value:
        "If you add an address, include street, city, state, and postal code",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (hasAddress) {
    payload["property"] = {
      addressLine1: addressLine1.trim(),
      city: city.trim(),
      state: state.trim(),
      postalCode: postalCode.trim(),
    };
  }

  const response = await callAdminApiAs(principal, "/api/admin/contacts", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    let message = "Unable to create contact";
    try {
      const data = (await response.json()) as {
        error?: string;
        existingContact?: {
          firstName?: string | null;
          lastName?: string | null;
        } | null;
      };
      if (data.error === "contact_already_exists") {
        const existingName =
          `${data.existingContact?.firstName ?? ""} ${data.existingContact?.lastName ?? ""}`.trim();
        message =
          existingName.length > 0
            ? `Contact already exists (${existingName}).`
            : "Contact already exists.";
      } else if (data.error) {
        message = data.error.replace(/_/g, " ");
      }
    } catch {
      // ignore
    }
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Contact created", path: "/" });
  revalidatePath("/team");
}

export async function bookAppointmentAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  try {
    const contactId = formData.get("contactId");
    const propertyId = formData.get("propertyId");
    const appointmentType = formData.get("appointmentType");
    const assignedAssociateMemberIdRaw = formData.get(
      "assignedAssociateMemberId",
    );
    const currentAssignedAssociateMemberIdRaw = formData.get(
      "currentAssignedAssociateMemberId",
    );
    const soldByMemberIdRaw = formData.get("soldByMemberId");
    const startAt = formData.get("startAt");
    const durationMinutes = formData.get("durationMinutes");
    const travelBufferMinutes = formData.get("travelBufferMinutes");
    const servicesRaw = formData.get("services");
    const notesRaw = formData.get("notes");
    const instantQuoteIdRaw = formData.get("instantQuoteId");
    const sourceRaw = formData.get("source");

    if (typeof contactId !== "string" || contactId.trim().length === 0) {
      jar.set({
        name: "myst-flash-error",
        value: "Contact ID missing",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }

    const contactIdValue = contactId.trim();
    const bookingSelection = resolveBookingSelection(
      typeof appointmentType === "string" ? appointmentType.trim() : "",
    );
    const isInPersonQuote = bookingSelection === "in_person_quote";
    const appointmentTypeValue = isInPersonQuote ? "in_person_quote" : "job";

    if (typeof startAt !== "string" || startAt.trim().length === 0) {
      jar.set({
        name: "myst-flash-error",
        value: "Start time is required",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }

    const currentAssignedAssociateMemberId =
      typeof currentAssignedAssociateMemberIdRaw === "string" &&
      currentAssignedAssociateMemberIdRaw.trim().length > 0
        ? currentAssignedAssociateMemberIdRaw.trim()
        : null;
    const assignedAssociateMemberId =
      typeof assignedAssociateMemberIdRaw === "string"
        ? assignedAssociateMemberIdRaw.trim().length > 0
          ? assignedAssociateMemberIdRaw.trim()
          : null
        : currentAssignedAssociateMemberId;
    const soldByMemberId =
      typeof soldByMemberIdRaw === "string" &&
      soldByMemberIdRaw.trim().length > 0
        ? soldByMemberIdRaw.trim()
        : null;
    if (!isInPersonQuote && !soldByMemberId) {
      jar.set({
        name: "myst-flash-error",
        value: "Who sold the job is required to book a job.",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }

    let bookingDetailsResult:
      | ReturnType<typeof parseAppointmentBookingFormData>
      | { ok: true; bookingDetails: null; quotedTotalCents: null };

    if (isInPersonQuote) {
      if (typeof propertyId !== "string" || propertyId.trim().length === 0) {
        jar.set({
          name: "myst-flash-error",
          value: "Address is required to book an in-person quote.",
          path: "/",
        });
        revalidatePath("/team");
        return;
      }

      const contactResponse = await callAdminApiAs(
        principal,
        `/api/admin/contacts?contactId=${encodeURIComponent(contactIdValue)}&limit=1`,
      );
      if (!contactResponse.ok) {
        const message = await readErrorMessage(
          contactResponse,
          "Unable to verify contact details for in-person quote.",
        );
        jar.set({ name: "myst-flash-error", value: message, path: "/" });
        revalidatePath("/team");
        return;
      }

      const contactPayload = (await contactResponse
        .json()
        .catch(() => null)) as {
        contacts?: Array<{
          firstName?: string | null;
          lastName?: string | null;
          phone?: string | null;
          phoneE164?: string | null;
        }>;
      } | null;
      const contactRecord = contactPayload?.contacts?.[0] ?? null;
      const hasName = Boolean(
        `${contactRecord?.firstName ?? ""} ${contactRecord?.lastName ?? ""}`.trim(),
      );
      if (!hasName) {
        jar.set({
          name: "myst-flash-error",
          value: "Name is required to book an in-person quote.",
          path: "/",
        });
        revalidatePath("/team");
        return;
      }

      bookingDetailsResult = {
        ok: true,
        bookingDetails: null,
        quotedTotalCents: null,
      };
    } else {
      bookingDetailsResult = parseAppointmentBookingFormData(formData);
      if (!bookingDetailsResult.ok) {
        jar.set({
          name: "myst-flash-error",
          value: bookingDetailsResult.error,
          path: "/",
        });
        revalidatePath("/team");
        return;
      }
    }

    const parsedDuration =
      typeof durationMinutes === "string" ? Number(durationMinutes) : NaN;
    const parsedTravel =
      typeof travelBufferMinutes === "string"
        ? Number(travelBufferMinutes)
        : NaN;

    const services =
      typeof servicesRaw === "string" && servicesRaw.trim().length > 0
        ? servicesRaw
            .split(",")
            .map((value) => value.trim())
            .filter((value) => value.length > 0)
        : !isInPersonQuote
          ? [bookingSelection]
          : [];

    const payload: Record<string, unknown> = {
      contactId: contactIdValue,
      startAt: startAt.trim(),
      durationMinutes:
        Number.isFinite(parsedDuration) && parsedDuration > 0
          ? parsedDuration
          : 60,
      travelBufferMinutes:
        Number.isFinite(parsedTravel) && parsedTravel >= 0 ? parsedTravel : 30,
      services,
    };

    payload["appointmentType"] = appointmentTypeValue;
    if (typeof propertyId === "string" && propertyId.trim().length > 0) {
      payload["propertyId"] = propertyId.trim();
    }
    if (typeof notesRaw === "string" && notesRaw.trim().length > 0) {
      payload["notes"] = notesRaw.trim();
    }
    if (
      typeof instantQuoteIdRaw === "string" &&
      instantQuoteIdRaw.trim().length > 0
    ) {
      payload["instantQuoteId"] = instantQuoteIdRaw.trim();
      payload["source"] =
        typeof sourceRaw === "string" && sourceRaw.trim().length > 0
          ? sourceRaw.trim()
          : "team_instant_quote";
    }
    if (bookingDetailsResult.quotedTotalCents !== null) {
      payload["quotedTotalCents"] = bookingDetailsResult.quotedTotalCents;
    }
    if (bookingDetailsResult.bookingDetails) {
      payload["bookingDetails"] = bookingDetailsResult.bookingDetails;
    }
    if (soldByMemberId) {
      payload["soldByMemberId"] = soldByMemberId;
    }
    if (assignedAssociateMemberId) {
      payload["assignedAssociateMemberId"] = assignedAssociateMemberId;
    }
    const soldByOverrideCodeRaw = formData.get("soldByOverrideCode");
    if (
      typeof soldByOverrideCodeRaw === "string" &&
      soldByOverrideCodeRaw.trim().length > 0
    ) {
      payload["soldByOverrideCode"] = soldByOverrideCodeRaw.trim();
    }

    const assigneeChanged =
      assignedAssociateMemberId !== currentAssignedAssociateMemberId;
    let assigneeUpdated = false;

    if (assigneeChanged) {
      const assigneeResponse = await callAdminApiAs(
        principal,
        `/api/admin/contacts/${encodeURIComponent(contactIdValue)}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            salespersonMemberId: assignedAssociateMemberId,
          }),
        },
      );

      if (!assigneeResponse.ok) {
        const message = await readErrorMessage(
          assigneeResponse,
          "Unable to update assigned associate",
        );
        jar.set({ name: "myst-flash-error", value: message, path: "/" });
        revalidatePath("/team");
        return;
      }

      assigneeUpdated = true;
    }

    const response = await callAdminApiAs(
      principal,
      "/api/admin/booking/book",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );

    if (!response.ok) {
      let rollbackFailed = false;
      if (assigneeUpdated) {
        try {
          const rollbackResponse = await callAdminApiAs(
            principal,
            `/api/admin/contacts/${encodeURIComponent(contactIdValue)}`,
            {
              method: "PATCH",
              body: JSON.stringify({
                salespersonMemberId: currentAssignedAssociateMemberId,
              }),
            },
          );
          rollbackFailed = !rollbackResponse.ok;
        } catch {
          rollbackFailed = true;
        }
      }

      const message = await readErrorMessage(
        response,
        "Unable to book appointment",
      );
      jar.set({
        name: "myst-flash-error",
        value: rollbackFailed
          ? `${message} Assigned associate may need to be reset.`
          : message,
        path: "/",
      });
      revalidatePath("/team");
      return;
    }

    jar.set({ name: "myst-flash", value: "Appointment booked", path: "/" });
    revalidatePath("/team");
  } catch (error) {
    jar.set({
      name: "myst-flash-error",
      value: formatActionError(error, "Unable to book appointment"),
      path: "/",
    });
    revalidatePath("/team");
  }
}

export async function bookInboxAppointmentAction(
  formData: FormData,
): Promise<InboxWorkflowActionResult> {
  const principal = await requireCurrentTeamPrincipal();
  try {
    const contactId = readFormString(formData, "contactId");
    const propertyId = readFormString(formData, "propertyId");
    const propertyLabel = readFormString(formData, "propertyLabel");
    const appointmentType = readFormString(formData, "appointmentType");
    const assignedAssociateMemberId = readFormString(
      formData,
      "assignedAssociateMemberId",
    );
    const soldByMemberId = readFormString(formData, "soldByMemberId");
    const startAt = readFormString(formData, "startAt");
    const durationMinutes = Number(readFormString(formData, "durationMinutes"));
    const travelBufferMinutes = Number(
      readFormString(formData, "travelBufferMinutes"),
    );
    const notes = readFormString(formData, "notes");

    if (!contactId) return { ok: false, error: "Contact ID missing" };
    if (!startAt) return { ok: false, error: "Start time is required" };

    const bookingSelection = resolveBookingSelection(appointmentType);
    const isInPersonQuote = bookingSelection === "in_person_quote";
    if (isInPersonQuote && !propertyId) {
      return {
        ok: false,
        error: "Address is required to book an in-person quote.",
      };
    }
    if (!isInPersonQuote && !soldByMemberId) {
      return {
        ok: false,
        error: "Who sold the job is required to book a job.",
      };
    }

    let bookingDetailsResult:
      | ReturnType<typeof parseAppointmentBookingFormData>
      | { ok: true; bookingDetails: null; quotedTotalCents: null };
    if (isInPersonQuote) {
      bookingDetailsResult = {
        ok: true,
        bookingDetails: null,
        quotedTotalCents: null,
      };
    } else {
      bookingDetailsResult = parseAppointmentBookingFormData(formData);
      if (!bookingDetailsResult.ok) {
        return { ok: false, error: bookingDetailsResult.error };
      }
    }

    const payload: Record<string, unknown> = {
      contactId,
      startAt,
      durationMinutes:
        Number.isFinite(durationMinutes) && durationMinutes > 0
          ? durationMinutes
          : 60,
      travelBufferMinutes:
        Number.isFinite(travelBufferMinutes) && travelBufferMinutes >= 0
          ? travelBufferMinutes
          : 30,
      services: isInPersonQuote ? [] : [bookingSelection],
      appointmentType: isInPersonQuote ? "in_person_quote" : "job",
    };

    if (propertyId) payload["propertyId"] = propertyId;
    if (assignedAssociateMemberId)
      payload["assignedAssociateMemberId"] = assignedAssociateMemberId;
    if (soldByMemberId) payload["soldByMemberId"] = soldByMemberId;
    if (notes) payload["notes"] = notes;
    if (bookingDetailsResult.quotedTotalCents !== null) {
      payload["quotedTotalCents"] = bookingDetailsResult.quotedTotalCents;
    }
    if (bookingDetailsResult.bookingDetails) {
      payload["bookingDetails"] = bookingDetailsResult.bookingDetails;
    }

    const response = await callAdminApiAs(
      principal,
      "/api/admin/booking/book",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    const data = (await response.json().catch(() => null)) as {
      appointment?: { id?: string; startAt?: string | null };
      appointmentId?: string;
      id?: string;
      startAt?: string | null;
      error?: string;
      message?: string;
    } | null;

    if (!response.ok) {
      return {
        ok: false,
        error: data?.message ?? data?.error ?? "Unable to book appointment",
      };
    }

    const recordId =
      data?.appointment?.id ?? data?.appointmentId ?? data?.id ?? undefined;
    const bookedStartAt =
      data?.appointment?.startAt ?? data?.startAt ?? startAt;
    const timeText = formatInboxAppointmentTime(bookedStartAt);
    const addressText = propertyLabel ? ` at ${propertyLabel}` : "";
    const draftText = `You're booked for ${timeText}${addressText}. Reply here if anything changes.`;

    revalidatePath("/team");
    return {
      ok: true,
      draftText,
      recordId,
      refreshKey: String(Date.now()),
    };
  } catch (error) {
    return {
      ok: false,
      error: formatActionError(error, "Unable to book appointment"),
    };
  }
}

export async function rescheduleInboxAppointmentAction(
  formData: FormData,
): Promise<InboxWorkflowActionResult> {
  const principal = await requireCurrentTeamPrincipal();
  try {
    const appointmentId = readFormString(formData, "appointmentId");
    const startAt = buildLocalStartAt(formData);
    if (!appointmentId) return { ok: false, error: "Appointment ID missing" };
    if (!startAt) return { ok: false, error: "Pick a new date and time" };

    const payload: Record<string, unknown> = {};
    const preferredDate = readFormString(formData, "preferredDate");
    const startTime = readFormString(formData, "startTime");
    if (preferredDate && startTime) {
      payload["preferredDate"] = preferredDate;
      payload["startTime"] = startTime;
    } else {
      payload["startAt"] = startAt;
    }

    const response = await callAdminApiAs(
      principal,
      `/api/web/appointments/${encodeURIComponent(appointmentId)}/reschedule`,
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );
    const data = (await response.json().catch(() => null)) as {
      appointmentId?: string;
      startAt?: string | null;
      preferredDate?: string | null;
      error?: string;
      message?: string;
    } | null;

    if (!response.ok) {
      return {
        ok: false,
        error:
          data?.message ?? data?.error ?? "Unable to reschedule appointment",
      };
    }

    const rescheduledAt = data?.startAt ?? startAt;
    const draftText = `I moved your appointment to ${formatInboxAppointmentTime(rescheduledAt)}. Reply if that doesn't work.`;

    revalidatePath("/team");
    return {
      ok: true,
      draftText,
      recordId: data?.appointmentId ?? appointmentId,
      refreshKey: String(Date.now()),
    };
  } catch (error) {
    return {
      ok: false,
      error: formatActionError(error, "Unable to reschedule appointment"),
    };
  }
}

export async function updateAppointmentBookingDetailsAction(
  formData: FormData,
): Promise<AppointmentMetadataActionResult> {
  const principal = await requireCurrentTeamPrincipal();
  const appointmentId = formData.get("appointmentId");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");

  if (
    !hasTeamPermission(principal, "appointments.update") ||
    !hasTeamPermission(principal, "payments.collect")
  ) {
    return {
      ok: false,
      message:
        "You need appointment-update and payment-collection access to change quoted booking details. No change was made.",
    };
  }
  if (
    typeof appointmentId !== "string" ||
    !isUuid(appointmentId.trim()) ||
    !isExactAppointmentVersion(expectedVersion) ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    return {
      ok: false,
      message:
        "This booking-details form is stale or incomplete. Refresh the appointment before trying again.",
    };
  }

  const bookingDetailsResult = parseAppointmentBookingFormData(formData);
  if (!bookingDetailsResult.ok) {
    return { ok: false, message: bookingDetailsResult.error };
  }

  let response: Response;
  try {
    response = await callAdminMutationWithSafeReplay(
      principal,
      `/api/appointments/${encodeURIComponent(appointmentId.trim())}`,
      {
        method: "PATCH",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": `"${expectedVersion}"`,
        },
        body: JSON.stringify({
          quotedTotalCents: bookingDetailsResult.quotedTotalCents,
          bookingDetails: bookingDetailsResult.bookingDetails,
        }),
      },
    );
  } catch (error) {
    return {
      ok: false,
      message: readTeamMutationException(
        error,
        "Unable to update booking details",
      ),
    };
  }

  if (!response.ok) {
    const message = await readTeamMutationError(
      response,
      "Unable to update booking details",
    );
    return { ok: false, message };
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  const envelope = parseAppointmentBookingDetailsMutationSuccess(payload, {
    appointmentId: appointmentId.trim(),
    actorId: principal.memberId,
    expectedVersion,
    quotedTotalCents: bookingDetailsResult.quotedTotalCents,
    bookingDetails: bookingDetailsResult.bookingDetails,
  });
  if (!envelope) {
    return {
      ok: false,
      message:
        "The appointment service returned an unreadable booking-details receipt. Refresh before retrying; no success is being claimed.",
    };
  }

  revalidatePath("/team");
  return {
    ok: true,
    message: envelope.data.changed
      ? "Booking details updated."
      : "Booking details were already up to date.",
    version: envelope.data.version,
  };
}

function withResolvedLeadSourceFields(formData: FormData): FormData {
  const resolved = new FormData();
  formData.forEach((value, key) => {
    resolved.append(key, value);
  });

  const sourceType = formData.get("sourceType");
  if (typeof sourceType === "string" && sourceType.trim().length > 0) {
    return resolved;
  }

  const resolvedType = formData.get("resolvedSourceType");
  if (typeof resolvedType !== "string" || resolvedType.trim().length === 0) {
    return resolved;
  }

  resolved.set("sourceType", resolvedType.trim());

  const resolvedTeamMemberId = formData.get("resolvedSourceTeamMemberId");
  if (
    typeof resolvedTeamMemberId === "string" &&
    resolvedTeamMemberId.trim().length > 0
  ) {
    resolved.set("sourceTeamMemberId", resolvedTeamMemberId.trim());
  }

  const resolvedReferralName = formData.get("resolvedSourceReferralName");
  if (
    typeof resolvedReferralName === "string" &&
    resolvedReferralName.trim().length > 0
  ) {
    resolved.set("sourceReferralName", resolvedReferralName.trim());
  }

  return resolved;
}

export async function convertAppointmentToJobAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  if (!hasTeamPermission(principal, "payments.collect")) {
    jar.set({
      name: "myst-flash-error",
      value: "You do not have permission to convert quoted pricing into a job.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  const appointmentId = formData.get("appointmentId");
  const startAt = formData.get("startAt");
  const soldByMemberId = formData.get("soldByMemberId");
  const expectedSoldByMemberId = parseNullableUuid(
    formData.get("expectedSoldByMemberId"),
  );
  const expectedAssignedSalespersonMemberId = parseNullableUuid(
    formData.get("expectedAssignedSalespersonMemberId"),
  );
  const expectedStatus = formData.get("expectedStatus");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");

  if (typeof appointmentId !== "string" || !isUuid(appointmentId.trim())) {
    jar.set({
      name: "myst-flash-error",
      value: "Appointment ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (typeof startAt !== "string" || startAt.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Job date and time are required.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (typeof soldByMemberId !== "string" || !isUuid(soldByMemberId.trim())) {
    jar.set({
      name: "myst-flash-error",
      value: "Who sold the job is required.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (
    expectedSoldByMemberId === undefined ||
    expectedAssignedSalespersonMemberId === undefined
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "Seller attribution is stale. Refresh before converting.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  const sellerBaseline =
    expectedSoldByMemberId ?? expectedAssignedSalespersonMemberId;
  if (
    sellerBaseline &&
    sellerBaseline !== soldByMemberId.trim() &&
    !hasTeamPermission(principal, "commissions.manage")
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "You do not have permission to change seller attribution.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (
    typeof expectedStatus !== "string" ||
    !["requested", "confirmed", "completed", "no_show", "canceled"].includes(
      expectedStatus.trim(),
    ) ||
    typeof expectedVersion !== "string" ||
    !Number.isFinite(Date.parse(expectedVersion.trim())) ||
    new Date(expectedVersion.trim()).toISOString() !== expectedVersion.trim() ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "This conversion form is stale. Refresh and try again.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (
    expectedStatus.trim() === "completed" &&
    !hasTeamPermission(principal, "appointments.override_conflicts")
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "You do not have permission to convert a completed quote.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const bookingDetailsResult = parseAppointmentBookingFormData(
    withResolvedLeadSourceFields(formData),
  );
  if (!bookingDetailsResult.ok) {
    jar.set({
      name: "myst-flash-error",
      value: bookingDetailsResult.error,
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  let response: Response;
  try {
    response = await callAdminMutationWithSafeReplay(
      principal,
      `/api/appointments/${encodeURIComponent(appointmentId.trim())}/convert`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": `"${expectedVersion.trim()}"`,
        },
        body: JSON.stringify({
          startAt: startAt.trim(),
          soldByMemberId: soldByMemberId.trim(),
          expectedSoldByMemberId,
          expectedAssignedSalespersonMemberId,
          quotedTotalCents: bookingDetailsResult.quotedTotalCents,
          bookingDetails: bookingDetailsResult.bookingDetails,
          expectedStatus: expectedStatus.trim(),
        }),
      },
    );
  } catch (error) {
    jar.set({
      name: "myst-flash-error",
      value: readTeamMutationException(error, "Unable to convert quote"),
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to convert quote");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const envelope = await readTeamMutationSuccess<{
    appointmentId?: unknown;
    appointmentType?: unknown;
    status?: unknown;
    version?: unknown;
    calendarSync?: unknown;
    completedAtomically?: unknown;
  }>(response);
  if (
    !envelope ||
    envelope.data.appointmentId !== appointmentId.trim() ||
    envelope.data.appointmentType !== "job" ||
    envelope.data.status !== "confirmed" ||
    typeof envelope.data.version !== "string" ||
    !["requested", "not_required"].includes(
      String(envelope.data.calendarSync),
    ) ||
    envelope.data.completedAtomically !== false ||
    envelope.receipt.entityType !== "appointment" ||
    envelope.receipt.entityId !== appointmentId.trim() ||
    envelope.receipt.version !== envelope.data.version
  ) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The appointment service returned an unreadable conversion receipt. Refresh before retrying; no success is being claimed.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  jar.set({
    name: "myst-flash",
    value:
      envelope.data.calendarSync === "requested"
        ? "Quote converted to job. Google Calendar sync queued."
        : "Quote converted to job. No Google Calendar change was required.",
    path: "/",
  });
  revalidatePath("/team");
}

export type AppointmentMetadataActionResult =
  | { ok: true; message: string; version: string }
  | { ok: false; message: string };

export async function updateAppointmentSoldByAction(
  formData: FormData,
): Promise<AppointmentMetadataActionResult> {
  const principal = await requireCurrentTeamPrincipal();
  const appointmentId = formData.get("appointmentId");
  const soldByMemberId = formData.get("soldByMemberId");
  const expectedStatus = formData.get("expectedStatus");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");

  if (
    !hasTeamPermission(principal, "appointments.update") ||
    !hasTeamPermission(principal, "commissions.manage")
  ) {
    return {
      ok: false,
      message:
        "You need appointment-update and commission-management access to change seller attribution. No change was made.",
    };
  }
  if (
    typeof appointmentId !== "string" ||
    !isUuid(appointmentId.trim()) ||
    typeof soldByMemberId !== "string" ||
    !isUuid(soldByMemberId.trim()) ||
    !isAppointmentMutationStatus(expectedStatus) ||
    !isExactAppointmentVersion(expectedVersion) ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    return {
      ok: false,
      message:
        "This seller form is stale or incomplete. Refresh the appointment and choose an active seller.",
    };
  }

  let response: Response;
  try {
    response = await callAdminMutationWithSafeReplay(
      principal,
      `/api/appointments/${encodeURIComponent(appointmentId.trim())}/sold-by`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": `"${expectedVersion}"`,
        },
        body: JSON.stringify({ soldByMemberId: soldByMemberId.trim() }),
      },
    );
  } catch (error) {
    return {
      ok: false,
      message: readTeamMutationException(
        error,
        "Unable to update who sold the job",
      ),
    };
  }

  if (!response.ok) {
    const message = await readTeamMutationError(
      response,
      "Unable to update who sold the job",
    );
    return { ok: false, message };
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  const envelope = parseAppointmentSoldByMutationSuccess(payload, {
    appointmentId: appointmentId.trim(),
    actorId: principal.memberId,
    expectedVersion,
    soldByMemberId: soldByMemberId.trim(),
    expectedStatus,
  });
  if (!envelope) {
    return {
      ok: false,
      message:
        "The appointment service returned an unreadable seller-attribution receipt. Refresh before retrying; no success is being claimed.",
    };
  }

  revalidatePath("/team");
  return {
    ok: true,
    message: envelope.data.changed
      ? envelope.data.commissionsRefreshed
        ? "Seller updated and the draft payout report was refreshed."
        : "Seller updated."
      : "Seller attribution was already up to date.",
    version: envelope.data.version,
  };
}

export async function scheduleQuoteFollowupAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const appointmentId = formData.get("appointmentId");
  const dueAt = formData.get("dueAt");
  const note = formData.get("note");

  if (typeof appointmentId !== "string" || appointmentId.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Appointment ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (typeof dueAt !== "string" || dueAt.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Follow-up date and time are required.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/appointments/${encodeURIComponent(appointmentId.trim())}/quote-follow-up`,
    {
      method: "POST",
      body: JSON.stringify({
        dueAt: dueAt.trim(),
        note:
          typeof note === "string" && note.trim().length > 0
            ? note.trim()
            : null,
      }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to schedule quote follow-up",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({
    name: "myst-flash",
    value: "Quote follow-up scheduled",
    path: "/",
  });
  revalidatePath("/team");
}

async function readErrorMessage(
  response: Response,
  fallback: string,
): Promise<string> {
  return readTeamMutationError(response, fallback);
}

async function readJsonRecord(
  response: Response,
): Promise<Record<string, unknown>> {
  const data = (await response.json().catch(() => null)) as unknown;
  return data && typeof data === "object"
    ? (data as Record<string, unknown>)
    : {};
}

function formatActionError(error: unknown, fallback: string): string {
  return readTeamMutationException(error, fallback);
}

function parseUsdToCents(value: FormDataEntryValue | null): number | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[$,]/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

export async function createCanvassLeadAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();

  const firstName = formData.get("firstName");
  const lastName = formData.get("lastName");
  const phone = formData.get("phone");
  const email = formData.get("email");
  const addressLine1 = formData.get("addressLine1");
  const city = formData.get("city");
  const state = formData.get("state");
  const postalCode = formData.get("postalCode");
  const salespersonMemberId = formData.get("salespersonMemberId");

  const hasPhone = typeof phone === "string" && phone.trim().length > 0;
  const hasEmail = typeof email === "string" && email.trim().length > 0;

  if (typeof firstName !== "string" || firstName.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "First name is required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (typeof lastName !== "string" || lastName.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Last name is required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (!hasPhone && !hasEmail) {
    jar.set({
      name: "myst-flash-error",
      value: "Phone or email is required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (
    typeof addressLine1 !== "string" ||
    typeof city !== "string" ||
    typeof state !== "string" ||
    typeof postalCode !== "string" ||
    addressLine1.trim().length === 0 ||
    city.trim().length === 0 ||
    state.trim().length === 0 ||
    postalCode.trim().length === 0
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "Full address is required for canvass leads",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    pipelineStage: "contacted",
    source: "canvass",
    property: {
      addressLine1: addressLine1.trim(),
      city: city.trim(),
      state: state.trim(),
      postalCode: postalCode.trim(),
    },
  };

  if (typeof phone === "string" && phone.trim().length > 0) {
    payload["phone"] = phone.trim();
  }
  if (typeof email === "string" && email.trim().length > 0) {
    payload["email"] = email.trim();
  }
  if (
    typeof salespersonMemberId === "string" &&
    salespersonMemberId.trim().length > 0
  ) {
    payload["salespersonMemberId"] = salespersonMemberId.trim();
  }

  const response = await callAdminApiAs(principal, "/api/admin/contacts", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  type ContactCreateResponse =
    | { contact?: { id: string; salespersonMemberId?: string | null } }
    | { existingContact?: { id?: string } };

  let data: ContactCreateResponse | null = null;
  try {
    data = (await response.json()) as ContactCreateResponse;
  } catch {
    data = null;
  }

  if (!response.ok) {
    if (response.status === 409) {
      const existingId =
        data &&
        "existingContact" in data &&
        data.existingContact &&
        typeof data.existingContact.id === "string"
          ? data.existingContact.id
          : null;
      if (existingId) {
        jar.set({
          name: "myst-flash-error",
          value: "Contact already exists. Opening existing record.",
          path: "/",
        });
        redirect(
          quoteWorkspaceHref("create", {
            query: { contactId: existingId },
          }),
        );
      }
    }

    const message = await readErrorMessage(
      response,
      "Unable to create canvass lead",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const contactId =
    data &&
    "contact" in data &&
    data.contact &&
    typeof data.contact.id === "string"
      ? data.contact.id
      : null;
  if (!contactId) {
    jar.set({
      name: "myst-flash-error",
      value: "Canvass lead created, but no contact ID returned",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const assigneeFromForm =
    typeof salespersonMemberId === "string" &&
    salespersonMemberId.trim().length > 0
      ? salespersonMemberId.trim()
      : null;
  const assigneeFromApi =
    data &&
    "contact" in data &&
    data.contact &&
    typeof data.contact.salespersonMemberId === "string"
      ? data.contact.salespersonMemberId
      : null;
  const assignee = assigneeFromForm ?? assigneeFromApi;

  try {
    const taskResponse = await callAdminApiAs(
      principal,
      "/api/admin/crm/tasks",
      {
        method: "POST",
        body: JSON.stringify({
          contactId,
          title: "Canvass lead",
          assignedTo: assignee ?? undefined,
          notes: "kind=canvass",
        }),
      },
    );
    if (!taskResponse.ok) {
      const message = await readErrorMessage(
        taskResponse,
        "Lead created, but the canvass task could not be added",
      );
      jar.set({ name: "myst-flash-error", value: message, path: "/" });
    }
  } catch {
    jar.set({
      name: "myst-flash-error",
      value: "Lead created, but the canvass task could not be added",
      path: "/",
    });
  }

  jar.set({ name: "myst-flash", value: "Canvass lead created", path: "/" });
  redirect(
    quoteWorkspaceHref("create", {
      query: {
        contactId,
        memberId: assignee ?? undefined,
      },
    }),
  );
}

export async function createCanvassFollowupAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  if (!hasTeamPermission(principal, "contacts.write")) {
    jar.set({
      name: "myst-flash-error",
      value: "You do not have permission to schedule contact reminders.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  const contactId = formData.get("contactId");
  const dueAt = formData.get("dueAt");
  const assignedTo = formData.get("assignedTo");
  const notes = formData.get("notes");
  const idempotencyKey = formData.get("idempotencyKey");

  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Contact ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (typeof dueAt !== "string" || dueAt.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Follow-up time required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  const dueDate = new Date(dueAt.trim());
  if (Number.isNaN(dueDate.getTime())) {
    jar.set({
      name: "myst-flash-error",
      value: "Choose a valid follow-up date and time.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (!isValidTeamIdempotencyKey(idempotencyKey)) {
    jar.set({
      name: "myst-flash-error",
      value: "This follow-up form expired. Refresh and try again.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    contactId: contactId.trim(),
    title: "Canvass follow-up",
    dueAt: dueDate.toISOString(),
    notes: `kind=canvass${typeof notes === "string" && notes.trim().length ? `\nnotes=${notes.trim()}` : ""}`,
  };

  if (typeof assignedTo === "string" && assignedTo.trim().length > 0) {
    payload["assignedTo"] = assignedTo.trim();
  }

  try {
    const response = await callAdminMutationWithSafeReplay(
      principal,
      "/api/admin/crm/reminders",
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify(payload),
      },
    );
    if (!response.ok) {
      jar.set({
        name: "myst-flash-error",
        value: await readTeamMutationError(
          response,
          "Unable to schedule follow-up",
        ),
        path: "/",
      });
      revalidatePath("/team");
      return;
    }
    const result = (await response.json().catch(() => null)) as unknown;
    if (
      !parseReminderMutationSuccess(result, {
        actorId: principal.memberId,
        contactId: contactId.trim(),
        status: "open",
      })
    ) {
      jar.set({
        name: "myst-flash-error",
        value:
          "The reminder service returned an unreadable receipt. No success is being claimed; refresh before retrying.",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }
  } catch (error) {
    jar.set({
      name: "myst-flash-error",
      value: readTeamMutationException(
        error,
        "The reminder result could not be confirmed",
      ),
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Follow-up scheduled", path: "/" });
  revalidatePath("/team");
}

export async function startContactCallAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  if (!hasTeamPermission(principal, "calls.place")) {
    jar.set({
      name: "myst-flash-error",
      value: "You do not have permission to place calls.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  const contactId = formData.get("contactId");
  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Contact ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const taskId = formData.get("taskId");
  const resolvedTaskId =
    typeof taskId === "string" && isUuid(taskId.trim()) ? taskId.trim() : null;
  const submittedKey = formData.get("idempotencyKey");
  const explicitNewAttempt = formData.get("explicitNewAttempt");
  if (!isValidTeamIdempotencyKey(submittedKey)) {
    jar.set({
      name: "myst-flash-error",
      value: "This call action expired. Refresh before placing a call.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const scopeHash = manualCallAttemptScope(contactId.trim(), resolvedTaskId);
  const attempts = parseManualCallAttemptStore(
    jar.get(MANUAL_CALL_ATTEMPT_COOKIE)?.value,
  );
  const existingAttempt = findManualCallAttempt(attempts, scopeHash);
  let idempotencyKey = submittedKey;
  if (
    existingAttempt?.state === "pending" ||
    existingAttempt?.state === "ambiguous"
  ) {
    idempotencyKey = existingAttempt.key;
  } else if (existingAttempt?.state === "confirmed_not_sent") {
    if (explicitNewAttempt !== "START NEW CALL") {
      jar.set({
        name: "myst-flash-error",
        value:
          "Twilio confirmed the previous attempt was not sent. Use the explicit Call button again to start a new attempt.",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }
    if (submittedKey === existingAttempt.key) {
      jar.set({
        name: "myst-flash-error",
        value:
          "The previous confirmed-not-sent key is still on this page. Refresh, then explicitly start a new call.",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }
  }

  const setAttemptCookie = (value: string): void => {
    jar.set({
      name: MANUAL_CALL_ATTEMPT_COOKIE,
      value,
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 7 * 24 * 60 * 60,
    });
  };
  setAttemptCookie(
    storeManualCallAttempt(attempts, {
      scopeHash,
      key: idempotencyKey,
      state: "pending",
    }),
  );

  try {
    const response = await callAdminApiAs(principal, "/api/admin/calls/start", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        contactId: contactId.trim(),
        ...(resolvedTaskId ? { taskId: resolvedTaskId } : {}),
      }),
    });

    if (!response.ok) {
      const metadata = readManualCallAttemptResponseMetadata(response);
      setAttemptCookie(
        storeManualCallAttempt(attempts, {
          scopeHash,
          key: idempotencyKey,
          state:
            metadata?.state === "confirmed_not_sent" &&
            metadata.newAttempt === "explicit"
              ? "confirmed_not_sent"
              : "ambiguous",
        }),
      );
      const message = await readErrorMessage(response, "Unable to start call");
      jar.set({ name: "myst-flash-error", value: message, path: "/" });
      revalidatePath("/team");
      return;
    }

    const receipt = await readManualCallMutationSuccess(
      response,
      contactId.trim(),
    );
    if (!receipt) {
      setAttemptCookie(
        storeManualCallAttempt(attempts, {
          scopeHash,
          key: idempotencyKey,
          state: "ambiguous",
        }),
      );
      jar.set({
        name: "myst-flash-error",
        value:
          "The call service returned an unreadable success receipt. No success is being claimed; refresh before retrying.",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }

    setAttemptCookie(removeManualCallAttempt(attempts, scopeHash));

    jar.set({
      name: "myst-flash",
      value:
        receipt.data.state === "succeeded"
          ? "The signed call callback confirmed a completed customer bridge."
          : receipt.data.state === "failed"
            ? "The signed call callback confirmed that the customer did not connect. Follow-up tasks remain open."
            : "The salesperson call is active. Customer connection and task outcomes are still pending.",
      path: "/",
    });
  } catch (error) {
    setAttemptCookie(
      storeManualCallAttempt(attempts, {
        scopeHash,
        key: idempotencyKey,
        state: "ambiguous",
      }),
    );
    jar.set({
      name: "myst-flash-error",
      value: readTeamMutationException(error, "Unable to start call"),
      path: "/",
    });
  }
  revalidatePath("/team");
}

export async function reconcileManualCallAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  if (!hasTeamPermission(principal, "calls.reconcile")) {
    jar.set({
      name: "myst-flash-error",
      value: "You do not have permission to reconcile calls.",
      path: "/",
    });
    revalidatePath(teamSurfaceHref("sales-hq"));
    return;
  }
  const callOperationId = readFormString(formData, "callOperationId");
  const expectedVersion = readFormString(formData, "expectedVersion");
  const idempotencyKey = readFormString(formData, "idempotencyKey");
  const confirmation = readFormString(formData, "confirmation");
  const outcome = readFormString(formData, "outcome");
  const evidenceType = readFormString(formData, "evidenceType");
  const providerOperationId = readFormString(formData, "providerOperationId");
  const providerStatusRaw = readFormString(formData, "providerStatus");
  const reason = readFormString(formData, "reason");
  const providerStatus = providerStatusRaw
    ? Number.parseInt(providerStatusRaw, 10)
    : null;

  if (
    !isUuid(callOperationId) ||
    !/^[1-9][0-9]{0,9}$/u.test(expectedVersion) ||
    idempotencyKey !==
      buildCallReconciliationScope(
        "manual",
        callOperationId,
        Number(expectedVersion),
      ) ||
    confirmation !== "RECONCILE CALL" ||
    ![
      "confirmed_connected",
      "confirmed_not_connected",
      "confirmed_not_dispatched",
      "confirmed_active",
      "still_uncertain",
    ].includes(outcome) ||
    ![
      "provider_call_record",
      "provider_no_matching_call",
      "provider_support_response",
      "operator_investigation",
    ].includes(evidenceType) ||
    reason.length < 20 ||
    reason.length > 1000 ||
    (providerStatus !== null &&
      (!Number.isInteger(providerStatus) ||
        providerStatus < 100 ||
        providerStatus > 599))
  ) {
    jar.set({
      name: "myst-flash-error",
      value:
        'Reconciliation needs current evidence, a detailed reason, and the exact confirmation "RECONCILE CALL".',
      path: "/",
    });
    revalidatePath(teamSurfaceHref("sales-hq"));
    return;
  }
  const reconciliationOutcome = outcome as ManualCallReconciliationOutcome;
  const reconciliationEvidenceType =
    evidenceType as ManualCallReconciliationEvidenceType;
  const requestBody = {
    callOperationId,
    confirmation,
    outcome: reconciliationOutcome,
    evidenceType: reconciliationEvidenceType,
    providerOperationId: providerOperationId || null,
    providerStatus,
    reason,
  };
  const resolvedIdempotencyKey = buildCallReconciliationIdempotencyKey({
    kind: "manual",
    operationId: callOperationId,
    expectedVersion: Number(expectedVersion),
    payload: requestBody,
  });

  try {
    const response = await callAdminMutationWithSafeReplay(
      principal,
      "/api/admin/calls/reconciliation",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": resolvedIdempotencyKey,
          "If-Match": expectedVersion,
        },
        body: JSON.stringify(requestBody),
      },
    );
    if (!response.ok) {
      jar.set({
        name: "myst-flash-error",
        value: await readErrorMessage(
          response,
          "The call reconciliation could not be saved.",
        ),
        path: "/",
      });
      revalidatePath(teamSurfaceHref("sales-hq"));
      return;
    }

    const payload: unknown = await response.json().catch(() => null);
    if (
      !isManualCallReconciliationSuccess(payload, {
        callOperationId,
        outcome: reconciliationOutcome,
        evidenceType: reconciliationEvidenceType,
        previousVersion: Number(expectedVersion),
      })
    ) {
      jar.set({
        name: "myst-flash-error",
        value:
          "The reconciliation response was incomplete. No resolution is being claimed; refresh before doing anything else.",
        path: "/",
      });
      revalidatePath(teamSurfaceHref("sales-hq"));
      return;
    }

    jar.set({
      name: "myst-flash",
      value:
        reconciliationOutcome === "still_uncertain" ||
        reconciliationOutcome === "confirmed_active"
          ? "The investigation note was saved. This contact remains blocked from new calls."
          : "The review was saved and the contact call block was cleared.",
      path: "/",
    });
  } catch {
    jar.set({
      name: "myst-flash-error",
      value:
        "The exact reconciliation request was retried safely, but its result is still unconfirmed. Refresh the queue and verify its version and evidence before submitting anything else.",
      path: "/",
    });
  }
  revalidatePath(teamSurfaceHref("sales-hq"));
}

export async function reconcileSalesEscalationCallAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  if (!hasTeamPermission(principal, "calls.reconcile")) {
    jar.set({
      name: "myst-flash-error",
      value: "You do not have permission to reconcile calls.",
      path: "/",
    });
    revalidatePath(teamSurfaceHref("sales-hq"));
    return;
  }

  const operationId = readFormString(formData, "callOperationId");
  const expectedVersion = readFormString(formData, "expectedVersion");
  const idempotencyKey = readFormString(formData, "idempotencyKey");
  const confirmation = readFormString(formData, "confirmation");
  const outcome = readFormString(formData, "outcome");
  const evidenceType = readFormString(formData, "evidenceType");
  const providerOperationId = readFormString(formData, "providerOperationId");
  const providerCustomerOperationId = readFormString(
    formData,
    "providerCustomerOperationId",
  );
  const providerCallStatus = readFormString(formData, "providerCallStatus");
  const providerCustomerStatus = readFormString(
    formData,
    "providerCustomerStatus",
  );
  const durationRaw = readFormString(formData, "connectedDurationSec");
  const connectedDurationSec = durationRaw
    ? Number.parseInt(durationRaw, 10)
    : null;
  const reason = readFormString(formData, "reason");
  const statuses = [
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
  ];

  if (
    !isUuid(operationId) ||
    !/^[1-9][0-9]{0,9}$/u.test(expectedVersion) ||
    idempotencyKey !==
      buildCallReconciliationScope(
        "sales_escalation",
        operationId,
        Number(expectedVersion),
      ) ||
    confirmation !== "RECONCILE CALL" ||
    ![
      "confirmed_dispatched",
      "confirmed_connected",
      "confirmed_not_dispatched",
    ].includes(outcome) ||
    ![
      "provider_call_record",
      "provider_no_matching_call",
      "provider_support_response",
    ].includes(evidenceType) ||
    (providerOperationId !== "" &&
      !/^CA[0-9a-f]{32}$/iu.test(providerOperationId)) ||
    (providerCustomerOperationId !== "" &&
      !/^CA[0-9a-f]{32}$/iu.test(providerCustomerOperationId)) ||
    (providerCallStatus !== "" && !statuses.includes(providerCallStatus)) ||
    (providerCustomerStatus !== "" &&
      !statuses.includes(providerCustomerStatus)) ||
    (connectedDurationSec !== null &&
      (!Number.isInteger(connectedDurationSec) ||
        connectedDurationSec < 1 ||
        connectedDurationSec > 86_400)) ||
    reason.length < 20 ||
    reason.length > 1000
  ) {
    jar.set({
      name: "myst-flash-error",
      value:
        'Reconciliation needs current Twilio evidence, a detailed reason, and the exact confirmation "RECONCILE CALL".',
      path: "/",
    });
    revalidatePath(teamSurfaceHref("sales-hq"));
    return;
  }

  const reconciliationOutcome =
    outcome as SalesEscalationCallReconciliationOutcome;
  const reconciliationEvidenceType =
    evidenceType as SalesEscalationCallReconciliationEvidenceType;
  const requestBody = {
    salesEscalationOperationId: operationId,
    confirmation,
    outcome: reconciliationOutcome,
    evidenceType: reconciliationEvidenceType,
    providerOperationId: providerOperationId || null,
    providerCustomerOperationId: providerCustomerOperationId || null,
    providerCallStatus: providerCallStatus || null,
    providerCustomerStatus: providerCustomerStatus || null,
    connectedDurationSec,
    reason,
  };
  const resolvedIdempotencyKey = buildCallReconciliationIdempotencyKey({
    kind: "sales_escalation",
    operationId,
    expectedVersion: Number(expectedVersion),
    payload: requestBody,
  });
  try {
    const response = await callAdminMutationWithSafeReplay(
      principal,
      "/api/admin/calls/reconciliation/sales-escalations",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": resolvedIdempotencyKey,
          "If-Match": expectedVersion,
        },
        body: JSON.stringify(requestBody),
      },
    );
    if (!response.ok) {
      jar.set({
        name: "myst-flash-error",
        value: await readErrorMessage(
          response,
          "The escalation-call reconciliation could not be saved.",
        ),
        path: "/",
      });
      revalidatePath(teamSurfaceHref("sales-hq"));
      return;
    }

    const payload: unknown = await response.json().catch(() => null);
    if (
      !isSalesEscalationCallReconciliationSuccess(payload, {
        operationId,
        outcome: reconciliationOutcome,
        evidenceType: reconciliationEvidenceType,
        previousVersion: Number(expectedVersion),
        providerOperationId: providerOperationId || null,
      })
    ) {
      jar.set({
        name: "myst-flash-error",
        value:
          "The reconciliation response was incomplete. No resolution is being claimed; refresh before doing anything else.",
        path: "/",
      });
      revalidatePath(teamSurfaceHref("sales-hq"));
      return;
    }

    jar.set({
      name: "myst-flash",
      value:
        reconciliationOutcome === "confirmed_dispatched"
          ? "The dispatch evidence was saved. This contact remains blocked while the customer outcome is unresolved."
          : reconciliationOutcome === "confirmed_connected"
            ? "The completed connection was recorded, its task outcome was checked, and the call block was cleared."
            : "The no-dispatch evidence was recorded and the call block was cleared. No provider retry was sent.",
      path: "/",
    });
  } catch {
    jar.set({
      name: "myst-flash-error",
      value:
        "The exact reconciliation request was retried safely, but its result is still unconfirmed. Refresh the queue and verify its version and evidence before submitting anything else.",
      path: "/",
    });
  }
  revalidatePath(teamSurfaceHref("sales-hq"));
}

export async function openContactThreadAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const contactId = formData.get("contactId");
  const channel = formData.get("channel");

  const resolvedContactId =
    typeof contactId === "string" ? contactId.trim() : "";
  const resolvedChannel = typeof channel === "string" ? channel.trim() : "sms";

  if (!resolvedContactId) {
    jar.set({
      name: "myst-flash-error",
      value: "Contact ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (resolvedChannel === "dm") {
    jar.set({
      name: "myst-flash-error",
      value: "Messenger thread not found yet.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const ensureRes = await callAdminApiAs(
    principal,
    "/api/admin/inbox/threads/ensure",
    {
      method: "POST",
      body: JSON.stringify({
        contactId: resolvedContactId,
        channel: resolvedChannel,
      }),
    },
  );

  if (!ensureRes.ok) {
    const message = await readErrorMessage(
      ensureRes,
      "Unable to open a thread for this contact",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const ensurePayload = (await ensureRes.json().catch(() => null)) as {
    threadId?: string;
  } | null;
  const threadId =
    typeof ensurePayload?.threadId === "string"
      ? ensurePayload.threadId.trim()
      : "";
  if (!threadId) {
    jar.set({
      name: "myst-flash-error",
      value: "Unable to open a thread for this contact",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  redirect(
    teamSurfaceHref("inbox", {
      query: {
        threadId,
        contactId: resolvedContactId,
        channel: resolvedChannel,
      },
    }),
  );
}

export async function sendDraftMessageAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const messageId = formData.get("messageId");
  const idempotencyKey = formData.get("idempotencyKey");
  const threadId = formData.get("threadId");
  const contactId = formData.get("contactId");
  const channel = formData.get("channel");
  if (
    typeof messageId !== "string" ||
    messageId.trim().length === 0 ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "The draft-send request expired. Refresh the Inbox and try again.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminMutationWithSafeReplay(
      principal,
      `/api/admin/inbox/messages/${encodeURIComponent(messageId.trim())}/retry`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey.trim() },
        body: JSON.stringify({}),
      },
    ),
    {
      success: "Message queued for sending.",
      failure: "Unable to send draft",
      requireReceipt: true,
    },
  );
  await setMutationFlash(feedback);
  revalidatePath(teamSurfaceHref("inbox"));
  if (!feedback.ok) return;
  if (typeof threadId === "string" && threadId.trim().length > 0) {
    const resolvedChannel = typeof channel === "string" ? channel.trim() : "";
    const resolvedContactId =
      typeof contactId === "string" ? contactId.trim() : "";
    redirect(
      teamSurfaceHref("inbox", {
        query: {
          threadId: threadId.trim(),
          channel: resolvedChannel || undefined,
          contactId: resolvedContactId || undefined,
          r: Date.now(),
        },
      }),
    );
  }
}

export async function updateContactAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const contactId = formData.get("contactId");
  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Contact ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {};
  const stringFields: Array<
    [keyof Record<string, unknown>, string | FormDataEntryValue | null]
  > = [
    ["firstName", formData.get("firstName")],
    ["lastName", formData.get("lastName")],
    ["email", formData.get("email")],
    ["phone", formData.get("phone")],
  ];

  for (const [key, value] of stringFields) {
    if (typeof value === "string") {
      payload[key] = value.trim();
    }
  }

  const salespersonMemberId = formData.get("salespersonMemberId");
  if (typeof salespersonMemberId === "string") {
    payload["salespersonMemberId"] =
      salespersonMemberId.trim().length > 0 ? salespersonMemberId.trim() : null;
  }

  if (Object.keys(payload).length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "No changes to apply",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/admin/contacts/${contactId}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to update contact",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Contact updated", path: "/" });
  revalidatePath("/team");
}

export async function updateContactNameAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const contactId = formData.get("contactId");
  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Contact ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const firstNameRaw = formData.get("firstName");
  const lastNameRaw = formData.get("lastName");
  const firstName = typeof firstNameRaw === "string" ? firstNameRaw.trim() : "";
  const lastName = typeof lastNameRaw === "string" ? lastNameRaw.trim() : "";

  if (!firstName.length) {
    jar.set({
      name: "myst-flash-error",
      value: "First name is required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = { firstName };
  if (lastName.length) payload["lastName"] = lastName;

  const response = await callAdminApiAs(
    principal,
    `/api/admin/contacts/${contactId.trim()}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to update contact name",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Contact updated", path: "/" });
  revalidatePath("/team");
}

export async function deleteContactAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const contactId = formData.get("contactId");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  if (
    typeof contactId !== "string" ||
    contactId.trim().length === 0 ||
    typeof expectedVersion !== "string" ||
    expectedVersion.trim().length === 0 ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length < 16
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "The contact recovery request is incomplete. Refresh the contact and try again.",
    });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(
      principal,
      `/api/admin/contacts/${encodeURIComponent(contactId.trim())}`,
      {
        method: "DELETE",
        headers: {
          "Idempotency-Key": idempotencyKey.trim(),
          "If-Match": expectedVersion.trim(),
        },
      },
    ),
    {
      success:
        "Contact moved to 30-day recovery. Automation is paused and queued operations are quarantined for review.",
      failure: "Unable to move contact to recovery",
    },
  );
  await setMutationFlash(feedback);
  revalidatePath("/team");
}

export async function restoreContactAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const contactId = formData.get("contactId");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  if (
    typeof contactId !== "string" ||
    contactId.trim().length === 0 ||
    typeof expectedVersion !== "string" ||
    expectedVersion.trim().length === 0 ||
    typeof idempotencyKey !== "string" ||
    idempotencyKey.trim().length < 16
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "The contact restore request is incomplete. Refresh the recovery list and try again.",
    });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(
      principal,
      `/api/admin/contacts/${encodeURIComponent(contactId.trim())}/restore`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey.trim(),
          "If-Match": expectedVersion.trim(),
        },
        body: JSON.stringify({}),
      },
    ),
    {
      success:
        "Contact restored. Automation and queued operations remain paused until an owner reviews them.",
      failure: "Unable to restore contact",
    },
  );
  await setMutationFlash(feedback);
  revalidatePath("/team");
}

export async function addPropertyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const contactId = formData.get("contactId");
  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Contact ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const addressLine1 = formData.get("addressLine1");
  const addressLine2 = formData.get("addressLine2");
  const city = formData.get("city");
  const state = formData.get("state");
  const postalCode = formData.get("postalCode");

  if (
    typeof addressLine1 !== "string" ||
    addressLine1.trim().length === 0 ||
    typeof city !== "string" ||
    city.trim().length === 0 ||
    typeof state !== "string" ||
    state.trim().length === 0 ||
    typeof postalCode !== "string" ||
    postalCode.trim().length === 0
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "Property details are required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/admin/contacts/${contactId}/properties`,
    {
      method: "POST",
      body: JSON.stringify({
        addressLine1: addressLine1.trim(),
        addressLine2:
          typeof addressLine2 === "string" && addressLine2.trim().length
            ? addressLine2.trim()
            : undefined,
        city: city.trim(),
        state: state.trim(),
        postalCode: postalCode.trim(),
      }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to add property");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Property added", path: "/" });
  revalidatePath("/team");
}

export async function updatePropertyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const contactId = formData.get("contactId");
  const propertyId = formData.get("propertyId");
  if (
    typeof contactId !== "string" ||
    contactId.trim().length === 0 ||
    typeof propertyId !== "string" ||
    propertyId.trim().length === 0
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "Property details missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {};
  const updates: Array<[string, FormDataEntryValue | null]> = [
    ["addressLine1", formData.get("addressLine1")],
    ["addressLine2", formData.get("addressLine2")],
    ["city", formData.get("city")],
    ["state", formData.get("state")],
    ["postalCode", formData.get("postalCode")],
  ];

  for (const [key, value] of updates) {
    if (typeof value === "string") {
      payload[key] = value.trim();
    }
  }

  if (Object.keys(payload).length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "No property changes to apply",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/admin/contacts/${contactId}/properties/${propertyId}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to update property",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Property updated", path: "/" });
  revalidatePath("/team");
}

export async function deletePropertyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const contactId = formData.get("contactId");
  const propertyId = formData.get("propertyId");
  if (
    typeof contactId !== "string" ||
    contactId.trim().length === 0 ||
    typeof propertyId !== "string" ||
    propertyId.trim().length === 0
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "Property details missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/admin/contacts/${contactId}/properties/${propertyId}`,
    { method: "DELETE" },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to delete property",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Property removed", path: "/" });
  revalidatePath("/team");
}

export async function updatePipelineStageAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const contactIds = formData.getAll("contactId");
  const stages = formData.getAll("stage");
  const previousStages = formData.getAll("previousStage");
  const expectedVersions = formData.getAll("expectedVersion");
  const idempotencyKeys = formData.getAll("idempotencyKey");
  const notesValues = formData.getAll("notes");
  const exactKeys = new Set([
    "contactId",
    "expectedVersion",
    "idempotencyKey",
    "notes",
    "previousStage",
    "stage",
  ]);
  let hasUnexpectedField = false;
  formData.forEach((_value, key) => {
    if (!exactKeys.has(key)) hasUnexpectedField = true;
  });

  const rawContactId = contactIds[0];
  const rawStage = stages[0];
  const rawPreviousStage = previousStages[0];
  const rawExpectedVersion = expectedVersions[0];
  const rawIdempotencyKey = idempotencyKeys[0];
  const rawNotes = notesValues[0];
  const contactId = typeof rawContactId === "string" ? rawContactId.trim() : "";
  const stage =
    typeof rawStage === "string" ? rawStage.trim().toLowerCase() : "";
  const previousStage =
    typeof rawPreviousStage === "string"
      ? rawPreviousStage.trim().toLowerCase()
      : "";
  const expectedVersion =
    typeof rawExpectedVersion === "string" ? rawExpectedVersion.trim() : "";
  const idempotencyKey =
    typeof rawIdempotencyKey === "string" ? rawIdempotencyKey.trim() : "";
  const notes = typeof rawNotes === "string" ? rawNotes.trim() : null;

  if (
    hasUnexpectedField ||
    contactIds.length !== 1 ||
    stages.length !== 1 ||
    previousStages.length !== 1 ||
    expectedVersions.length !== 1 ||
    idempotencyKeys.length !== 1 ||
    notesValues.length > 1 ||
    !isUuid(contactId) ||
    !isPipelineStage(stage) ||
    !isPipelineStage(previousStage) ||
    !isPipelineExpectedVersion(expectedVersion) ||
    !isValidTeamIdempotencyKey(idempotencyKey) ||
    (rawNotes !== undefined && typeof rawNotes !== "string") ||
    (notes?.length ?? 0) > 2_000
  ) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The pipeline update is incomplete or stale. Refresh the contact and try again; no change was confirmed.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  try {
    const success = await requestPipelineStageMutation(
      createAdminMutationRequest(
        principal,
        `/api/admin/crm/pipeline/${encodeURIComponent(contactId)}`,
        {
          method: "PATCH",
          headers: {
            "Idempotency-Key": idempotencyKey,
            "If-Match": `"${expectedVersion}"`,
          },
          body: JSON.stringify({
            stage,
            ...(notes ? { notes } : {}),
          }),
          timeoutMs: 8_000,
        },
      ),
      {
        actorId: principal.memberId,
        contactId,
        stage,
        previousStage,
        submittedVersion: expectedVersion,
      },
    );
    jar.set({
      name: "myst-flash",
      value: success.data.noOp
        ? "Pipeline was already at that stage. The request was safely recorded."
        : "Pipeline updated",
      path: "/",
    });
  } catch (error) {
    jar.set({
      name: "myst-flash-error",
      value:
        error instanceof PipelineStageRequestError
          ? error.message
          : "The pipeline stage could not be confirmed. Keep the selected value and refresh before retrying.",
      path: "/",
    });
  }
  revalidatePath("/team");
  revalidatePath("/team/inbox");
  revalidatePath("/team/contacts");
  revalidatePath("/team/sales/pipeline");
}

function makeNoteTitle(body: string): string {
  const normalized = body.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) return "Note";
  const maxLen = 60;
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLen - 3))}...`;
}

export async function createContactNoteAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const contactId = formData.get("contactId");
  const body = formData.get("body");

  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Contact ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (typeof body !== "string" || body.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Note body required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    contactId: contactId.trim(),
    title: makeNoteTitle(body),
    notes: body.trim(),
    status: "completed",
  };

  const response = await callAdminApiAs(principal, `/api/admin/crm/tasks`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to add note");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Note added", path: "/" });
  revalidatePath("/team");
}

export async function deleteContactNoteAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const noteId = formData.get("noteId");

  if (typeof noteId !== "string" || noteId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Note ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/admin/crm/tasks/${noteId.trim()}`,
    {
      method: "DELETE",
    },
  );
  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to delete note");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Note deleted", path: "/" });
  revalidatePath("/team");
}

export async function createTaskAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const contactId = formData.get("contactId");
  const title = formData.get("title");
  const dueAt = formData.get("dueAt");
  const assignedTo = formData.get("assignedTo");

  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Contact ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Task title required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    contactId: contactId.trim(),
    title: title.trim(),
  };

  if (typeof dueAt === "string" && dueAt.trim().length > 0) {
    payload["dueAt"] = dueAt.trim();
  }
  if (typeof assignedTo === "string" && assignedTo.trim().length > 0) {
    payload["assignedTo"] = assignedTo.trim();
  }

  const response = await callAdminApiAs(principal, `/api/admin/crm/tasks`, {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to create task");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Task added", path: "/" });
  revalidatePath("/team");
}

export async function updateTaskAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const taskId = formData.get("taskId");
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Task ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {};
  const fields: Array<[string, FormDataEntryValue | null]> = [
    ["title", formData.get("title")],
    ["dueAt", formData.get("dueAt")],
    ["assignedTo", formData.get("assignedTo")],
    ["status", formData.get("status")],
    ["notes", formData.get("notes")],
  ];

  for (const [key, value] of fields) {
    if (typeof value === "string") {
      payload[key] = value.trim();
    }
  }

  if (Object.keys(payload).length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "No task changes to apply",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/admin/crm/tasks/${taskId}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update task");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Task updated", path: "/" });
  revalidatePath("/team");
}

export async function deleteTaskAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const taskId = formData.get("taskId");
  if (typeof taskId !== "string" || taskId.trim().length === 0) {
    jar.set({ name: "myst-flash-error", value: "Task ID missing", path: "/" });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/admin/crm/tasks/${taskId}`,
    {
      method: "DELETE",
    },
  );
  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to delete task");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Task removed", path: "/" });
  revalidatePath("/team");
}

export async function updatePolicyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const key = formData.get("key");
  const value = formData.get("value");
  const expectedVersion = readPolicyExpectedVersion(formData);
  const idempotencyKey = formData.get("idempotencyKey");

  if (typeof key !== "string" || key.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Policy key missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Policy value missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (!expectedVersion) {
    jar.set({
      name: "myst-flash-error",
      value: "Policy version missing. Refresh this card before saving.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (!isValidTeamIdempotencyKey(idempotencyKey)) {
    jar.set({
      name: "myst-flash-error",
      value: "Policy retry key missing. Refresh this card before saving.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    jar.set({ name: "myst-flash-error", value: "Invalid JSON", path: "/" });
    revalidatePath("/team");
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    jar.set({
      name: "myst-flash-error",
      value: "Policy JSON must be an object",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(principal, "/api/admin/policy", {
    method: "POST",
    headers: {
      "If-Match": expectedVersion,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({
      key: key.trim(),
      value: parsed as Record<string, unknown>,
    }),
  });

  await finishPolicyMutation(
    response,
    jar,
    key.trim(),
    "Policy updated",
    "Unable to update policy",
  );
}

const WEEKDAYS = [
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
  "sunday",
] as const;
type Weekday = (typeof WEEKDAYS)[number];

function parseTimeField(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(trimmed);
  return match ? trimmed : null;
}

function timeToMinutes(value: string): number {
  const [hours, minutes] = value.split(":").map((part) => Number(part));
  return (Number(hours) || 0) * 60 + (Number(minutes) || 0);
}

function parseIntegerField(
  value: FormDataEntryValue | null,
  minValue = 0,
): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return null;
  const rounded = Math.round(parsed);
  if (rounded < minValue) return null;
  return rounded;
}

function parseNumberField(
  value: FormDataEntryValue | null,
  minValue = 0,
): number | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < minValue) return null;
  return parsed;
}

function parseListField(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function parseZipListField(value: FormDataEntryValue | null): string[] {
  if (typeof value !== "string") return [];
  const parts = value.split(/[\s,]+/);
  const cleaned = parts
    .map((entry) => entry.replace(/\D/g, "").slice(0, 5))
    .filter((entry) => entry.length === 5);
  return Array.from(new Set(cleaned));
}

function parseTemplateField(value: FormDataEntryValue | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isCanonicalPolicyVersion(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function readPolicyExpectedVersion(formData: FormData): string | null {
  const raw = formData.get("expectedVersion");
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  return value === "absent" || isCanonicalPolicyVersion(value) ? value : null;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isConfirmedPolicyMutation(
  value: unknown,
  expectedKey: string,
): boolean {
  if (!isRecordValue(value) || value["ok"] !== true) return false;
  const data = value["data"];
  const receipt = value["receipt"];
  if (!isRecordValue(data) || !isRecordValue(receipt)) return false;
  const version = data["version"];
  const updatedAt = data["updatedAt"];
  const committedAt = receipt["committedAt"];
  return (
    data["key"] === expectedKey &&
    isCanonicalPolicyVersion(version) &&
    updatedAt === version &&
    typeof receipt["operationId"] === "string" &&
    receipt["operationId"].length > 0 &&
    typeof receipt["correlationId"] === "string" &&
    receipt["correlationId"].length > 0 &&
    typeof receipt["actorId"] === "string" &&
    receipt["actorId"].length > 0 &&
    typeof receipt["auditEventId"] === "string" &&
    receipt["auditEventId"].length > 0 &&
    typeof committedAt === "string" &&
    Number.isFinite(Date.parse(committedAt))
  );
}

async function finishPolicyMutation(
  response: Response,
  jar: Awaited<ReturnType<typeof cookies>>,
  expectedKey: string,
  successMessage: string,
  failureMessage: string,
): Promise<void> {
  if (!response.ok) {
    const message = await readTeamMutationError(response, failureMessage);
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const result = (await response.json().catch(() => null)) as unknown;
  if (!isConfirmedPolicyMutation(result, expectedKey)) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The server did not return a confirmed policy receipt. Refresh before retrying.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: successMessage, path: "/" });
  revalidatePath("/team");
}

async function submitPolicyUpdate(
  principal: TeamRequestPrincipal,
  jar: Awaited<ReturnType<typeof cookies>>,
  formData: FormData,
  key: string,
  value: Record<string, unknown>,
  successMessage: string,
): Promise<void> {
  const expectedVersion = readPolicyExpectedVersion(formData);
  const idempotencyKey = formData.get("idempotencyKey");
  if (!expectedVersion) {
    jar.set({
      name: "myst-flash-error",
      value: "Policy version missing. Refresh this card before saving.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (!isValidTeamIdempotencyKey(idempotencyKey)) {
    jar.set({
      name: "myst-flash-error",
      value: "Policy retry key missing. Refresh this card before saving.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  const response = await callAdminApiAs(principal, "/api/admin/policy", {
    method: "POST",
    headers: {
      "If-Match": expectedVersion,
      "Idempotency-Key": idempotencyKey,
    },
    body: JSON.stringify({ key, value }),
  });
  await finishPolicyMutation(
    response,
    jar,
    key,
    successMessage,
    "Unable to update policy",
  );
}

export async function updateBusinessHoursPolicyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const timezoneRaw = formData.get("timezone");
  const timezone = typeof timezoneRaw === "string" ? timezoneRaw.trim() : "";
  const weekly: Record<Weekday, Array<{ start: string; end: string }>> = {
    monday: [],
    tuesday: [],
    wednesday: [],
    thursday: [],
    friday: [],
    saturday: [],
    sunday: [],
  };

  for (const day of WEEKDAYS) {
    const closed = formData.get(`${day}_closed`) === "on";
    if (closed) {
      weekly[day] = [];
      continue;
    }
    const start = parseTimeField(formData.get(`${day}_start`));
    const end = parseTimeField(formData.get(`${day}_end`));
    if (!start || !end) {
      jar.set({
        name: "myst-flash-error",
        value: `Missing hours for ${day}`,
        path: "/",
      });
      revalidatePath("/team");
      return;
    }
    if (timeToMinutes(end) <= timeToMinutes(start)) {
      jar.set({
        name: "myst-flash-error",
        value: `End time must be after start on ${day}`,
        path: "/",
      });
      revalidatePath("/team");
      return;
    }
    weekly[day] = [{ start, end }];
  }

  await submitPolicyUpdate(
    principal,
    jar,
    formData,
    "business_hours",
    {
      timezone: timezone.length > 0 ? timezone : "America/New_York",
      weekly,
    },
    "Business hours updated",
  );
}

export async function updateQuietHoursPolicyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const channels: Record<string, { start: string; end: string }> = {};
  const channelKeys = ["sms", "email", "dm"];

  for (const channel of channelKeys) {
    const always = formData.get(`${channel}_always`) === "on";
    if (always) {
      channels[channel] = { start: "00:00", end: "00:00" };
      continue;
    }
    const start = parseTimeField(formData.get(`${channel}_start`));
    const end = parseTimeField(formData.get(`${channel}_end`));
    if (!start || !end) {
      jar.set({
        name: "myst-flash-error",
        value: `Missing quiet hours for ${channel}`,
        path: "/",
      });
      revalidatePath("/team");
      return;
    }
    channels[channel] = { start, end };
  }

  await submitPolicyUpdate(
    principal,
    jar,
    formData,
    "quiet_hours",
    { channels },
    "Quiet hours updated",
  );
}

export async function updateServiceAreaPolicyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const modeRaw = formData.get("mode");
  const mode =
    modeRaw === "ga_only" || modeRaw === "ga_above_macon"
      ? String(modeRaw)
      : "zip_allowlist";
  const homeBaseRaw = formData.get("homeBase");
  const homeBase = typeof homeBaseRaw === "string" ? homeBaseRaw.trim() : "";
  const radiusMiles = parseNumberField(formData.get("radiusMiles"), 0);
  if (radiusMiles === null) {
    jar.set({
      name: "myst-flash-error",
      value: "Radius miles must be a number",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  const zipAllowlist =
    mode === "ga_only" || mode === "ga_above_macon"
      ? parseZipListField(formData.get("zipAllowlistPreserved"))
      : parseZipListField(formData.get("zipAllowlist"));
  const cityAllowlist = parseListField(formData.get("cityAllowlist"));
  const notesRaw = formData.get("notes");
  const notes = typeof notesRaw === "string" ? notesRaw.trim() : "";

  await submitPolicyUpdate(
    principal,
    jar,
    formData,
    "service_area",
    {
      mode,
      homeBase: homeBase.length > 0 ? homeBase : undefined,
      radiusMiles,
      zipAllowlist,
      cityAllowlist,
      notes: notes.length > 0 ? notes : undefined,
    },
    "Service area updated",
  );
}

export async function updateBookingRulesPolicyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const bookingWindowDays = parseIntegerField(
    formData.get("bookingWindowDays"),
    1,
  );
  const bufferMinutes = parseIntegerField(formData.get("bufferMinutes"), 0);
  const maxJobsPerDay = parseIntegerField(formData.get("maxJobsPerDay"), 0);
  const maxJobsPerCrew = parseIntegerField(formData.get("maxJobsPerCrew"), 0);

  if (
    bookingWindowDays === null ||
    bufferMinutes === null ||
    maxJobsPerDay === null ||
    maxJobsPerCrew === null
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "Booking rule values must be numbers",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  await submitPolicyUpdate(
    principal,
    jar,
    formData,
    "booking_rules",
    {
      bookingWindowDays,
      bufferMinutes,
      maxJobsPerDay,
      maxJobsPerCrew,
    },
    "Booking rules updated",
  );
}

export async function updateStandardJobPolicyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const allowedServices = parseListField(formData.get("allowedServices"));
  if (!allowedServices.length) {
    jar.set({
      name: "myst-flash-error",
      value: "Add at least one allowed service",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  const maxVolumeCubicYards = parseNumberField(
    formData.get("maxVolumeCubicYards"),
    0,
  );
  const maxItemCount = parseIntegerField(formData.get("maxItemCount"), 0);
  const notesRaw = formData.get("notes");
  const notes = typeof notesRaw === "string" ? notesRaw.trim() : "";

  if (maxVolumeCubicYards === null || maxItemCount === null) {
    jar.set({
      name: "myst-flash-error",
      value: "Standard job values must be numbers",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  await submitPolicyUpdate(
    principal,
    jar,
    formData,
    "standard_job",
    {
      allowedServices,
      maxVolumeCubicYards,
      maxItemCount,
      notes: notes.length > 0 ? notes : undefined,
    },
    "Standard job rules updated",
  );
}

export async function updateItemPoliciesAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const declined = parseListField(formData.get("declined"));
  const extraFees: Array<{ item: string; fee: number }> = [];

  for (let index = 1; index <= 5; index += 1) {
    const itemRaw = formData.get(`fee_item_${index}`);
    const feeRaw = formData.get(`fee_amount_${index}`);
    if (typeof itemRaw !== "string" || itemRaw.trim().length === 0) {
      continue;
    }
    const fee = parseNumberField(feeRaw, 0);
    if (fee === null) {
      jar.set({
        name: "myst-flash-error",
        value: "Extra fee amounts must be numbers",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }
    extraFees.push({ item: itemRaw.trim(), fee });
  }

  await submitPolicyUpdate(
    principal,
    jar,
    formData,
    "item_policies",
    {
      declined,
      extraFees,
    },
    "Item policies updated",
  );
}

export async function updateCompanyProfilePolicyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const readText = (key: string) => {
    const value = formData.get(key);
    return typeof value === "string" ? value.trim() : "";
  };

  const businessName = readText("businessName");
  const primaryPhone = readText("primaryPhone");
  const discountPercentRaw = readText("discountPercent");
  const serviceAreaSummary = readText("serviceAreaSummary");
  const trailerAndPricingSummary = readText("trailerAndPricingSummary");
  const whatWeDo = readText("whatWeDo");
  const whatWeDontDo = readText("whatWeDontDo");
  const bookingStyle = readText("bookingStyle");
  const agentNotes = readText("agentNotes");
  const outboundCallRecordingNotice = readText("outboundCallRecordingNotice");

  if (!businessName) {
    jar.set({
      name: "myst-flash-error",
      value: "Business name is required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  let discountPercent: number | undefined;
  if (discountPercentRaw.length > 0) {
    const parsed = Number(discountPercentRaw);
    if (Number.isFinite(parsed)) {
      const normalized = parsed > 1 ? parsed / 100 : parsed;
      const clamped = Math.min(0.9, Math.max(0, normalized));
      discountPercent = clamped;
    }
  }

  await submitPolicyUpdate(
    principal,
    jar,
    formData,
    "company_profile",
    {
      businessName,
      primaryPhone: primaryPhone.length > 0 ? primaryPhone : undefined,
      discountPercent,
      serviceAreaSummary:
        serviceAreaSummary.length > 0 ? serviceAreaSummary : undefined,
      trailerAndPricingSummary:
        trailerAndPricingSummary.length > 0
          ? trailerAndPricingSummary
          : undefined,
      whatWeDo: whatWeDo.length > 0 ? whatWeDo : undefined,
      whatWeDontDo: whatWeDontDo.length > 0 ? whatWeDontDo : undefined,
      bookingStyle: bookingStyle.length > 0 ? bookingStyle : undefined,
      agentNotes: agentNotes.length > 0 ? agentNotes : undefined,
      outboundCallRecordingNotice:
        outboundCallRecordingNotice.length > 0
          ? outboundCallRecordingNotice
          : "",
    },
    "Company profile updated",
  );
}

export async function updateSalesAutopilotSignatureAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const expectedVersion = readPolicyExpectedVersion(formData);
  const idempotencyKey = formData.get("idempotencyKey");
  const agentDisplayNameRaw = formData.get("agentDisplayName");
  const agentDisplayName =
    typeof agentDisplayNameRaw === "string" ? agentDisplayNameRaw.trim() : "";
  if (agentDisplayName.length === 0) {
    jar.set({ name: "myst-flash-error", value: "Name is required", path: "/" });
    revalidatePath("/team");
    return;
  }
  if (!expectedVersion) {
    jar.set({
      name: "myst-flash-error",
      value: "Sales agent signature version missing. Refresh before saving.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (!isValidTeamIdempotencyKey(idempotencyKey)) {
    jar.set({
      name: "myst-flash-error",
      value: "Sales agent signature retry key missing. Refresh before saving.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    "/api/admin/sales/autopilot/signature",
    {
      method: "PATCH",
      headers: {
        "If-Match": expectedVersion,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ agentDisplayName }),
    },
  );
  await finishPolicyMutation(
    response,
    jar,
    "sales_autopilot_signature",
    "Sales agent name updated",
    "Unable to update Sales Autopilot",
  );
}

export async function updateConversationPersonaPolicyAction(
  formData: FormData,
) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const raw = formData.get("systemPrompt");
  const systemPrompt = typeof raw === "string" ? raw.trim() : "";

  if (!systemPrompt) {
    jar.set({
      name: "myst-flash-error",
      value: "System prompt is required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (systemPrompt.length > 4000) {
    jar.set({
      name: "myst-flash-error",
      value: "System prompt must be 4000 characters or less",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  await submitPolicyUpdate(
    principal,
    jar,
    formData,
    "conversation_persona",
    { systemPrompt },
    "Conversation persona updated",
  );
}

export async function updateInboxAlertsPolicyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const sms = formData.get("sms") === "on";
  const dm = formData.get("dm") === "on";
  const email = formData.get("email") === "on";

  await submitPolicyUpdate(
    principal,
    jar,
    formData,
    "inbox_alerts",
    { sms, dm, email },
    "Inbox alerts updated",
  );
}

export async function updateTemplatesPolicyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const firstTouch: Record<string, string> = {};
  const followUp: Record<string, string> = {};
  const confirmations: Record<string, string> = {};
  const reviews: Record<string, string> = {};
  const outOfArea: Record<string, string> = {};

  const firstTouchFields = POLICY_TEMPLATE_CHANNELS.first_touch;
  const followUpFields = POLICY_TEMPLATE_CHANNELS.follow_up;
  const confirmationsFields = POLICY_TEMPLATE_CHANNELS.confirmations;
  const reviewsFields = POLICY_TEMPLATE_CHANNELS.reviews;
  const outOfAreaFields = POLICY_TEMPLATE_CHANNELS.out_of_area;

  for (const { key } of firstTouchFields) {
    const value = parseTemplateField(formData.get(`first_touch_${key}`));
    if (value) firstTouch[key] = value;
  }
  for (const { key } of followUpFields) {
    const value = parseTemplateField(formData.get(`follow_up_${key}`));
    if (value) followUp[key] = value;
  }
  for (const { key } of confirmationsFields) {
    const value = parseTemplateField(formData.get(`confirmations_${key}`));
    if (value) confirmations[key] = value;
  }
  for (const { key } of reviewsFields) {
    const value = parseTemplateField(formData.get(`reviews_${key}`));
    if (value) reviews[key] = value;
  }
  for (const { key } of outOfAreaFields) {
    const value = parseTemplateField(formData.get(`out_of_area_${key}`));
    if (value) outOfArea[key] = value;
  }

  await submitPolicyUpdate(
    principal,
    jar,
    formData,
    "templates",
    {
      first_touch: firstTouch,
      follow_up: followUp,
      confirmations,
      reviews,
      out_of_area: outOfArea,
    },
    "Templates updated",
  );
}

export async function updateReviewRequestPolicyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const enabled = formData.get("enabled") === "on";
  const rawUrl = formData.get("reviewUrl");
  const reviewUrl = typeof rawUrl === "string" ? rawUrl.trim() : "";

  if (!reviewUrl) {
    jar.set({
      name: "myst-flash-error",
      value: "Review link is required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  let normalizedReviewUrl: string;
  try {
    // Allow either g.page, https://, etc. If missing scheme, assume https.
    normalizedReviewUrl = /^https?:\/\//i.test(reviewUrl)
      ? reviewUrl
      : `https://${reviewUrl}`;
    const parsedUrl = new URL(normalizedReviewUrl);
    if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
      throw new Error("Unsupported review URL protocol");
    }
  } catch {
    jar.set({
      name: "myst-flash-error",
      value: "Review link must be a valid URL",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  await submitPolicyUpdate(
    principal,
    jar,
    formData,
    "review_request",
    { enabled, reviewUrl: normalizedReviewUrl },
    "Review request settings updated",
  );
}

export async function updateConfirmationLoopPolicyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const enabled = formData.get("enabled") === "on";
  const windows = [
    parseNumberField(formData.get("window_hours_1"), 0),
    parseNumberField(formData.get("window_hours_2"), 0),
    parseNumberField(formData.get("window_hours_3"), 0),
  ]
    .filter((value): value is number => value !== null && value > 0)
    .map((hours) => Math.round(hours * 60));

  const windowsMinutes = windows.length ? windows : [24 * 60, 2 * 60];

  await submitPolicyUpdate(
    principal,
    jar,
    formData,
    "confirmation_loop",
    {
      enabled,
      windowsMinutes,
    },
    "Confirmation loop updated",
  );
}

export async function updateFollowUpSequencePolicyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const enabled = formData.get("enabled") === "on";
  const steps = [
    parseNumberField(formData.get("step_hours_1"), 0),
    parseNumberField(formData.get("step_hours_2"), 0),
    parseNumberField(formData.get("step_hours_3"), 0),
    parseNumberField(formData.get("step_hours_4"), 0),
  ]
    .filter((value): value is number => value !== null && value > 0)
    .map((hours) => Math.round(hours * 60));

  const stepsMinutes = steps.length ? steps : [24 * 60, 72 * 60, 7 * 24 * 60];

  await submitPolicyUpdate(
    principal,
    jar,
    formData,
    "follow_up_sequence",
    {
      enabled,
      stepsMinutes,
    },
    "Follow-up sequence updated",
  );
}

const PUBLIC_AUTOMATION_MODES = new Set(["off", "assist", "automatic"]);
const AUTOMATION_CHANNELS = new Set(["sms", "email", "dm", "call", "web"]);

export type AutomationSettingsActionState = {
  ok: boolean | null;
  message: string;
};

function normalizePublicAutomationMode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  switch (value.trim().toLowerCase()) {
    case "off":
    case "draft":
      return "off";
    case "assist":
    case "partial":
      return "assist";
    case "automatic":
    case "auto":
    case "full":
      return "automatic";
    default:
      return null;
  }
}

function isCanonicalAutomationVersion(value: unknown): value is string {
  if (value === "absent") return true;
  if (typeof value !== "string") return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

function readBoundedAutomationInteger(
  formData: FormData,
  key: string,
  min: number,
  max: number,
): number | null {
  const raw = formData.get(key);
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isInteger(value) && value >= min && value <= max ? value : null;
}

export async function updateAutomationModeAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const channel = formData.get("channel");
  const mode = formData.get("mode");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");

  if (typeof channel !== "string" || !AUTOMATION_CHANNELS.has(channel.trim())) {
    jar.set({
      name: "myst-flash-error",
      value: "Choose a valid channel.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (!isCanonicalAutomationVersion(expectedVersion)) {
    jar.set({
      name: "myst-flash-error",
      value: "Channel version missing. Refresh before saving.",
      path: "/",
    });
    revalidatePath("/team/admin/automation");
    return;
  }
  if (!isValidTeamIdempotencyKey(idempotencyKey)) {
    jar.set({
      name: "myst-flash-error",
      value: "Safe retry key missing. Refresh before saving.",
      path: "/",
    });
    revalidatePath("/team/admin/automation");
    return;
  }
  const publicMode = normalizePublicAutomationMode(mode);
  if (!publicMode || !PUBLIC_AUTOMATION_MODES.has(publicMode)) {
    jar.set({
      name: "myst-flash-error",
      value: "Choose Off, Assist, or Automatic.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(principal, "/api/admin/automation", {
      method: "POST",
      headers: {
        "If-Match": expectedVersion,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify({ channel: channel.trim(), mode: publicMode }),
    }),
    {
      success: "Automation channel updated",
      failure: "Unable to update automation mode",
      requireReceipt: true,
    },
  );
  jar.set({
    name: feedback.ok ? "myst-flash" : "myst-flash-error",
    value: feedback.message,
    path: "/",
  });
  if (feedback.ok) revalidatePath("/team/admin/automation");
}

export async function updateSalesAutopilotPolicyAction(
  formData: FormData,
): Promise<AutomationSettingsActionState> {
  const principal = await requireCurrentTeamPrincipal();
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  if (!isCanonicalAutomationVersion(expectedVersion)) {
    return {
      ok: false,
      message:
        "The loaded settings version is missing. Refresh Messaging Automation before saving.",
    };
  }
  if (!isValidTeamIdempotencyKey(idempotencyKey)) {
    return {
      ok: false,
      message:
        "The safe retry key is missing. Refresh Messaging Automation before saving.",
    };
  }
  if (formData.get("automationReviewConfirmed") !== "on") {
    return {
      ok: false,
      message: "Review the sending impact and confirm it before saving.",
    };
  }

  const modeEntry = formData.get("mode");
  const mode = normalizePublicAutomationMode(modeEntry);
  if (!mode) {
    return { ok: false, message: "Choose Off, Assist, or Automatic." };
  }
  const plannerAutoSendEnabled =
    formData.get("plannerAutoSendEnabled") === "on";
  const liveReplyAutonomyEnabled =
    formData.get("liveReplyAutonomyEnabled") === "on";
  const facebookCloserModeEntry = formData.get("facebookCloserMode");
  const facebookCloserMode =
    typeof facebookCloserModeEntry === "string"
      ? facebookCloserModeEntry.trim()
      : "";
  const facebookCloserMaxAutoBookDollars = formData.get(
    "facebookCloserMaxAutoBookDollars",
  );
  const facebookCloserMinConfidenceEntry = formData.get(
    "facebookCloserMinConfidence",
  );
  const facebookCloserMinConfidence =
    typeof facebookCloserMinConfidenceEntry === "string"
      ? facebookCloserMinConfidenceEntry.trim()
      : "";
  const facebookCloserRequirePhotosAboveDollars = formData.get(
    "facebookCloserRequirePhotosAboveDollars",
  );
  const facebookCoachingToneEntry = formData.get("facebookCoachingTone");
  const facebookCoachingTone =
    typeof facebookCoachingToneEntry === "string"
      ? facebookCoachingToneEntry.trim()
      : "";
  const facebookCoachingPlaybook = formData.get("facebookCoachingPlaybook");
  const facebookCoachingHumanReviewKeywords = formData.get(
    "facebookCoachingHumanReviewKeywords",
  );
  const facebookCoachingBlockedAutoReplyKeywords = formData.get(
    "facebookCoachingBlockedAutoReplyKeywords",
  );
  const agentDisplayName = formData.get("agentDisplayName");
  const plannerAutoSendChannels = formData
    .getAll("plannerAutoSendChannels")
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .map((value) => value.trim());
  const plannerAutoSendActions = formData
    .getAll("plannerAutoSendActions")
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .map((value) => value.trim());
  const liveReplyAutonomyChannels = formData
    .getAll("liveReplyAutonomyChannels")
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .map((value) => value.trim());
  const liveReplyAutonomyActions = formData
    .getAll("liveReplyAutonomyActions")
    .filter(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    .map((value) => value.trim());
  const channelModeSms = formData.get("channelMode_sms");
  const channelModeEmail = formData.get("channelMode_email");
  const channelModeDm = formData.get("channelMode_dm");
  const channelModes = {
    sms: normalizePublicAutomationMode(channelModeSms),
    email: normalizePublicAutomationMode(channelModeEmail),
    dm: normalizePublicAutomationMode(channelModeDm),
  };

  if (!channelModes.sms || !channelModes.email || !channelModes.dm) {
    return {
      ok: false,
      message: "Choose Off, Assist, or Automatic for every channel.",
    };
  }

  const payload: Record<string, unknown> = {
    mode,
    emergencyStop: formData.get("emergencyStop") === "on",
    plannerAutoSendEnabled,
    liveReplyAutonomyEnabled,
    channelModes,
  };

  const boundedFields = [
    ["autoSendAfterMinutes", 15, 120],
    ["dailyAutomaticSendCap", 1, 1000],
    ["activityWindowMinutes", 1, 120],
    ["retryDelayMinutes", 1, 60],
    ["dmSmsFallbackAfterMinutes", 15, 24 * 60],
    ["dmMinSilenceBeforeSmsMinutes", 5, 12 * 60],
    ["dmMissingInfoFollowupDelayMinutes", 5, 24 * 60],
    ["dmQuoteFollowupDelayMinutes", 15, 3 * 24 * 60],
    ["dmObjectionFollowupDelayMinutes", 15, 5 * 24 * 60],
    ["plannerAutoSendMinDraftAgeMinutes", 1, 24 * 60],
  ] as const;
  for (const [key, min, max] of boundedFields) {
    const value = readBoundedAutomationInteger(formData, key, min, max);
    if (value === null) {
      return {
        ok: false,
        message: `Review ${key}; it must be a whole number from ${min} to ${max}.`,
      };
    }
    payload[key] = value;
  }

  if (
    typeof agentDisplayName !== "string" ||
    agentDisplayName.trim().length < 1 ||
    agentDisplayName.trim().length > 80
  ) {
    return {
      ok: false,
      message: "Agent name must be between 1 and 80 characters.",
    };
  }
  payload["agentDisplayName"] = agentDisplayName.trim();

  payload["plannerAutoSendChannels"] = plannerAutoSendChannels;
  payload["plannerAutoSendActions"] = plannerAutoSendActions;
  payload["liveReplyAutonomyChannels"] = liveReplyAutonomyChannels;
  payload["liveReplyAutonomyActions"] = liveReplyAutonomyActions;

  const facebookCloser: Record<string, unknown> = {
    allowedServices: ["junk_removal"],
    requireCustomerConfirmation: true,
    allowDmSmsFallback:
      formData.get("facebookCloserAllowDmSmsFallback") === "on",
    emergencyStop: formData.get("facebookCloserEmergencyStop") === "on",
  };
  if (!["off", "shadow", "assist", "auto"].includes(facebookCloserMode)) {
    return {
      ok: false,
      message: "Choose a supported Facebook closer mode.",
    };
  }
  facebookCloser["mode"] = facebookCloserMode;
  if (
    facebookCloserMinConfidence !== "medium" &&
    facebookCloserMinConfidence !== "high"
  ) {
    return { ok: false, message: "Choose Medium or High confidence." };
  }
  facebookCloser["minConfidence"] = facebookCloserMinConfidence;
  const maxAutoBookCents = parseUsdToCents(facebookCloserMaxAutoBookDollars);
  if (
    maxAutoBookCents === null ||
    maxAutoBookCents < 15_000 ||
    maxAutoBookCents > 500_000
  ) {
    return {
      ok: false,
      message: "Maximum auto-book total must be between $150 and $5,000.",
    };
  }
  facebookCloser["maxAutoBookTotalCents"] = maxAutoBookCents;
  const requirePhotosAboveCents = parseUsdToCents(
    facebookCloserRequirePhotosAboveDollars,
  );
  if (
    requirePhotosAboveCents === null ||
    requirePhotosAboveCents < 0 ||
    requirePhotosAboveCents > 500_000
  ) {
    return {
      ok: false,
      message: "Photo threshold must be between $0 and $5,000.",
    };
  }
  facebookCloser["requirePhotosAboveCents"] = requirePhotosAboveCents;
  const messengerWindowHours = readBoundedAutomationInteger(
    formData,
    "facebookCloserMessengerResponseWindowHours",
    1,
    24,
  );
  if (messengerWindowHours === null) {
    return {
      ok: false,
      message: "Messenger response window must be from 1 to 24 hours.",
    };
  }
  facebookCloser["messengerResponseWindowHours"] = messengerWindowHours;
  payload["facebookCloser"] = facebookCloser;

  const splitKeywordList = (value: FormDataEntryValue | null): string[] =>
    typeof value === "string"
      ? value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];
  const facebookCoaching: Record<string, unknown> = {
    enabled: formData.get("facebookCoachingEnabled") === "on",
    requirePhotosBeforeQuote:
      formData.get("facebookCoachingRequirePhotosBeforeQuote") === "on",
    requireHumanReviewBeforeBooking:
      formData.get("facebookCoachingRequireHumanReviewBeforeBooking") === "on",
    humanReviewKeywords: splitKeywordList(facebookCoachingHumanReviewKeywords),
    blockedAutoReplyKeywords: splitKeywordList(
      facebookCoachingBlockedAutoReplyKeywords,
    ),
  };
  if (["friendly", "professional", "concise"].includes(facebookCoachingTone)) {
    facebookCoaching["tone"] = facebookCoachingTone;
  }
  if (typeof facebookCoachingPlaybook === "string") {
    facebookCoaching["playbook"] = facebookCoachingPlaybook.trim();
  }
  payload["facebookCoaching"] = facebookCoaching;

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(principal, "/api/admin/sales/autopilot", {
      method: "PATCH",
      headers: {
        "If-Match": expectedVersion,
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(payload),
    }),
    {
      success: "Sales Autopilot settings saved",
      failure: "Unable to update Sales Autopilot",
      requireReceipt: true,
    },
  );
  if (!feedback.ok) {
    return feedback;
  }

  revalidatePath("/team/admin/automation");
  return feedback;
}

export async function updateLeadAutomationAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const leadId = formData.get("leadId");
  const channel = formData.get("channel");
  const paused = formData.get("paused");
  const dnc = formData.get("dnc");
  const humanTakeover = formData.get("humanTakeover");
  const followupState = formData.get("followupState");
  const followupStep = formData.get("followupStep");
  const nextFollowupAt = formData.get("nextFollowupAt");

  if (typeof leadId !== "string" || !isUuid(leadId.trim())) {
    jar.set({
      name: "myst-flash-error",
      value: "Choose a valid lead from the search results.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (typeof channel !== "string" || !AUTOMATION_CHANNELS.has(channel.trim())) {
    jar.set({
      name: "myst-flash-error",
      value: "Choose a valid channel.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const normalizedFollowupState =
    typeof followupState === "string" ? followupState.trim().toLowerCase() : "";
  if (
    normalizedFollowupState &&
    !/^[a-z][a-z0-9_-]{0,63}$/u.test(normalizedFollowupState)
  ) {
    jar.set({
      name: "myst-flash-error",
      value:
        "Use a short lowercase follow-up state such as qualifying or booked.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const normalizedStep =
    typeof followupStep === "string" && followupStep.trim() !== ""
      ? Number(followupStep)
      : 0;
  if (
    !Number.isInteger(normalizedStep) ||
    normalizedStep < 0 ||
    normalizedStep > 100
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "Follow-up step must be a whole number from 0 to 100.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  let nextFollowupIso: string | null = null;
  if (typeof nextFollowupAt === "string" && nextFollowupAt.trim().length > 0) {
    const parsed = new Date(nextFollowupAt);
    if (Number.isNaN(parsed.getTime())) {
      jar.set({
        name: "myst-flash-error",
        value: "Invalid follow-up date",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }
    nextFollowupIso = parsed.toISOString();
  }

  const payload: Record<string, unknown> = {
    leadId: leadId.trim(),
    channel: channel.trim(),
    paused: paused === "on",
    dnc: dnc === "on",
    humanTakeover: humanTakeover === "on",
    followupState: normalizedFollowupState || null,
    followupStep: normalizedStep,
    nextFollowupAt: nextFollowupIso,
  };

  const response = await callAdminApiAs(
    principal,
    "/api/admin/automation/lead",
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to update lead automation",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Lead automation updated", path: "/" });
  revalidatePath("/team");
}

export async function scanMergeSuggestionsAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const idempotencyKey = formData.get("idempotencyKey");
  if (!isValidTeamIdempotencyKey(idempotencyKey)) {
    jar.set({
      name: "myst-flash-error",
      value: "The merge scan request expired. Refresh and try again.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    "/api/admin/merge-suggestions/scan",
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({}),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to scan for merges",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const scanReceipt = parseMergeScanSuccess(
    (await response.json().catch(() => null)) as unknown,
    principal.memberId,
  );
  if (!scanReceipt) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The service returned an unverified merge-scan receipt. Refresh before retrying; no success is being claimed.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  jar.set({
    name: "myst-flash",
    value: `Merge scan complete: ${scanReceipt.created} new match${scanReceipt.created === 1 ? "" : "es"}`,
    path: "/",
  });
  revalidatePath("/team");
}

export async function approveMergeSuggestionAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const suggestionId = formData.get("suggestionId");
  const expectedUpdatedAt = formData.get("expectedUpdatedAt");
  const expectedSourceUpdatedAt = formData.get("expectedSourceUpdatedAt");
  const expectedTargetUpdatedAt = formData.get("expectedTargetUpdatedAt");
  const expectedPreviewHash = formData.get("expectedPreviewHash");
  const idempotencyKey = formData.get("idempotencyKey");
  const confirmation = formData.get("confirmation");
  if (
    typeof suggestionId !== "string" ||
    suggestionId.trim().length === 0 ||
    typeof expectedUpdatedAt !== "string" ||
    expectedUpdatedAt.trim().length === 0 ||
    typeof expectedSourceUpdatedAt !== "string" ||
    expectedSourceUpdatedAt.trim().length === 0 ||
    typeof expectedTargetUpdatedAt !== "string" ||
    expectedTargetUpdatedAt.trim().length === 0 ||
    !isMergePreviewHash(expectedPreviewHash) ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The merge preview changed or expired. Refresh and review it again.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/admin/merge-suggestions/${suggestionId}`,
    {
      method: "PATCH",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "If-Match": expectedPreviewHash,
      },
      body: JSON.stringify({
        action: "approve",
        expectedUpdatedAt,
        expectedSourceUpdatedAt,
        expectedTargetUpdatedAt,
        expectedPreviewHash,
        confirmation,
      }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to approve merge");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const sourceContactId = formData.get("sourceContactId");
  const targetContactId = formData.get("targetContactId");
  if (
    typeof sourceContactId !== "string" ||
    typeof targetContactId !== "string"
  ) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The merge preview omitted its contact binding. Refresh before retrying.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  const mergeReceipt = parseContactMergeSuccess(
    (await response.json().catch(() => null)) as unknown,
    {
      actorId: principal.memberId,
      sourceContactId,
      targetContactId,
      previewHash: expectedPreviewHash,
      suggestionId,
    },
  );
  if (!mergeReceipt) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The service returned an unverified merge receipt. Refresh before retrying; no success is being claimed.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Contacts merged", path: "/" });
  revalidatePath("/team");
  redirect(
    teamSurfaceHref("merge", {
      query: { mergeRecoveryId: mergeReceipt.recoveryLedgerId },
    }),
  );
}

export async function declineMergeSuggestionAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const suggestionId = formData.get("suggestionId");
  const expectedUpdatedAt = formData.get("expectedUpdatedAt");
  const idempotencyKey = formData.get("idempotencyKey");
  if (
    typeof suggestionId !== "string" ||
    suggestionId.trim().length === 0 ||
    typeof expectedUpdatedAt !== "string" ||
    expectedUpdatedAt.trim().length === 0 ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "The merge decision changed or expired. Refresh and try again.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/admin/merge-suggestions/${suggestionId}`,
    {
      method: "PATCH",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "If-Match": expectedUpdatedAt,
      },
      body: JSON.stringify({ action: "decline", expectedUpdatedAt }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to decline merge");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const declineReceipt = parseMergeDeclineSuccess(
    (await response.json().catch(() => null)) as unknown,
    { actorId: principal.memberId, suggestionId: suggestionId.trim() },
  );
  if (!declineReceipt) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The service returned an unverified merge-decision receipt. Refresh before retrying; no success is being claimed.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Suggestion declined", path: "/" });
  revalidatePath("/team");
}

export async function manualMergeContactsAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const targetContactId = formData.get("targetContactId");
  const sourceContactId = formData.get("sourceContactId");
  const expectedSourceUpdatedAt = formData.get("expectedSourceUpdatedAt");
  const expectedTargetUpdatedAt = formData.get("expectedTargetUpdatedAt");
  const expectedPreviewHash = formData.get("expectedPreviewHash");
  const idempotencyKey = formData.get("idempotencyKey");
  const reason = formData.get("reason");
  const confirmation = formData.get("confirmation");

  if (
    typeof targetContactId !== "string" ||
    targetContactId.trim().length === 0 ||
    typeof sourceContactId !== "string" ||
    sourceContactId.trim().length === 0 ||
    typeof expectedSourceUpdatedAt !== "string" ||
    expectedSourceUpdatedAt.trim().length === 0 ||
    typeof expectedTargetUpdatedAt !== "string" ||
    expectedTargetUpdatedAt.trim().length === 0 ||
    !isMergePreviewHash(expectedPreviewHash) ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The contact preview changed or expired. Search and review it again.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(principal, "/api/admin/merge", {
    method: "POST",
    headers: {
      "Idempotency-Key": idempotencyKey,
      "If-Match": expectedPreviewHash,
    },
    body: JSON.stringify({
      targetContactId: targetContactId.trim(),
      sourceContactId: sourceContactId.trim(),
      expectedSourceUpdatedAt,
      expectedTargetUpdatedAt,
      expectedPreviewHash,
      reason: typeof reason === "string" ? reason.trim() : undefined,
      confirmation,
    }),
  });

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to merge contacts",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const mergeReceipt = parseContactMergeSuccess(
    (await response.json().catch(() => null)) as unknown,
    {
      actorId: principal.memberId,
      sourceContactId: sourceContactId.trim(),
      targetContactId: targetContactId.trim(),
      previewHash: expectedPreviewHash,
    },
  );
  if (!mergeReceipt) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The service returned an unverified merge receipt. Refresh before retrying; no success is being claimed.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Contacts merged", path: "/" });
  revalidatePath("/team");
  redirect(
    teamSurfaceHref("merge", {
      query: { mergeRecoveryId: mergeReceipt.recoveryLedgerId },
    }),
  );
}

export async function previewManualMergeAction(formData: FormData) {
  await requireCurrentTeamPrincipal();
  const targetContactId = formData.get("targetContactId");
  const sourceContactId = formData.get("sourceContactId");
  if (
    typeof targetContactId !== "string" ||
    targetContactId.trim().length === 0 ||
    typeof sourceContactId !== "string" ||
    sourceContactId.trim().length === 0
  ) {
    const jar = await cookies();
    jar.set({
      name: "myst-flash-error",
      value: "Both contact IDs are required before previewing a merge",
      path: "/",
    });
    revalidatePath("/team/admin/merge");
    return;
  }

  const params = new URLSearchParams({
    mergeSourceId: sourceContactId.trim(),
    mergeTargetId: targetContactId.trim(),
  });
  redirect(teamSurfaceHref("merge", { query: params }));
}

export async function createRoleAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const name = formData.get("name");
  const slug = formData.get("slug");
  const permissions = formData.get("permissions");
  const idempotencyKey = readFormString(formData, "idempotencyKey");

  if (typeof name !== "string" || name.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Role name required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (typeof slug !== "string" || slug.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Role slug required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (idempotencyKey.length < 16 || idempotencyKey.length > 200) {
    jar.set({
      name: "myst-flash-error",
      value: "This role form is stale. Refresh before saving.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const perms =
    typeof permissions === "string" && permissions.trim().length > 0
      ? permissions
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [];

  const response = await callAdminMutationWithSafeReplay(
    principal,
    "/api/admin/roles",
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        name: name.trim(),
        slug: slug.trim(),
        permissions: perms,
      }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to create role");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }
  if (!(await readTeamMutationSuccess(response))) {
    jar.set({
      name: "myst-flash-error",
      value: "The role receipt was unreadable, so no success is being claimed.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Role created", path: "/" });
  revalidatePath("/team");
}

export async function createTeamMemberAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const name = formData.get("name");
  const email = formData.get("email");
  const roleId = formData.get("roleId");
  const active = formData.get("active");
  const idempotencyKey = readFormString(formData, "idempotencyKey");

  if (typeof name !== "string" || name.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Member name required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (idempotencyKey.length < 16 || idempotencyKey.length > 200) {
    jar.set({
      name: "myst-flash-error",
      value: "This member form is stale. Refresh before saving.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    name: name.trim(),
    active: active === "on",
  };

  if (typeof email === "string" && email.trim().length > 0) {
    payload["email"] = email.trim();
  }
  if (typeof roleId === "string" && roleId.trim().length > 0) {
    payload["roleId"] = roleId.trim();
  }

  const response = await callAdminMutationWithSafeReplay(
    principal,
    "/api/admin/team/members",
    {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to create member");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }
  if (!(await readTeamMutationSuccess(response))) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The member receipt was unreadable, so no success is being claimed.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Team member added", path: "/" });
  revalidatePath("/team");
}

export async function updateTeamMemberAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const memberId = formData.get("memberId");
  const expectedUpdatedAt = readFormString(formData, "expectedUpdatedAt");
  const idempotencyKey = readFormString(formData, "idempotencyKey");
  if (typeof memberId !== "string" || memberId.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Member ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  if (!expectedUpdatedAt || idempotencyKey.length < 16) {
    jar.set({
      name: "myst-flash-error",
      value: "This member form is stale. Refresh before saving.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    expectedUpdatedAt,
    active: formData.get("active") === "on",
  };

  const name = formData.get("name");
  if (typeof name === "string") {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      jar.set({
        name: "myst-flash-error",
        value: "Name is required",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }
    payload["name"] = trimmed;
  }

  const email = formData.get("email");
  if (typeof email === "string") {
    payload["email"] = email.trim();
  }

  const roleId = formData.get("roleId");
  if (typeof roleId === "string") {
    payload["roleId"] = roleId.trim();
  }

  const phone = formData.get("phone");
  if (typeof phone === "string") {
    payload["phone"] = phone.trim().length > 0 ? phone.trim() : null;
  }

  const defaultCrewSplitPercent = formData.get("defaultCrewSplitPercent");
  if (typeof defaultCrewSplitPercent === "string") {
    const trimmed = defaultCrewSplitPercent.trim();
    if (trimmed.length === 0) {
      payload["defaultCrewSplitBps"] = null;
    } else {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        jar.set({
          name: "myst-flash-error",
          value: "Crew split % must be between 0 and 100",
          path: "/",
        });
        revalidatePath("/team");
        return;
      }
      payload["defaultCrewSplitBps"] = Math.round(parsed * 100);
    }
  }

  const fixedCrewJobRatePercent = formData.get("fixedCrewJobRatePercent");
  if (typeof fixedCrewJobRatePercent === "string") {
    const trimmed = fixedCrewJobRatePercent.trim();
    if (trimmed.length === 0) {
      payload["fixedCrewJobRateBps"] = null;
    } else {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        jar.set({
          name: "myst-flash-error",
          value: "Guaranteed job % must be between 0 and 100",
          path: "/",
        });
        revalidatePath("/team");
        return;
      }
      payload["fixedCrewJobRateBps"] = Math.round(parsed * 100);
    }
  }

  const response = await callAdminMutationWithSafeReplay(
    principal,
    `/api/admin/team/members/${memberId}`,
    {
      method: "PATCH",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "If-Match": expectedUpdatedAt,
      },
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update member");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }
  if (!(await readTeamMutationSuccess(response))) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The member receipt was unreadable, so no success is being claimed.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Member updated", path: "/" });
  revalidatePath("/team");
}

export async function deleteTeamMemberAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const memberId = formData.get("memberId");
  const confirm = formData.get("confirm");

  if (typeof memberId !== "string" || memberId.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Member ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (
    typeof confirm !== "string" ||
    confirm.trim().toUpperCase() !== "DELETE"
  ) {
    jar.set({
      name: "myst-flash-error",
      value: 'Type "DELETE" to confirm',
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/admin/team/members/${memberId.trim()}`,
    {
      method: "DELETE",
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to delete member");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Team member deleted", path: "/" });
  revalidatePath("/team");
}

export async function createThreadAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const contactId = formData.get("contactId");
  const channel = formData.get("channel");
  const subject = formData.get("subject");

  if (typeof contactId !== "string" || contactId.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Contact ID required",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    contactId: contactId.trim(),
    channel:
      typeof channel === "string" && channel.trim().length > 0
        ? channel.trim()
        : "sms",
  };

  if (typeof subject === "string" && subject.trim().length > 0) {
    payload["subject"] = subject.trim();
  }

  const response = await callAdminApiAs(principal, "/api/admin/inbox/threads", {
    method: "POST",
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to create thread");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Thread created", path: "/" });
  revalidatePath("/team");
}

export async function updateThreadAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const threadId = formData.get("threadId");
  const status = formData.get("status");
  const state = formData.get("state");
  const allowBackward = formData.get("allowBackward");

  if (typeof threadId !== "string" || threadId.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Thread ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {};
  if (typeof status === "string" && status.trim().length > 0) {
    payload["status"] = status.trim();
  }
  if (typeof state === "string" && state.trim().length > 0) {
    payload["state"] = state.trim();
  }
  if (allowBackward === "on") {
    payload["allowBackward"] = true;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/admin/inbox/threads/${threadId}`,
    {
      method: "PATCH",
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to update thread");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Thread updated", path: "/" });
  revalidatePath("/team");
}

export async function sendThreadMessageAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const threadId = formData.get("threadId");
  const contactId = formData.get("contactId");
  const channel = formData.get("channel");
  const body = formData.get("body");
  const subject = formData.get("subject");

  const resolvedChannel = typeof channel === "string" ? channel.trim() : "";
  const attachments = formData
    .getAll("attachments")
    .filter((value): value is File => value instanceof File && value.size > 0);

  let resolvedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  if (resolvedThreadId.length === 0) {
    const ensuredContactId =
      typeof contactId === "string" ? contactId.trim() : "";
    const ensuredChannel = resolvedChannel;

    if (!ensuredContactId || !ensuredChannel) {
      jar.set({
        name: "myst-flash-error",
        value: "Thread ID missing",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }

    if (ensuredChannel === "dm") {
      jar.set({
        name: "myst-flash-error",
        value: "Messenger thread not found yet.",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }

    const ensureRes = await callAdminApiAs(
      principal,
      "/api/admin/inbox/threads/ensure",
      {
        method: "POST",
        body: JSON.stringify({
          contactId: ensuredContactId,
          channel: ensuredChannel,
        }),
      },
    );

    if (!ensureRes.ok) {
      const message = await readErrorMessage(
        ensureRes,
        "Unable to open a thread for this contact",
      );
      jar.set({ name: "myst-flash-error", value: message, path: "/" });
      revalidatePath("/team");
      return;
    }

    const ensurePayload = (await ensureRes.json().catch(() => null)) as {
      threadId?: string;
    } | null;
    resolvedThreadId =
      typeof ensurePayload?.threadId === "string"
        ? ensurePayload.threadId.trim()
        : "";
    if (!resolvedThreadId) {
      jar.set({
        name: "myst-flash-error",
        value: "Unable to open a thread for this contact",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }
  }
  const trimmedBody = typeof body === "string" ? body.trim() : "";
  if (trimmedBody.length === 0 && attachments.length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Add a message or attach photos first",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const payload: Record<string, unknown> = {
    body: trimmedBody,
    direction: "outbound",
    ...(resolvedChannel ? { channel: resolvedChannel } : {}),
  };
  if (typeof subject === "string" && subject.trim().length > 0) {
    payload["subject"] = subject.trim();
  }

  if (attachments.length > 0) {
    if (resolvedChannel !== "sms" && resolvedChannel !== "dm") {
      jar.set({
        name: "myst-flash-error",
        value:
          "Attachments are only supported for SMS and Messenger right now.",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }

    const uploadForm = new FormData();
    for (const file of attachments) {
      uploadForm.append("file", file, file.name);
    }

    const uploadRes = await callAdminApiAs(
      principal,
      "/api/admin/inbox/uploads",
      {
        method: "POST",
        body: uploadForm,
      },
    );

    if (!uploadRes.ok) {
      const message = await readErrorMessage(
        uploadRes,
        "Unable to upload attachments",
      );
      jar.set({ name: "myst-flash-error", value: message, path: "/" });
      revalidatePath("/team");
      return;
    }

    const uploadPayload = (await uploadRes.json().catch(() => null)) as {
      uploads?: { url?: unknown }[];
    } | null;
    const mediaUrls =
      uploadPayload?.uploads
        ?.map((item) =>
          item && typeof item.url === "string" ? item.url.trim() : "",
        )
        .filter((url) => url.length > 0) ?? [];

    if (mediaUrls.length === 0) {
      jar.set({
        name: "myst-flash-error",
        value: "Unable to upload attachments",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }

    payload["mediaUrls"] = mediaUrls;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/admin/inbox/threads/${resolvedThreadId}/messages`,
    {
      method: "POST",
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(response, "Unable to send message");
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({
    name: "myst-flash",
    value: attachments.length ? "Message + photos queued" : "Message queued",
    path: "/",
  });
  revalidatePath("/team");
  const resolvedContactId =
    typeof contactId === "string" ? contactId.trim() : "";
  redirect(
    teamSurfaceHref("inbox", {
      query: {
        threadId: resolvedThreadId,
        channel: resolvedChannel || undefined,
        contactId: resolvedContactId || undefined,
        r: Date.now(),
      },
    }),
  );
}

export async function retryFailedMessageAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const messageId = formData.get("messageId");
  const idempotencyKey = formData.get("idempotencyKey");
  if (
    typeof messageId !== "string" ||
    messageId.trim().length === 0 ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The message retry request expired. Refresh the Inbox and try again.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminMutationWithSafeReplay(
      principal,
      `/api/admin/inbox/messages/${encodeURIComponent(messageId.trim())}/retry`,
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey.trim() },
        body: JSON.stringify({}),
      },
    ),
    {
      success: "Message retry queued.",
      failure: "Unable to retry message",
      requireReceipt: true,
    },
  );
  await setMutationFlash(feedback);
  revalidatePath(teamSurfaceHref("inbox"));
}

export async function deleteMessageAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const messageId = formData.get("messageId");
  if (typeof messageId !== "string" || messageId.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Message ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    `/api/admin/inbox/messages/${messageId}`,
    {
      method: "DELETE",
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to delete message",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Message deleted", path: "/" });
  revalidatePath("/team");
}

export async function suggestThreadReplyAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const threadId = formData.get("threadId");
  const contactId = formData.get("contactId");
  const channel = formData.get("channel");

  let resolvedThreadId = typeof threadId === "string" ? threadId.trim() : "";
  const resolvedChannel = typeof channel === "string" ? channel.trim() : "";
  const resolvedContactId =
    typeof contactId === "string" ? contactId.trim() : "";
  if (resolvedThreadId.length === 0) {
    const ensuredContactId = resolvedContactId;
    const ensuredChannel = resolvedChannel;

    if (!ensuredContactId || !ensuredChannel) {
      jar.set({
        name: "myst-flash-error",
        value: "Thread ID missing",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }

    if (ensuredChannel === "dm") {
      jar.set({
        name: "myst-flash-error",
        value: "Messenger thread not found yet.",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }

    const ensureRes = await callAdminApiAs(
      principal,
      "/api/admin/inbox/threads/ensure",
      {
        method: "POST",
        body: JSON.stringify({
          contactId: ensuredContactId,
          channel: ensuredChannel,
        }),
      },
    );

    if (!ensureRes.ok) {
      const message = await readErrorMessage(
        ensureRes,
        "Unable to open a thread for this contact",
      );
      jar.set({ name: "myst-flash-error", value: message, path: "/" });
      revalidatePath("/team");
      return;
    }

    const ensurePayload = (await ensureRes.json().catch(() => null)) as {
      threadId?: string;
    } | null;
    resolvedThreadId =
      typeof ensurePayload?.threadId === "string"
        ? ensurePayload.threadId.trim()
        : "";
    if (!resolvedThreadId) {
      jar.set({
        name: "myst-flash-error",
        value: "Unable to open a thread for this contact",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }
  }

  const response = await callAdminApiAs(
    principal,
    `/api/admin/inbox/threads/${resolvedThreadId}/suggest`,
    {
      method: "POST",
      body: JSON.stringify({}),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to generate suggestion",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const suggestPayload = (await response.json().catch(() => null)) as {
    threadId?: string;
    channel?: string;
  } | null;
  const redirectedThreadId =
    typeof suggestPayload?.threadId === "string" &&
    suggestPayload.threadId.trim().length > 0
      ? suggestPayload.threadId.trim()
      : resolvedThreadId;
  const redirectedChannel =
    typeof suggestPayload?.channel === "string" &&
    suggestPayload.channel.trim().length > 0
      ? suggestPayload.channel.trim()
      : resolvedChannel;

  jar.set({
    name: "myst-flash",
    value: "AI draft created. Review and click Send when ready.",
    path: "/",
  });
  revalidatePath("/team");
  redirect(
    teamSurfaceHref("inbox", {
      query: {
        threadId: redirectedThreadId,
        channel: redirectedChannel || undefined,
        contactId: resolvedContactId || undefined,
        r: Date.now(),
      },
    }),
  );
}

export async function acknowledgeNewLeadAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const contactIds = formData.getAll("contactId");
  const leadVersions = formData.getAll("leadVersion");
  const idempotencyKeys = formData.getAll("idempotencyKey");
  const exactKeys = new Set(["contactId", "idempotencyKey", "leadVersion"]);
  let hasUnexpectedField = false;
  formData.forEach((_value, key) => {
    if (!exactKeys.has(key)) hasUnexpectedField = true;
  });
  const contactId = contactIds[0];
  const leadVersion = leadVersions[0];
  const idempotencyKey = idempotencyKeys[0];

  if (
    hasUnexpectedField ||
    contactIds.length !== 1 ||
    leadVersions.length !== 1 ||
    idempotencyKeys.length !== 1 ||
    typeof contactId !== "string" ||
    !isUuid(contactId) ||
    typeof leadVersion !== "string" ||
    !/^[0-9a-f]{64}$/u.test(leadVersion) ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The new-lead acknowledgement is incomplete. Refresh the Inbox; no lead was hidden.",
      path: "/",
    });
    revalidatePath("/team");
    revalidatePath("/team/inbox");
    return;
  }

  let response: Response;
  try {
    response = await callAdminMutationWithSafeReplay(
      principal,
      `/api/admin/inbox/new-leads/${encodeURIComponent(contactId)}/acknowledge`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": `"${leadVersion}"`,
        },
        timeoutMs: 8_000,
      },
    );
  } catch (error) {
    jar.set({
      name: "myst-flash-error",
      value: `${readTeamMutationException(
        error,
        "Unable to acknowledge this new lead",
      )} The exact request was retried once, but no acknowledgement is being claimed. Refresh the Inbox and verify the lead is still shown before trying again.`,
      path: "/",
    });
    revalidatePath("/team");
    revalidatePath("/team/inbox");
    return;
  }

  if (!response.ok) {
    const failureMessage = await readTeamMutationError(
      response,
      "Unable to acknowledge this new lead",
    );
    const retryGuidance = [408, 429, 500, 502, 503, 504].includes(
      response.status,
    )
      ? " No acknowledgement is being claimed. Refresh the Inbox and verify the lead is still shown before retrying."
      : "";
    jar.set({
      name: "myst-flash-error",
      value: `${failureMessage}${retryGuidance}`,
      path: "/",
    });
    revalidatePath("/team");
    revalidatePath("/team/inbox");
    return;
  }

  const success = parseInboxNewLeadAcknowledgementSuccess(
    await response.json().catch(() => null),
    {
      contactId,
      leadVersion,
      actorId: principal.memberId,
    },
  );
  if (!success) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The service returned an unverified acknowledgement receipt. No acknowledgement is being claimed; refresh the Inbox and verify the lead is still shown before trying again.",
      path: "/",
    });
    revalidatePath("/team");
    revalidatePath("/team/inbox");
    return;
  }

  jar.set({
    name: "myst-flash",
    value:
      "Lead acknowledged for you for 24 hours. The next unacknowledged lead is shown below.",
    path: "/",
  });
  jar.set({
    name: "myst-new-lead-hidden-until",
    value: "",
    path: "/",
    maxAge: 0,
  });
  jar.set({
    name: "myst-new-lead-dismissed",
    value: "",
    path: "/",
    maxAge: 0,
  });
  revalidatePath("/team");
  revalidatePath("/team/inbox");
}

export async function updateDefaultSalesAssigneeAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const memberIdRaw = formData.get("defaultAssigneeMemberId");

  if (memberIdRaw !== null && typeof memberIdRaw !== "string") {
    jar.set({
      name: "myst-flash-error",
      value: "Invalid selection",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const memberId = typeof memberIdRaw === "string" ? memberIdRaw.trim() : "";

  const response = await callAdminApiAs(
    principal,
    "/api/admin/sales/settings",
    {
      method: "PATCH",
      body: JSON.stringify({
        defaultAssigneeMemberId: memberId.length ? memberId : null,
      }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to update default salesperson",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({
    name: "myst-flash",
    value: "Default salesperson updated",
    path: "/",
  });
  revalidatePath("/team");
  redirect(teamSurfaceHref("access"));
}

export async function resetSalesHqAction() {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();

  const response = await callAdminApiAs(principal, "/api/admin/sales/reset", {
    method: "POST",
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to reset Sales HQ",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({
    name: "myst-flash",
    value: "Sales HQ cleared. Only new leads will appear going forward.",
    path: "/",
  });
  revalidatePath("/team");
}

export async function deleteCallCoachingAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const callRecordIdRaw = formData.get("callRecordId");

  if (
    typeof callRecordIdRaw !== "string" ||
    callRecordIdRaw.trim().length === 0
  ) {
    jar.set({ name: "myst-flash-error", value: "Missing call id", path: "/" });
    revalidatePath("/team");
    return;
  }

  const callRecordId = callRecordIdRaw.trim();
  const response = await callAdminApiAs(
    principal,
    `/api/admin/calls/coaching/${encodeURIComponent(callRecordId)}`,
    {
      method: "DELETE",
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to delete call coaching",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Call coaching deleted.", path: "/" });
  revalidatePath(teamSurfaceHref("sales-hq"));
}

export async function markSalesTouchAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const contactIdRaw = formData.get("contactId");

  if (typeof contactIdRaw !== "string" || contactIdRaw.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Missing contact id",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(principal, "/api/admin/sales/touch", {
    method: "POST",
    body: JSON.stringify({ contactId: contactIdRaw.trim() }),
  });

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to mark contacted",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  jar.set({ name: "myst-flash", value: "Marked contacted.", path: "/" });
  revalidatePath("/team");
}

export async function setSalesDispositionAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const contactIdRaw = formData.get("contactId");
  const dispositionRaw = formData.get("disposition");
  const idempotencyKey = formData.get("idempotencyKey");

  if (typeof contactIdRaw !== "string" || contactIdRaw.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Missing contact id",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (
    typeof dispositionRaw !== "string" ||
    dispositionRaw.trim().length === 0 ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The disposition request expired. Refresh the Inbox and try again.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminMutationWithSafeReplay(principal, "/api/admin/sales/disposition", {
      method: "POST",
      headers: { "Idempotency-Key": idempotencyKey.trim() },
      body: JSON.stringify({
        contactId: contactIdRaw.trim(),
        disposition: dispositionRaw.trim(),
      }),
    }),
    {
      success: "Removed from Sales HQ.",
      failure: "Unable to remove from Sales HQ",
      requireReceipt: true,
    },
  );
  await setMutationFlash(feedback);
  revalidatePath(teamSurfaceHref("inbox"));
  revalidatePath(teamSurfaceHref("sales-hq"));
}

export async function runSeoDraftAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const idempotencyKey = formData.get("idempotencyKey");
  if (!isValidTeamIdempotencyKey(idempotencyKey)) {
    await setMutationFlash({
      ok: false,
      message: "The draft request expired. Refresh the page and try again.",
    });
    redirect(teamSurfaceHref("seo"));
  }

  const response = await callAdminApiAs(principal, "/api/admin/seo/run", {
    method: "POST",
    headers: { "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({}),
  });

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to generate SEO draft",
    );
    await setMutationFlash({ ok: false, message });
    redirect(teamSurfaceHref("seo"));
  }

  const payload = await readJsonRecord(response);
  const result =
    payload["data"] && typeof payload["data"] === "object"
      ? (payload["data"] as Record<string, unknown>)
      : null;

  if (result?.["skipped"] === true && typeof result["reason"] === "string") {
    await setMutationFlash({
      ok: true,
      message: `SEO draft generation skipped: ${result["reason"]}`,
    });
  } else if (
    result?.["skipped"] === false &&
    typeof result["title"] === "string"
  ) {
    await setMutationFlash({
      ok: true,
      message: `SEO draft ready for review: ${result["title"]}`,
    });
  } else {
    await setMutationFlash({
      ok: false,
      message: "The SEO draft result could not be confirmed.",
    });
  }

  redirect(teamSurfaceHref("seo"));
}

export async function submitSeoPostForReviewAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const postId = formData.get("postId");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  if (
    typeof postId !== "string" ||
    !isUuid(postId) ||
    typeof expectedVersion !== "string" ||
    !/^\d+$/u.test(expectedVersion) ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "The draft changed or the review request expired. Refresh and try again.",
    });
    redirect(teamSurfaceHref("seo"));
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(
      principal,
      `/api/admin/seo/posts/${encodeURIComponent(postId)}/review`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": expectedVersion,
        },
        body: JSON.stringify({}),
      },
    ),
    {
      success: "SEO draft submitted for review. Nothing is public yet.",
      failure: "Unable to submit SEO draft for review",
    },
  );
  await setMutationFlash(feedback);
  redirect(teamSurfaceHref("seo"));
}

export async function publishSeoPostAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const postId = formData.get("postId");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  const confirmation = formData.get("confirmation");
  if (
    typeof postId !== "string" ||
    !isUuid(postId) ||
    typeof expectedVersion !== "string" ||
    !/^\d+$/u.test(expectedVersion) ||
    !isValidTeamIdempotencyKey(idempotencyKey) ||
    typeof confirmation !== "string" ||
    confirmation.trim().length === 0
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "The publication request is incomplete or expired. Refresh and try again.",
    });
    redirect(teamSurfaceHref("seo"));
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(
      principal,
      `/api/admin/seo/posts/${encodeURIComponent(postId)}/publish`,
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": expectedVersion,
        },
        body: JSON.stringify({ confirmation: confirmation.trim() }),
      },
    ),
    {
      success: `SEO post published: /blog/${confirmation.trim()}`,
      failure: "Unable to publish SEO post",
    },
  );
  await setMutationFlash(feedback);
  redirect(teamSurfaceHref("seo"));
}

export async function runGoogleAdsSyncAction() {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();

  const response = await callAdminApiAs(
    principal,
    "/api/admin/google/ads/sync",
    {
      method: "POST",
      body: JSON.stringify({ days: 14 }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to sync Google Ads",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    redirect(teamSurfaceHref("google-ads"));
  }

  jar.set({ name: "myst-flash", value: "Google Ads sync queued.", path: "/" });
  redirect(teamSurfaceHref("google-ads"));
}

export async function runGoogleAdsAnalystAction() {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();

  const response = await callAdminApiAs(
    principal,
    "/api/admin/google/ads/analyst/run",
    {
      method: "POST",
      body: JSON.stringify({ rangeDays: 7 }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to run marketing analyst",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    redirect(teamSurfaceHref("google-ads"));
  }

  jar.set({
    name: "myst-flash",
    value: "Marketing analyst queued.",
    path: "/",
  });
  redirect(teamSurfaceHref("google-ads"));
}

export async function saveGoogleAdsAnalystSettingsAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const autonomous = formData.get("autonomous");
  const autonomousEnabled = autonomous === "on" || autonomous === "true";

  const response = await callAdminApiAs(
    principal,
    "/api/admin/google/ads/analyst/settings",
    {
      method: "POST",
      body: JSON.stringify({ autonomous: autonomousEnabled }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to save marketing analyst settings",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    redirect(teamSurfaceHref("google-ads"));
  }

  jar.set({
    name: "myst-flash",
    value: "Marketing analyst settings updated.",
    path: "/",
  });
  redirect(teamSurfaceHref("google-ads"));
}

export async function updateGoogleAdsAnalystRecommendationAction(
  formData: FormData,
) {
  const principal = await requireCurrentTeamPrincipal();
  const id = formData.get("id");
  const status = formData.get("status");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  const confirmation = formData.get("confirmation");
  const confirmationMatches =
    (status === "approved" && confirmation === "approve") ||
    (status === "ignored" && confirmation === "ignore") ||
    (status === "proposed" && confirmation === "reset");

  if (
    typeof id !== "string" ||
    !isUuid(id) ||
    (status !== "approved" && status !== "ignored" && status !== "proposed") ||
    typeof expectedVersion !== "string" ||
    expectedVersion.trim().length === 0 ||
    !isValidTeamIdempotencyKey(idempotencyKey) ||
    !confirmationMatches
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "The recommendation decision is incomplete or stale. Refresh and review it again.",
    });
    redirect(teamSurfaceHref("google-ads"));
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(principal, "/api/admin/google/ads/analyst/recommendations", {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "If-Match": expectedVersion.trim(),
      },
      body: JSON.stringify({ id, status, confirmation }),
    }),
    {
      success:
        status === "approved"
          ? "Recommendation approved for a separate apply step."
          : status === "ignored"
            ? "Recommendation ignored."
            : "Recommendation returned to proposed review.",
      failure: "Unable to save the recommendation decision",
    },
  );
  await setMutationFlash(feedback);
  redirect(teamSurfaceHref("google-ads"));
}

export async function applyGoogleAdsAnalystRecommendationAction(
  formData: FormData,
) {
  const principal = await requireCurrentTeamPrincipal();
  const id = formData.get("id");
  const expectedVersion = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  const confirmation = formData.get("confirmation");

  if (
    typeof id !== "string" ||
    !isUuid(id) ||
    typeof expectedVersion !== "string" ||
    expectedVersion.trim().length === 0 ||
    !isValidTeamIdempotencyKey(idempotencyKey) ||
    confirmation !== "apply_google_ads_change"
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "The Google Ads apply request is incomplete or stale. Refresh and review the proposed change.",
    });
    redirect(teamSurfaceHref("google-ads"));
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(
      principal,
      "/api/admin/google/ads/analyst/recommendations/apply",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": expectedVersion.trim(),
        },
        body: JSON.stringify({ id, confirmation }),
      },
    ),
    {
      success:
        "Google Ads confirmed the change. Provider evidence is recorded below.",
      failure: "Unable to confirm the Google Ads change",
    },
  );
  await setMutationFlash(feedback);
  redirect(teamSurfaceHref("google-ads"));
}

type GoogleAdsActionItem = { id: string; expectedVersion: string };

function parseGoogleAdsActionItems(
  value: unknown,
): GoogleAdsActionItem[] | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed.length) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const items: GoogleAdsActionItem[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const id = record["id"];
      const expectedVersion = record["expectedVersion"];
      if (
        typeof id !== "string" ||
        !isUuid(id) ||
        typeof expectedVersion !== "string" ||
        expectedVersion.trim().length === 0
      ) {
        return null;
      }
      items.push({ id, expectedVersion: expectedVersion.trim() });
    }
    if (new Set(items.map((item) => item.id)).size !== items.length) {
      return null;
    }
    return items;
  } catch {
    return null;
  }
}

export async function bulkUpdateGoogleAdsAnalystRecommendationsAction(
  formData: FormData,
) {
  const principal = await requireCurrentTeamPrincipal();
  const items = parseGoogleAdsActionItems(formData.get("items"));
  const status = formData.get("status");
  const confirmation = formData.get("confirmation");
  const idempotencyKey = formData.get("idempotencyKey");
  const confirmationMatches =
    (status === "approved" && confirmation === "approve") ||
    (status === "ignored" && confirmation === "ignore") ||
    (status === "proposed" && confirmation === "reset");

  if (
    items === null ||
    items.length > 200 ||
    (status !== "approved" && status !== "ignored" && status !== "proposed") ||
    !isValidTeamIdempotencyKey(idempotencyKey) ||
    !confirmationMatches
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "The bulk recommendation decision is incomplete or stale. Refresh and select the items again.",
    });
    redirect(teamSurfaceHref("google-ads"));
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(
      principal,
      "/api/admin/google/ads/analyst/recommendations/bulk",
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ items, status, confirmation }),
      },
    ),
    {
      success: `Saved ${items.length} recommendation decision(s).`,
      failure: "Unable to save the bulk recommendation decisions",
    },
  );
  await setMutationFlash(feedback);
  redirect(teamSurfaceHref("google-ads"));
}

export async function bulkApplyGoogleAdsAnalystRecommendationsAction(
  formData: FormData,
) {
  const principal = await requireCurrentTeamPrincipal();
  const items = parseGoogleAdsActionItems(formData.get("items"));
  const idempotencyKey = formData.get("idempotencyKey");
  const confirmation = formData.get("confirmation");

  if (
    items === null ||
    items.length > 25 ||
    !isValidTeamIdempotencyKey(idempotencyKey) ||
    confirmation !== "apply_google_ads_changes"
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "Select and confirm between 1 and 25 current Google Ads recommendations.",
    });
    redirect(teamSurfaceHref("google-ads"));
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(
      principal,
      "/api/admin/google/ads/analyst/recommendations/apply/bulk",
      {
        method: "POST",
        headers: { "Idempotency-Key": idempotencyKey },
        body: JSON.stringify({ items, confirmation }),
      },
    ),
    {
      success:
        "Google Ads confirmed every selected change. Provider evidence is recorded per item.",
      failure: "The bulk Google Ads result was not fully successful",
    },
  );
  await setMutationFlash(feedback);
  redirect(teamSurfaceHref("google-ads"));
}

type OutboundImportRow = {
  company?: string;
  contactName?: string;
  phone?: string;
  email?: string;
  website?: string;
  domain?: string;
  title?: string;
  industry?: string;
  companySize?: string;
  linkedinUrl?: string;
  city?: string;
  state?: string;
  zip?: string;
  sourceListName?: string;
  notes?: string;
};

function parseDelimitedLine(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      const next = line[i + 1];
      if (inQuotes && next === '"') {
        current += '"';
        i += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && char === delimiter) {
      cells.push(current.trim());
      current = "";
      continue;
    }

    current += char;
  }

  cells.push(current.trim());
  return cells;
}

function detectDelimiter(headerLine: string): string {
  const commaCount = (headerLine.match(/,/g) ?? []).length;
  const tabCount = (headerLine.match(/\t/g) ?? []).length;
  const semiCount = (headerLine.match(/;/g) ?? []).length;

  if (tabCount > commaCount && tabCount > semiCount) return "\t";
  if (semiCount > commaCount) return ";";
  return ",";
}

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "");
}

function coerceRow(
  rows: Record<string, string>,
  keys: string[],
): string | undefined {
  for (const key of keys) {
    const value = rows[key];
    if (typeof value === "string" && value.trim().length) return value.trim();
  }
  return undefined;
}

function parseOutboundCsv(text: string): OutboundImportRow[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];

  const delimiter = detectDelimiter(lines[0] ?? "");
  const headersRaw = parseDelimitedLine(lines[0] ?? "", delimiter);
  const headers = headersRaw.map(normalizeHeader);
  const rows: OutboundImportRow[] = [];

  for (const rawLine of lines.slice(1)) {
    const cells = parseDelimitedLine(rawLine, delimiter);
    const record: Record<string, string> = {};
    for (let i = 0; i < headers.length; i += 1) {
      const header = headers[i];
      if (!header) continue;
      record[header] = (cells[i] ?? "").trim();
    }

    const company = coerceRow(record, [
      "company",
      "company_name",
      "business",
      "property_manager",
      "property_management_company",
    ]);
    const contactName = coerceRow(record, [
      "contactname",
      "contact_name",
      "name",
      "contact",
      "full_name",
    ]);
    const phone = coerceRow(record, [
      "phone",
      "phone_number",
      "mobile",
      "cell",
    ]);
    const email = coerceRow(record, ["email", "email_address"]);
    const website = coerceRow(record, [
      "website",
      "site",
      "url",
      "company_website",
    ]);
    const domain = coerceRow(record, [
      "domain",
      "company_domain",
      "email_domain",
    ]);
    const title = coerceRow(record, ["title", "job_title", "role"]);
    const industry = coerceRow(record, ["industry", "vertical", "segment"]);
    const companySize = coerceRow(record, [
      "company_size",
      "employees",
      "employee_count",
      "employee_range",
      "organization_num_employees",
    ]);
    const linkedinUrl = coerceRow(record, [
      "linkedin_url",
      "person_linkedin_url",
      "company_linkedin_url",
      "linkedin",
    ]);
    const city = coerceRow(record, ["city"]);
    const state = coerceRow(record, ["state"]);
    const zip = coerceRow(record, ["zip", "zipcode", "postal", "postal_code"]);
    const sourceListName = coerceRow(record, [
      "source_list_name",
      "list_name",
      "apollo_list",
      "list",
    ]);
    const notes = coerceRow(record, ["notes", "note", "details"]);

    if (!company && !contactName && !phone && !email && !website && !domain)
      continue;

    rows.push({
      company,
      contactName,
      phone,
      email,
      website,
      domain,
      title,
      industry,
      companySize,
      linkedinUrl,
      city,
      state,
      zip,
      sourceListName,
      notes,
    });
  }

  return rows;
}

export async function importOutboundProspectsAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();

  const campaignRaw = formData.get("campaign");
  const campaign =
    typeof campaignRaw === "string" && campaignRaw.trim().length
      ? campaignRaw.trim()
      : "property_management";

  const assigneeRaw = formData.get("assignedToMemberId");
  const assignedToMemberId =
    typeof assigneeRaw === "string" && assigneeRaw.trim().length
      ? assigneeRaw.trim()
      : null;

  const file = formData.get("file");
  const csvTextRaw = formData.get("csv");

  let text = typeof csvTextRaw === "string" ? csvTextRaw : "";
  if (
    (!text || text.trim().length === 0) &&
    file instanceof File &&
    file.size > 0
  ) {
    text = await file.text();
  }

  if (!text || text.trim().length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "Paste a CSV or upload a file first.",
      path: "/",
    });
    redirect(teamSurfaceHref("outbound"));
  }

  const parsed = parseOutboundCsv(text);
  if (parsed.length === 0) {
    jar.set({
      name: "myst-flash-error",
      value: "No valid rows found. Include at least email or phone.",
      path: "/",
    });
    redirect(teamSurfaceHref("outbound"));
  }

  if (parsed.length > 2000) {
    jar.set({
      name: "myst-flash-error",
      value: `This file has ${parsed.length.toLocaleString()} data rows. Split it into files of 2,000 rows or fewer; nothing was imported.`,
      path: "/",
    });
    redirect(teamSurfaceHref("outbound"));
  }

  const rows = parsed;

  const response = await callAdminApiAs(
    principal,
    "/api/admin/outbound/import",
    {
      method: "POST",
      body: JSON.stringify({
        campaign,
        assignedToMemberId: assignedToMemberId ?? undefined,
        rows,
      }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to import outbound list",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    redirect(teamSurfaceHref("outbound"));
  }

  const payload = await readJsonRecord(response);
  const created = Number(payload["created"] ?? 0);
  const updated = Number(payload["updated"] ?? 0);
  const tasksCreated = Number(payload["tasksCreated"] ?? 0);
  const skipped = Number(payload["skipped"] ?? 0);
  const resolvedAssignee =
    typeof payload["assignedToMemberId"] === "string"
      ? payload["assignedToMemberId"]
      : assignedToMemberId;

  jar.set({
    name: "myst-flash",
    value: `Outbound imported: ${created} new, ${updated} updated, ${tasksCreated} tasks, ${skipped} skipped.`,
    path: "/",
  });

  redirect(
    teamSurfaceHref("outbound", {
      query: { memberId: resolvedAssignee || undefined },
    }),
  );
}

export async function setOutboundDispositionAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const taskIdRaw = formData.get("taskId");
  const dispositionRaw = formData.get("disposition");
  const callbackAtRaw = formData.get("callbackAt");
  const recapRaw = formData.get("recap");
  const idempotencyKey = formData.get("idempotencyKey");
  const expectedVersionRaw = formData.get("expectedVersion");

  const taskId = typeof taskIdRaw === "string" ? taskIdRaw.trim() : "";
  const disposition =
    typeof dispositionRaw === "string" ? dispositionRaw.trim() : "";
  const callbackAtString =
    typeof callbackAtRaw === "string" ? callbackAtRaw.trim() : "";
  const recap =
    typeof recapRaw === "string" && recapRaw.trim().length
      ? recapRaw.trim()
      : null;
  const expectedVersion =
    typeof expectedVersionRaw === "string" ? expectedVersionRaw.trim() : "";
  const callbackAt = callbackAtString
    ? (parseOutboundCallbackLocal(callbackAtString) ?? "invalid")
    : null;

  if (
    !isUuid(taskId) ||
    !isValidTeamIdempotencyKey(idempotencyKey) ||
    !expectedVersion ||
    Number.isNaN(Date.parse(expectedVersion)) ||
    !disposition ||
    callbackAt === "invalid" ||
    (recap?.length ?? 0) > 4_000
  ) {
    jar.set({
      name: "myst-flash-error",
      value:
        "This outbound update is incomplete or stale. Keep your notes, refresh the queue, and try again.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  let response: Response;
  try {
    response = await callOutboundMutationWithSafeReplay(
      principal,
      "/api/admin/outbound/disposition",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": expectedVersion,
        },
        body: JSON.stringify({
          taskId,
          disposition,
          callbackAt: callbackAt ?? undefined,
          recap: recap ?? undefined,
        }),
      },
    );
  } catch (error) {
    jar.set({
      name: "myst-flash-error",
      value: readTeamMutationException(
        error,
        "Unable to confirm the outbound disposition",
      ),
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to save disposition",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const envelope = parseOutboundTaskMutationSuccess(
    await response.json().catch(() => null),
    {
      actorId: principal.memberId,
      taskId,
      disposition,
      ...(disposition === "callback_requested" && callbackAt
        ? { callbackAt }
        : {}),
    },
  );
  if (!envelope) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The service returned an unreadable outbound receipt, so no success is being claimed. Refresh before retrying.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  jar.set({
    name: "myst-flash",
    value: envelope.data.stopped
      ? "Outbound updated and the cadence was stopped."
      : envelope.data.nextDueAt
        ? "Outbound updated and the next touch was scheduled."
        : "Outbound updated.",
    path: "/",
  });
  revalidatePath("/team");
}

export async function draftOutboundFollowupAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const contactIdRaw = formData.get("contactId");
  const taskIdRaw = formData.get("taskId");
  const channelRaw = formData.get("channel");
  const dispositionRaw = formData.get("disposition");
  const recapRaw = formData.get("recap");

  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  const taskId = typeof taskIdRaw === "string" ? taskIdRaw.trim() : "";
  const channel = typeof channelRaw === "string" ? channelRaw.trim() : "";
  const disposition =
    typeof dispositionRaw === "string" && dispositionRaw.trim().length
      ? dispositionRaw.trim()
      : "";
  const recap =
    typeof recapRaw === "string" && recapRaw.trim().length
      ? recapRaw.trim()
      : "";

  if (!contactId) {
    jar.set({
      name: "myst-flash-error",
      value: "Contact ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    "/api/admin/outbound/draft",
    {
      method: "POST",
      body: JSON.stringify({
        contactId,
        ...(taskId ? { taskId } : {}),
        ...(channel ? { channel } : {}),
        kind: "follow_up",
        ...(disposition ? { disposition } : {}),
        ...(recap ? { recap } : {}),
      }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to suggest follow-up",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload = (await response.json().catch(() => null)) as {
    threadId?: string;
    channel?: string;
  } | null;

  const threadId =
    typeof payload?.threadId === "string" ? payload.threadId.trim() : "";
  const resolvedChannel =
    typeof payload?.channel === "string"
      ? payload.channel.trim()
      : channel || "sms";

  if (!threadId) {
    jar.set({
      name: "myst-flash-error",
      value: "Suggestion created but thread is missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  jar.set({
    name: "myst-flash",
    value: "Suggestion created. Review and send from Inbox.",
    path: "/",
  });

  redirect(
    teamSurfaceHref("inbox", {
      query: { threadId, contactId, channel: resolvedChannel },
    }),
  );
}

export async function startOutboundCadenceAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const taskIdRaw = formData.get("taskId");
  const taskId = typeof taskIdRaw === "string" ? taskIdRaw.trim() : "";
  const idempotencyKey = formData.get("idempotencyKey");
  const expectedVersionRaw = formData.get("expectedVersion");
  const expectedVersion =
    typeof expectedVersionRaw === "string" ? expectedVersionRaw.trim() : "";

  if (
    !isUuid(taskId) ||
    !isValidTeamIdempotencyKey(idempotencyKey) ||
    !expectedVersion ||
    Number.isNaN(Date.parse(expectedVersion))
  ) {
    jar.set({
      name: "myst-flash-error",
      value:
        "This cadence request is stale. Refresh the outbound queue and try again.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  let response: Response;
  try {
    response = await callOutboundMutationWithSafeReplay(
      principal,
      "/api/admin/outbound/start",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": expectedVersion,
        },
        body: JSON.stringify({ taskId }),
      },
    );
  } catch (error) {
    jar.set({
      name: "myst-flash-error",
      value: readTeamMutationException(
        error,
        "Unable to confirm the outbound cadence start",
      ),
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to start outbound cadence",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const envelope = parseOutboundTaskMutationSuccess(
    await response.json().catch(() => null),
    { actorId: principal.memberId, taskId },
  );
  jar.set({
    name: envelope ? "myst-flash" : "myst-flash-error",
    value: envelope
      ? envelope.data.alreadyStarted
        ? "Outbound cadence was already started."
        : "Outbound cadence started."
      : "The service returned an unreadable cadence receipt, so no success is being claimed. Refresh before retrying.",
    path: "/",
  });
  revalidatePath("/team");
}

export async function draftOutboundFirstTouchAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const contactIdRaw = formData.get("contactId");
  const taskIdRaw = formData.get("taskId");
  const channelRaw = formData.get("channel");

  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  const taskId = typeof taskIdRaw === "string" ? taskIdRaw.trim() : "";
  const channel = typeof channelRaw === "string" ? channelRaw.trim() : "";

  if (!contactId) {
    jar.set({
      name: "myst-flash-error",
      value: "Contact ID missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const response = await callAdminApiAs(
    principal,
    "/api/admin/outbound/draft",
    {
      method: "POST",
      body: JSON.stringify({
        contactId,
        ...(taskId ? { taskId } : {}),
        ...(channel ? { channel } : {}),
      }),
    },
  );

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to suggest outreach",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const payload = (await response.json().catch(() => null)) as {
    threadId?: string;
    channel?: string;
  } | null;

  const threadId =
    typeof payload?.threadId === "string" ? payload.threadId.trim() : "";
  const resolvedChannel =
    typeof payload?.channel === "string"
      ? payload.channel.trim()
      : channel || "sms";

  if (!threadId) {
    jar.set({
      name: "myst-flash-error",
      value: "Suggestion created but thread is missing",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  jar.set({
    name: "myst-flash",
    value: "Suggestion created. Review and send from Inbox.",
    path: "/",
  });

  redirect(
    teamSurfaceHref("inbox", {
      query: { threadId, contactId, channel: resolvedChannel },
    }),
  );
}

export async function bulkOutboundAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();

  const actionRaw = formData.get("action");
  const action = typeof actionRaw === "string" ? actionRaw.trim() : "";

  const assignedToRaw = formData.get("assignedToMemberId");
  const assignedToMemberId =
    typeof assignedToRaw === "string" && assignedToRaw.trim().length
      ? assignedToRaw.trim()
      : null;

  const snoozePresetRaw = formData.get("snoozePreset");
  const snoozePreset =
    typeof snoozePresetRaw === "string" && snoozePresetRaw.trim().length
      ? snoozePresetRaw.trim()
      : null;
  const idempotencyKey = formData.get("idempotencyKey");
  const tasks: OutboundTaskReference[] = [];
  for (const raw of formData.getAll("taskRefs")) {
    if (typeof raw !== "string") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      parsed = null;
    }
    if (!Array.isArray(parsed) || !parsed.every(isOutboundTaskReference)) {
      jar.set({
        name: "myst-flash-error",
        value:
          "The selected outbound rows are stale. Refresh and select them again.",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }
    tasks.push(...parsed);
  }
  const taskIds = tasks.map((task) => task.id);
  const uniqueTaskIds = new Set(taskIds);

  if (
    tasks.length === 0 ||
    tasks.length > 500 ||
    uniqueTaskIds.size !== taskIds.length ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "Select at least one prospect first.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (
    action !== "assign" &&
    action !== "start" &&
    action !== "assign_start" &&
    action !== "snooze"
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "Pick a bulk action first.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (
    (action === "assign" || action === "assign_start") &&
    !assignedToMemberId
  ) {
    jar.set({
      name: "myst-flash-error",
      value: "Pick a team member to assign to.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (action === "snooze" && !snoozePreset) {
    jar.set({
      name: "myst-flash-error",
      value: "Pick a snooze time first.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  const submittedVersion = outboundBulkVersion(tasks);

  let response: Response;
  try {
    response = await callOutboundMutationWithSafeReplay(
      principal,
      "/api/admin/outbound/bulk",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": submittedVersion,
        },
        body: JSON.stringify({
          action,
          ...(action === "assign" || action === "assign_start"
            ? { assignedToMemberId }
            : {}),
          ...(action === "snooze" ? { snoozePreset } : {}),
          tasks,
        }),
      },
    );
  } catch (error) {
    jar.set({
      name: "myst-flash-error",
      value: readTeamMutationException(
        error,
        "Unable to confirm the outbound bulk update",
      ),
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  if (!response.ok) {
    const message = await readErrorMessage(
      response,
      "Unable to apply bulk action",
    );
    jar.set({ name: "myst-flash-error", value: message, path: "/" });
    revalidatePath("/team");
    return;
  }

  const envelope = parseOutboundBulkMutationSuccess(
    await response.json().catch(() => null),
    {
      actorId: principal.memberId,
      action,
      submittedVersion,
      taskIds,
    },
  );
  if (!envelope) {
    jar.set({
      name: "myst-flash-error",
      value:
        "The service returned an unreadable bulk receipt, so no success is being claimed. Refresh before retrying.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }
  jar.set({
    name: "myst-flash",
    value: `Outbound updated: ${envelope.data.updated} changed (${envelope.data.skipped} already current).`,
    path: "/",
  });
  revalidatePath("/team");
}

export async function partnerScheduleCheckinAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const contactIdRaw = formData.get("contactId");
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  const idempotencyKey = formData.get("idempotencyKey");
  const expectedVersionRaw = formData.get("expectedVersion");
  const expectedVersion =
    typeof expectedVersionRaw === "string" ? expectedVersionRaw.trim() : "";

  const daysRaw = formData.get("daysFromNow");
  const daysFromNow =
    typeof daysRaw === "string" && daysRaw.trim().length
      ? Number(daysRaw.trim())
      : null;

  const dueAtRaw = formData.get("dueAt");
  const dueAt =
    typeof dueAtRaw === "string" && dueAtRaw.trim().length
      ? dueAtRaw.trim()
      : null;

  const assignedToRaw = formData.get("assignedToMemberId");
  const assignedToMemberId =
    typeof assignedToRaw === "string" && assignedToRaw.trim().length
      ? assignedToRaw.trim()
      : null;

  if (
    !isUuid(contactId) ||
    !isValidTeamIdempotencyKey(idempotencyKey) ||
    !expectedVersion ||
    Number.isNaN(new Date(expectedVersion).getTime()) ||
    (daysFromNow !== null &&
      (!Number.isSafeInteger(daysFromNow) ||
        daysFromNow < 1 ||
        daysFromNow > 365))
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "This check-in request is incomplete or expired. Refresh the partner list and try again.",
    });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(principal, "/api/admin/partners/checkin", {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "If-Match": expectedVersion,
      },
      body: JSON.stringify({
        contactId,
        ...(dueAt ? { dueAt } : {}),
        ...(daysFromNow !== null && Number.isFinite(daysFromNow)
          ? { daysFromNow }
          : {}),
        ...(assignedToMemberId ? { assignedToMemberId } : {}),
      }),
    }),
    {
      success: "Partner check-in scheduled.",
      failure: "Unable to schedule the partner check-in",
      requireReceipt: true,
    },
  );
  await setMutationFlash(feedback);
  revalidatePath("/team");
}

export async function partnerLogTouchAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const contactIdRaw = formData.get("contactId");
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  const idempotencyKey = formData.get("idempotencyKey");
  const expectedVersionRaw = formData.get("expectedVersion");
  const expectedVersion =
    typeof expectedVersionRaw === "string" ? expectedVersionRaw.trim() : "";

  const nextTouchDaysRaw = formData.get("nextTouchDays");
  const nextTouchDays =
    typeof nextTouchDaysRaw === "string" && nextTouchDaysRaw.trim().length
      ? Number(nextTouchDaysRaw.trim())
      : null;

  if (
    !isUuid(contactId) ||
    !isValidTeamIdempotencyKey(idempotencyKey) ||
    !expectedVersion ||
    Number.isNaN(new Date(expectedVersion).getTime()) ||
    (nextTouchDays !== null &&
      (!Number.isSafeInteger(nextTouchDays) ||
        nextTouchDays < 1 ||
        nextTouchDays > 365))
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "This partner-touch request is incomplete or expired. Refresh the partner list and try again.",
    });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(principal, "/api/admin/partners/touch", {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "If-Match": expectedVersion,
      },
      body: JSON.stringify({
        contactId,
        ...(nextTouchDays !== null && Number.isFinite(nextTouchDays)
          ? { nextTouchDays }
          : {}),
      }),
    }),
    {
      success: "Partner touch logged and the next check-in scheduled.",
      failure: "Unable to log the partner touch",
      requireReceipt: true,
    },
  );
  await setMutationFlash(feedback);
  revalidatePath("/team");
}

export async function partnerLogReferralAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const contactIdRaw = formData.get("contactId");
  const contactId = typeof contactIdRaw === "string" ? contactIdRaw.trim() : "";
  const idempotencyKey = formData.get("idempotencyKey");
  const expectedVersionRaw = formData.get("expectedVersion");
  const expectedVersion =
    typeof expectedVersionRaw === "string" ? expectedVersionRaw.trim() : "";

  if (
    !isUuid(contactId) ||
    !isValidTeamIdempotencyKey(idempotencyKey) ||
    !expectedVersion ||
    Number.isNaN(new Date(expectedVersion).getTime())
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "This referral request is incomplete or expired. Refresh the partner list and try again.",
    });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(principal, "/api/admin/partners/referral", {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "If-Match": expectedVersion,
      },
      body: JSON.stringify({ contactId }),
    }),
    {
      success: "Partner referral logged.",
      failure: "Unable to log the partner referral",
      requireReceipt: true,
    },
  );
  await setMutationFlash(feedback);
  revalidatePath("/team");
}

export async function partnerAccessApplicationDecisionAction(
  formData: FormData,
) {
  const principal = await requireCurrentTeamPrincipal();
  const applicationIdRaw = formData.get("applicationId");
  const actionRaw = formData.get("decision");
  const noteRaw = formData.get("note");
  const confirmationRaw = formData.get("confirmation");
  const roleKeyRaw = formData.get("roleKey");
  const accessLevelRaw = formData.get("accessLevel");
  const locationIdsRaw = formData.get("locationIds");
  const costCenterIdsRaw = formData.get("costCenterIds");
  const expectedVersionRaw = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  const applicationId =
    typeof applicationIdRaw === "string" ? applicationIdRaw.trim() : "";
  const action =
    actionRaw === "approve" ||
    actionRaw === "decline" ||
    actionRaw === "needs_information"
      ? actionRaw
      : null;
  const note = typeof noteRaw === "string" ? noteRaw.trim() : "";
  const confirmation =
    typeof confirmationRaw === "string" ? confirmationRaw.trim() : "";
  const roleKey =
    typeof roleKeyRaw === "string" &&
    ["administrator", "operations", "billing_approver", "viewer"].includes(
      roleKeyRaw,
    )
      ? roleKeyRaw
      : null;
  const accessLevel =
    accessLevelRaw === "account" || accessLevelRaw === "scoped"
      ? accessLevelRaw
      : null;
  const parseScopeIds = (raw: FormDataEntryValue | null): string[] | null => {
    if (typeof raw !== "string" || raw.length > 9_000) return null;
    const values = raw
      .split(/[\s,]+/u)
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    return values.length <= 250 &&
      values.every(isUuid) &&
      new Set(values).size === values.length
      ? values
      : null;
  };
  const locationIds = parseScopeIds(locationIdsRaw);
  const costCenterIds = parseScopeIds(costCenterIdsRaw);
  const expectedVersion =
    typeof expectedVersionRaw === "string" ? expectedVersionRaw.trim() : "";
  const expectedConfirmation =
    action === "approve"
      ? "APPROVE"
      : action === "decline"
        ? "DECLINE"
        : action === "needs_information"
          ? "REQUEST INFORMATION"
          : "";

  const requiredPermission =
    action === "approve"
      ? "partners.applications.approve"
      : action === "decline"
        ? "partners.applications.decline"
        : "partners.applications.review";
  if (!hasTeamPermission(principal, requiredPermission)) {
    await setMutationFlash({
      ok: false,
      message:
        "You do not have permission to make this Partner Portal application decision.",
    });
    revalidatePath("/team");
    return;
  }
  if (
    !isUuid(applicationId) ||
    !action ||
    !/^\d{1,10}$/u.test(expectedVersion) ||
    !isValidTeamIdempotencyKey(idempotencyKey) ||
    confirmation !== expectedConfirmation ||
    (action === "approve" &&
      (!roleKey ||
        !accessLevel ||
        locationIds === null ||
        costCenterIds === null ||
        (roleKey === "administrator" && accessLevel !== "account") ||
        (accessLevel === "account" &&
          locationIds.length + costCenterIds.length !== 0) ||
        (accessLevel === "scoped" &&
          locationIds.length + costCenterIds.length === 0))) ||
    note.length > (action === "approve" ? 1_000 : 2_000) ||
    (action !== "approve" && note.length < 2)
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "This access decision is incomplete, stale, or not confirmed. Refresh the partner queue and try again.",
    });
    revalidatePath("/team");
    return;
  }

  try {
    const response = await callAdminMutationWithSafeReplay(
      principal,
      `/api/admin/partners/access-applications/${encodeURIComponent(applicationId)}`,
      {
        method: "PATCH",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": expectedVersion,
        },
        body: JSON.stringify({
          action,
          note: note || null,
          confirmation,
          ...(action === "approve"
            ? {
                roleKey,
                accessLevel,
                locationIds,
                costCenterIds,
              }
            : {}),
        }),
      },
    );
    if (!response.ok) {
      await setMutationFlash({
        ok: false,
        message: await readTeamMutationError(
          response,
          "Unable to save the access decision",
        ),
      });
      revalidatePath("/team");
      return;
    }
    const payload = (await response.json().catch(() => null)) as {
      ok?: unknown;
      data?: {
        application?: {
          id?: unknown;
          status?: unknown;
          version?: unknown;
        };
        access?: { state?: unknown; roleKey?: unknown };
      };
      receipt?: {
        actorId?: unknown;
        entityType?: unknown;
        entityId?: unknown;
        version?: unknown;
      };
    } | null;
    const expectedStatus =
      action === "approve"
        ? "approved"
        : action === "decline"
          ? "declined"
          : "needs_information";
    const application = payload?.data?.application;
    const receipt = payload?.receipt;
    if (
      payload?.ok !== true ||
      application?.id !== applicationId ||
      application.status !== expectedStatus ||
      typeof application.version !== "string" ||
      receipt?.actorId !== principal.memberId ||
      receipt.entityType !== "partner_access_application" ||
      receipt.entityId !== applicationId ||
      receipt.version !== application.version
    ) {
      await setMutationFlash({
        ok: false,
        message:
          "The access service returned an unreadable receipt, so no success is being claimed. Refresh the queue before retrying.",
      });
      revalidatePath("/team");
      return;
    }
    await setMutationFlash({
      ok: true,
      message:
        action === "approve"
          ? "Partner access approved with the selected role and scope. The applicant must complete activation before signing in. Pricing and instant confirmation remain separately configured."
          : action === "decline"
            ? "Partner access declined and the generated limited workspace disabled."
            : "The application now shows the information request for follow-up.",
    });
    revalidatePath("/team");
    revalidatePath("/team/partners");
  } catch (error) {
    await setMutationFlash({
      ok: false,
      message: readTeamMutationException(
        error,
        "Unable to confirm the access decision",
      ),
    });
    revalidatePath("/team");
  }
}

export async function partnerPortalInviteUserAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const jar = await cookies();
  const orgContactIdRaw = formData.get("orgContactId");
  const orgContactId =
    typeof orgContactIdRaw === "string" ? orgContactIdRaw.trim() : "";

  const emailRaw = formData.get("email");
  const email = typeof emailRaw === "string" ? emailRaw.trim() : "";

  const phoneRaw = formData.get("phone");
  const phone = typeof phoneRaw === "string" ? phoneRaw.trim() : "";

  const nameRaw = formData.get("name");
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";

  const idempotencyKey = formData.get("idempotencyKey");
  const expectedVersionRaw = formData.get("expectedVersion");
  const expectedVersion =
    typeof expectedVersionRaw === "string" ? expectedVersionRaw.trim() : "";
  const validExpectedVersion =
    expectedVersion === "new" ||
    (!Number.isNaN(new Date(expectedVersion).getTime()) &&
      new Date(expectedVersion).toISOString() === expectedVersion);

  if (
    !isUuid(orgContactId) ||
    !email ||
    !name ||
    !validExpectedVersion ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    jar.set({
      name: "myst-flash-error",
      value: !isValidTeamIdempotencyKey(idempotencyKey)
        ? "The invite request expired. Refresh this partner and try again."
        : !validExpectedVersion
          ? "The portal-user list changed or is unavailable. Reload this partner before sending an invite."
          : "Partner, email, and name are required.",
      path: "/",
    });
    revalidatePath("/team");
    return;
  }

  try {
    const response = await callAdminApiAs(
      principal,
      "/api/admin/partners/users",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": expectedVersion,
        },
        body: JSON.stringify({
          orgContactId,
          email,
          name,
          phone: phone.length ? phone : null,
        }),
      },
    );

    if (!response.ok) {
      const errorPayload = (await response
        .clone()
        .json()
        .catch(() => null)) as {
        message?: unknown;
      } | null;
      const reconciliationRequired =
        response.headers.get("x-operation-state") ===
          "reconciliation_required" ||
        (typeof errorPayload?.message === "string" &&
          errorPayload.message.includes("requires reconciliation"));
      const knownProviderFailure =
        response.headers.get("x-operation-state") === "failed" ||
        (typeof errorPayload?.message === "string" &&
          errorPayload.message.startsWith("No delivery provider accepted"));
      const message =
        reconciliationRequired || knownProviderFailure
          ? typeof errorPayload?.message === "string"
            ? errorPayload.message
            : reconciliationRequired
              ? "The invite may have reached a provider. Do not resend it until the audit log is reviewed."
              : "No delivery provider accepted this invite. Check provider status before trying again."
          : await readErrorMessage(response, "Unable to invite partner user");
      jar.set({ name: "myst-flash-error", value: message, path: "/" });
      revalidatePath("/team");
      return;
    }

    const responsePayload = parsePartnerInviteSuccess(
      await response.json().catch(() => null),
      {
        orgContactId,
        email,
        requestedChannels: phone.length ? ["email", "sms"] : ["email"],
      },
    );
    if (
      !responsePayload ||
      response.headers.get("x-operation-state") !== "succeeded"
    ) {
      jar.set({
        name: "myst-flash-error",
        value:
          "The invite provider returned an unreadable success receipt, so no success is being claimed. Refresh the portal-user list and audit log before retrying.",
        path: "/",
      });
      revalidatePath("/team");
      return;
    }
    const { acceptedChannels, failedChannels } = responsePayload.data.delivery;
    const acceptedLabel = acceptedChannels.join(" and ");
    jar.set({
      name: "myst-flash",
      value: `Invite accepted for delivery by ${acceptedLabel}.${
        failedChannels.length > 0
          ? ` ${failedChannels.join(" and ")} was not accepted; the audit log has details.`
          : " Provider acceptance does not guarantee final delivery."
      }`,
      path: "/",
    });
    revalidatePath("/team");
  } catch (error) {
    jar.set({
      name: "myst-flash-error",
      value: readTeamMutationException(
        error,
        "Unable to confirm the partner invite",
      ),
      path: "/",
    });
    revalidatePath("/team");
  }
}

export async function partnerMembershipLifecycleAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const membershipId = readFormString(formData, "membershipId");
  const accountId = readFormString(formData, "accountId");
  const action = readFormString(formData, "membershipAction");
  const confirmation = readFormString(formData, "confirmation");
  const expectedVersion = readFormString(formData, "expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  const expectedConfirmation =
    action === "suspend"
      ? "SUSPEND MEMBERSHIP"
      : action === "reactivate"
        ? "REACTIVATE MEMBERSHIP"
        : "";
  if (
    !isUuid(membershipId) ||
    !isUuid(accountId) ||
    !expectedConfirmation ||
    confirmation !== expectedConfirmation ||
    !isValidTeamIdempotencyKey(idempotencyKey) ||
    Number.isNaN(new Date(expectedVersion).getTime()) ||
    new Date(expectedVersion).toISOString() !== expectedVersion
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "This membership request is incomplete, stale, or not confirmed. Refresh Partner administration and try again.",
    });
    revalidatePath("/team/partners");
    return;
  }

  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/memberships/${encodeURIComponent(membershipId)}`,
      {
        method: "PATCH",
        headers: {
          "Idempotency-Key": String(idempotencyKey),
          "If-Match": expectedVersion,
        },
        body: JSON.stringify({ accountId, action, confirmation }),
      },
    );
    if (!response.ok) {
      await setMutationFlash({
        ok: false,
        message: await readTeamMutationError(
          response,
          "Unable to change the partner membership",
        ),
      });
      revalidatePath("/team/partners");
      return;
    }
    const success = await readTeamMutationSuccess<{
      membershipId?: unknown;
      partnerAccountId?: unknown;
      status?: unknown;
    }>(response);
    if (
      !success ||
      success.data.membershipId !== membershipId ||
      success.data.partnerAccountId !== accountId ||
      success.data.status !== (action === "suspend" ? "suspended" : "active")
    ) {
      await setMutationFlash({
        ok: false,
        message:
          "The membership service returned an unreadable success receipt. Refresh before retrying; no additional change is being claimed.",
      });
      revalidatePath("/team/partners");
      return;
    }
    await setMutationFlash({
      ok: true,
      message:
        action === "suspend"
          ? "Company membership suspended and account-bound sessions revoked. Other company memberships were not changed."
          : "Company membership reactivated. Previously revoked sessions remain revoked.",
    });
  } catch (error) {
    await setMutationFlash({
      ok: false,
      message: readTeamMutationException(
        error,
        "Unable to confirm the membership change",
      ),
    });
  }
  revalidatePath("/team/partners");
}

export async function partnerPortalSetUserActiveAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const orgContactIdRaw = formData.get("orgContactId");
  const userIdRaw = formData.get("userId");
  const activeRaw = formData.get("active");
  const confirmationRaw = formData.get("confirmation");
  const expectedVersionRaw = formData.get("expectedVersion");
  const idempotencyKey = formData.get("idempotencyKey");
  const orgContactId =
    typeof orgContactIdRaw === "string" ? orgContactIdRaw.trim() : "";
  const userId = typeof userIdRaw === "string" ? userIdRaw.trim() : "";
  const active =
    activeRaw === "true" ? true : activeRaw === "false" ? false : null;
  const confirmation =
    typeof confirmationRaw === "string" ? confirmationRaw.trim() : "";
  const expectedVersion =
    typeof expectedVersionRaw === "string" ? expectedVersionRaw.trim() : "";

  if (
    !isUuid(orgContactId) ||
    !isUuid(userId) ||
    active === null ||
    confirmation !== (active ? "ACTIVATE" : "DEACTIVATE") ||
    !isValidTeamIdempotencyKey(idempotencyKey) ||
    Number.isNaN(new Date(expectedVersion).getTime()) ||
    new Date(expectedVersion).toISOString() !== expectedVersion
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "This portal-access request is incomplete, stale, or not confirmed. Reload the partner workspace and try again.",
    });
    revalidatePath("/team");
    return;
  }

  try {
    const response = await callAdminApiAs(
      principal,
      "/api/admin/partners/users",
      {
        method: "PATCH",
        headers: {
          "Idempotency-Key": idempotencyKey,
          "If-Match": expectedVersion,
        },
        body: JSON.stringify({
          active,
          confirmation,
          orgContactId,
          userId,
        }),
      },
    );
    if (!response.ok) {
      await setMutationFlash({
        ok: false,
        message: await readTeamMutationError(
          response,
          "Unable to change partner portal access",
        ),
      });
      revalidatePath("/team");
      return;
    }

    const success = parsePartnerPortalAccessChangeSuccess(
      await response.json().catch(() => null),
      {
        active,
        actorId: principal.memberId,
        orgContactId,
        userId,
      },
    );
    if (!success) {
      await setMutationFlash({
        ok: false,
        message:
          "The portal-access service returned an unreadable success receipt, so no success is being claimed. Reload this partner before retrying.",
      });
      revalidatePath("/team");
      return;
    }

    await setMutationFlash({
      ok: true,
      message: success.data.active
        ? "Portal user activated. Existing sessions and login links were not restored. Password login is available only if this user already set a password."
        : `Portal user deactivated. ${success.data.sessionsRevoked} active session${success.data.sessionsRevoked === 1 ? "" : "s"} revoked and ${success.data.tokensInvalidated} unused login link${success.data.tokensInvalidated === 1 ? "" : "s"} invalidated.`,
    });
    revalidatePath("/team");
  } catch (error) {
    await setMutationFlash({
      ok: false,
      message: readTeamMutationException(
        error,
        "Unable to confirm the portal-access change",
      ),
    });
    revalidatePath("/team");
  }
}

export async function partnerPortalSaveRatesAction(formData: FormData) {
  const principal = await requireCurrentTeamPrincipal();
  const orgContactIdRaw = formData.get("orgContactId");
  const orgContactId =
    typeof orgContactIdRaw === "string" ? orgContactIdRaw.trim() : "";
  const expectedVersionRaw = formData.get("expectedVersion");
  const expectedVersion =
    typeof expectedVersionRaw === "string" ? expectedVersionRaw.trim() : "";
  const idempotencyKey = formData.get("idempotencyKey");
  const csvRaw = formData.get("ratesCsv");
  const csv = typeof csvRaw === "string" ? csvRaw : "";

  const validExpectedVersion =
    expectedVersion === "none" ||
    (!Number.isNaN(new Date(expectedVersion).getTime()) &&
      new Date(expectedVersion).toISOString() === expectedVersion);
  if (
    !isUuid(orgContactId) ||
    !validExpectedVersion ||
    !isValidTeamIdempotencyKey(idempotencyKey)
  ) {
    await setMutationFlash({
      ok: false,
      message:
        "This partner-rate request is incomplete or expired. Reload the partner workspace and try again.",
    });
    revalidatePath("/team");
    return;
  }

  const parsed = parsePartnerRateCsv(csv);
  if (!parsed.ok) {
    await setMutationFlash({
      ok: false,
      message: parsed.message,
    });
    revalidatePath("/team");
    return;
  }

  const feedback = await resolveTeamMutationFeedback(
    callAdminApiAs(principal, "/api/admin/partners/rates", {
      method: "POST",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "If-Match": expectedVersion,
      },
      body: JSON.stringify({
        orgContactId,
        currency: "USD",
        items: parsed.items,
        confirmation: `SAVE ${parsed.items.length} PARTNER RATES`,
      }),
    }),
    {
      success: "Partner rates saved.",
      failure: "Unable to save partner rates",
      requireReceipt: true,
    },
  );
  await setMutationFlash(feedback);
  revalidatePath("/team");
}
