"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
  type TeamRequestPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  readTeamMutationError,
  readTeamMutationException,
  readTeamMutationSuccess,
} from "../lib/mutation-feedback";

const PARTNER_ADMIN_PATH = "/team/partners";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,199}$/u;
const PARTNER_ROLE_KEYS = new Set([
  "administrator",
  "operations",
  "billing_approver",
  "viewer",
]);
const VERIFICATION_METHODS = new Set([
  "dns_txt",
  "email_challenge",
  "manual_document",
]);

function value(formData: FormData, key: string): string {
  const raw = formData.get(key);
  return typeof raw === "string" ? raw.normalize("NFKC").trim() : "";
}

function values(formData: FormData, key: string): string[] {
  return formData
    .getAll(key)
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.normalize("NFKC").trim())
    .filter(Boolean);
}

function isUuid(candidate: string): boolean {
  return UUID_PATTERN.test(candidate);
}

function isExactVersion(candidate: string): boolean {
  if (!candidate) return false;
  const date = new Date(candidate);
  return !Number.isNaN(date.getTime()) && date.toISOString() === candidate;
}

function isIdempotencyKey(candidate: string): boolean {
  return IDEMPOTENCY_KEY_PATTERN.test(candidate);
}

function isPositiveIntegerVersion(candidate: string): boolean {
  return /^[1-9][0-9]{0,9}$/u.test(candidate);
}

function isAgreementVersion(candidate: string): boolean {
  return /^(?:0|[1-9][0-9]{0,9})$/u.test(candidate);
}

function agreementInstant(raw: string, nullable = false): string | null {
  if (!raw && nullable) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(raw)) return null;
  const instant = `${raw}T00:00:00.000Z`;
  return new Date(instant).toISOString() === instant ? instant : null;
}

function boundedLines(raw: string): string[] | null {
  const entries = raw
    .split(/\r?\n/u)
    .map((entry) => entry.normalize("NFKC").trim())
    .filter(Boolean);
  return entries.length <= 40 && entries.every((entry) => entry.length <= 500)
    ? entries
    : null;
}

function boundedInteger(
  raw: string,
  minimum: number,
  maximum: number,
): number | null {
  if (!/^(?:0|[1-9][0-9]{0,5})$/u.test(raw)) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : null;
}

function parseUuidList(raw: string): string[] | null {
  const values = [
    ...new Set(
      raw
        .split(/[\s,]+/u)
        .map((candidate) => candidate.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  return values.length <= 250 && values.every(isUuid) ? values : null;
}

async function flash(ok: boolean, message: string): Promise<void> {
  const jar = await cookies();
  jar.set({
    name: ok ? "myst-flash" : "myst-flash-error",
    value: message,
    path: "/",
  });
}

async function reject(message: string): Promise<void> {
  await flash(false, message);
  revalidatePath(PARTNER_ADMIN_PATH);
}

async function performPartnerAdminMutation<T>(input: {
  principal: TeamRequestPrincipal;
  path: string;
  method: "PATCH" | "POST";
  expectedVersion: string;
  idempotencyKey: string;
  body: Record<string, unknown>;
  failureMessage: string;
  successMessage: string;
  validate(data: T): boolean;
}): Promise<void> {
  try {
    const response = await callAdminApiAs(input.principal, input.path, {
      method: input.method,
      headers: {
        "Idempotency-Key": input.idempotencyKey,
        "If-Match": input.expectedVersion,
      },
      body: JSON.stringify(input.body),
    });
    if (!response.ok) {
      await flash(
        false,
        await readTeamMutationError(response, input.failureMessage),
      );
      return;
    }
    const success = await readTeamMutationSuccess<T>(response);
    if (!success || !input.validate(success.data)) {
      await flash(
        false,
        `${input.failureMessage}. The service returned an unreadable success receipt, so no success is being claimed. Refresh before retrying.`,
      );
      return;
    }
    await flash(true, input.successMessage);
  } catch (error) {
    await flash(false, readTeamMutationException(error, input.failureMessage));
  } finally {
    revalidatePath(PARTNER_ADMIN_PATH);
  }
}

function commonMembershipInput(formData: FormData): {
  membershipId: string;
  accountId: string;
  expectedVersion: string;
  idempotencyKey: string;
} | null {
  const membershipId = value(formData, "membershipId").toLowerCase();
  const accountId = value(formData, "accountId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  return isUuid(membershipId) &&
    isUuid(accountId) &&
    isExactVersion(expectedVersion) &&
    isIdempotencyKey(idempotencyKey)
    ? { membershipId, accountId, expectedVersion, idempotencyKey }
    : null;
}

export async function partnerMembershipRoleAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const common = commonMembershipInput(formData);
  const roleKey = value(formData, "roleKey");
  const confirmation = value(formData, "confirmation");
  if (
    !hasTeamPermission(principal, "partners.memberships.manage") ||
    !common ||
    !PARTNER_ROLE_KEYS.has(roleKey) ||
    confirmation !== "UPDATE MEMBERSHIP ROLE"
  ) {
    return reject(
      "The role request is unauthorized, incomplete, stale, or not confirmed. Refresh Partner administration and try again.",
    );
  }
  return performPartnerAdminMutation<{
    membershipId?: unknown;
    partnerAccountId?: unknown;
    roleKey?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/memberships/${encodeURIComponent(common.membershipId)}/role`,
    method: "PATCH",
    expectedVersion: common.expectedVersion,
    idempotencyKey: common.idempotencyKey,
    body: {
      accountId: common.accountId,
      roleKey,
      confirmation,
    },
    failureMessage: "Unable to update the partner membership role",
    successMessage:
      "Membership role updated. Existing company and security boundaries remain in force.",
    validate: (data) =>
      data.membershipId === common.membershipId &&
      data.partnerAccountId === common.accountId &&
      data.roleKey === roleKey,
  });
}

export async function partnerAccountSchedulingPolicyAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const accountId = value(formData, "accountId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  const minimumNoticeMinutes = boundedInteger(
    value(formData, "minimumNoticeMinutes"),
    0,
    10_080,
  );
  const minimumCalendarLeadDays = boundedInteger(
    value(formData, "minimumCalendarLeadDays"),
    1,
    30,
  );
  const maximumBookingHorizonDays = boundedInteger(
    value(formData, "maximumBookingHorizonDays"),
    1,
    30,
  );
  const instantConfirmationEnabled =
    value(formData, "instantConfirmationEnabled") === "true";
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  if (
    !hasTeamPermission(principal, "partners.accounts.manage") ||
    !isUuid(accountId) ||
    !isPositiveIntegerVersion(expectedVersion) ||
    !isIdempotencyKey(idempotencyKey) ||
    minimumNoticeMinutes === null ||
    minimumCalendarLeadDays === null ||
    maximumBookingHorizonDays === null ||
    reason.length < 12 ||
    reason.length > 1_000 ||
    confirmation !== "UPDATE SCHEDULING POLICY"
  ) {
    return reject(
      "The scheduling-policy request is unauthorized, stale, outside its safe bounds, or not confirmed. Refresh Partner administration and try again.",
    );
  }

  return performPartnerAdminMutation<{
    partnerAccountId?: unknown;
    minimumNoticeMinutes?: unknown;
    minimumCalendarLeadDays?: unknown;
    maximumBookingHorizonDays?: unknown;
    instantConfirmationEnabled?: unknown;
    revision?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/accounts/${encodeURIComponent(accountId)}/scheduling-policy`,
    method: "PATCH",
    expectedVersion,
    idempotencyKey,
    body: {
      minimumNoticeMinutes,
      minimumCalendarLeadDays,
      maximumBookingHorizonDays,
      instantConfirmationEnabled,
      reason,
      confirmation,
    },
    failureMessage: "Unable to update the Partner scheduling policy",
    successMessage: instantConfirmationEnabled
      ? "Scheduling policy saved. Instant confirmation remains subject to every stricter Stonegate, service, price, approval, calendar, and capacity gate."
      : "Scheduling policy saved. This account now routes otherwise eligible work to review instead of instant confirmation.",
    validate: (data) =>
      data.partnerAccountId === accountId &&
      data.minimumNoticeMinutes === minimumNoticeMinutes &&
      data.minimumCalendarLeadDays === minimumCalendarLeadDays &&
      data.maximumBookingHorizonDays === maximumBookingHorizonDays &&
      data.instantConfirmationEnabled === instantConfirmationEnabled &&
      typeof data.revision === "number" &&
      data.revision > Number(expectedVersion),
  });
}

export async function partnerAccountCancellationPolicyAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const accountId = value(formData, "accountId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  const minimumNoticeMinutes = boundedInteger(
    value(formData, "minimumNoticeMinutes"),
    1_440,
    525_600,
  );
  const directCancellationEnabled =
    value(formData, "directCancellationEnabled") === "true";
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  if (
    !hasTeamPermission(principal, "partners.accounts.manage") ||
    !isUuid(accountId) ||
    !isPositiveIntegerVersion(expectedVersion) ||
    !isIdempotencyKey(idempotencyKey) ||
    minimumNoticeMinutes === null ||
    reason.length < 12 ||
    reason.length > 1_000 ||
    confirmation !== "UPDATE CANCELLATION POLICY"
  ) {
    return reject(
      "The cancellation-policy request is unauthorized, stale, outside its safe bounds, or not confirmed. Refresh Partner administration and try again.",
    );
  }

  return performPartnerAdminMutation<{
    partnerAccountId?: unknown;
    minimumNoticeMinutes?: unknown;
    directCancellationEnabled?: unknown;
    lateCancellationDisposition?: unknown;
    automaticFeeMinor?: unknown;
    revision?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/accounts/${encodeURIComponent(accountId)}/cancellation-policy`,
    method: "PATCH",
    expectedVersion,
    idempotencyKey,
    body: {
      minimumNoticeMinutes,
      directCancellationEnabled,
      reason,
      confirmation,
    },
    failureMessage: "Unable to update the Partner cancellation policy",
    successMessage: directCancellationEnabled
      ? "Cancellation policy saved. Confirmed jobs can cancel directly only before the effective cutoff; later requests remain scheduled for staff review."
      : "Cancellation policy saved. Confirmed-job cancellation requests now remain scheduled for staff review.",
    validate: (data) =>
      data.partnerAccountId === accountId &&
      data.minimumNoticeMinutes === minimumNoticeMinutes &&
      data.directCancellationEnabled === directCancellationEnabled &&
      data.lateCancellationDisposition === "staff_review" &&
      data.automaticFeeMinor === null &&
      typeof data.revision === "number" &&
      data.revision > Number(expectedVersion),
  });
}

export async function partnerAccountServiceAgreementAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const accountId = value(formData, "accountId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  const active = value(formData, "active") === "true";
  const agreementLabel = value(formData, "agreementLabel");
  const currency = value(formData, "currency").toUpperCase();
  const effectiveFrom = agreementInstant(value(formData, "effectiveFrom"));
  const rawEffectiveTo = value(formData, "effectiveTo");
  const effectiveTo = agreementInstant(rawEffectiveTo, true);
  const inclusions = boundedLines(value(formData, "inclusions"));
  const exclusions = boundedLines(value(formData, "exclusions"));
  const quoteRules = value(formData, "quoteRules") || null;
  const agreementDocumentId =
    value(formData, "agreementDocumentId").toLowerCase() || null;
  const serviceKeys = [...new Set(values(formData, "serviceKey"))];
  const services = serviceKeys.map((serviceKey) => ({
    serviceKey,
    pricingState: value(formData, `pricingState:${serviceKey}`),
    inclusions: boundedLines(
      value(formData, `serviceInclusions:${serviceKey}`),
    ),
    exclusions: boundedLines(
      value(formData, `serviceExclusions:${serviceKey}`),
    ),
    quoteRule: value(formData, `serviceQuoteRule:${serviceKey}`) || null,
  }));
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  const pricingStates = new Set([
    "contracted",
    "estimate",
    "quote_required",
    "standard_rate",
  ]);
  if (
    !hasTeamPermission(principal, "partners.commercial.manage") ||
    !isUuid(accountId) ||
    !isAgreementVersion(expectedVersion) ||
    !isIdempotencyKey(idempotencyKey) ||
    agreementLabel.length < 1 ||
    agreementLabel.length > 160 ||
    !/^[A-Z]{3}$/u.test(currency) ||
    !effectiveFrom ||
    (Boolean(rawEffectiveTo) && !effectiveTo) ||
    (effectiveTo !== null && effectiveTo <= effectiveFrom) ||
    inclusions === null ||
    exclusions === null ||
    (quoteRules !== null && quoteRules.length > 2_000) ||
    (agreementDocumentId !== null && !isUuid(agreementDocumentId)) ||
    services.length < 1 ||
    services.length > 100 ||
    services.some(
      (service) =>
        !/^[a-z][a-z0-9_-]{1,79}$/u.test(service.serviceKey) ||
        !pricingStates.has(service.pricingState) ||
        service.inclusions === null ||
        service.exclusions === null ||
        (service.quoteRule !== null && service.quoteRule.length > 1_000),
    ) ||
    reason.length < 12 ||
    reason.length > 1_000 ||
    confirmation !== "UPDATE SERVICE AGREEMENT"
  ) {
    return reject(
      "The service-agreement request is unauthorized, stale, outside its safe bounds, or not confirmed. Refresh Partner administration and try again.",
    );
  }

  return performPartnerAdminMutation<{
    partnerAccountId?: unknown;
    revision?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/accounts/${encodeURIComponent(accountId)}/service-agreement`,
    method: "PATCH",
    expectedVersion,
    idempotencyKey,
    body: {
      active,
      agreementLabel,
      currency,
      effectiveFrom,
      effectiveTo,
      inclusions,
      exclusions,
      quoteRules,
      agreementDocumentId,
      services: services.map((service) => ({
        ...service,
        inclusions: service.inclusions!,
        exclusions: service.exclusions!,
      })),
      reason,
      confirmation,
    },
    failureMessage: "Unable to update the Partner service agreement",
    successMessage:
      "Service agreement updated. Booking entitlement and currency will now fail closed to this effective account policy.",
    validate: (data) =>
      data.partnerAccountId === accountId &&
      typeof data.revision === "number" &&
      Number.isSafeInteger(data.revision) &&
      data.revision > 0,
  });
}

export async function partnerCancellationRequestDecisionAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const requestId = value(formData, "requestId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  const decision = value(formData, "decision");
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  const partnerQuoteId = value(formData, "partnerQuoteId").toLowerCase();
  const expectedConfirmation =
    decision === "approved"
      ? "APPROVE CANCELLATION"
      : decision === "declined"
        ? "DECLINE CANCELLATION"
        : "";
  if (
    !hasTeamPermission(principal, "partners.cancellation_requests.decide") ||
    !isUuid(requestId) ||
    !isPositiveIntegerVersion(expectedVersion) ||
    !isIdempotencyKey(idempotencyKey) ||
    !expectedConfirmation ||
    (decision === "change_order_required"
      ? !isUuid(partnerQuoteId)
      : partnerQuoteId.length > 0) ||
    confirmation !== expectedConfirmation ||
    reason.length < 12 ||
    reason.length > 1_000
  ) {
    return reject(
      "The cancellation decision is unauthorized, stale, incomplete, or not confirmed. Refresh Cancellation reviews and try again.",
    );
  }

  return performPartnerAdminMutation<{
    requestId?: unknown;
    state?: unknown;
    publicStatus?: unknown;
    currentScheduleCanceled?: unknown;
    revision?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/cancellation-requests/${encodeURIComponent(requestId)}/decision`,
    method: "POST",
    expectedVersion,
    idempotencyKey,
    body: {
      decision,
      reason,
      confirmation,
      partnerQuoteId:
        decision === "change_order_required" ? partnerQuoteId : null,
    },
    failureMessage: "Unable to resolve the cancellation request",
    successMessage:
      decision === "approved"
        ? "Cancellation approved. The job was canceled atomically and the Partner was notified."
        : "Cancellation declined. The existing schedule remains in place and the Partner was notified.",
    validate: (data) =>
      data.requestId === requestId &&
      data.state === decision &&
      data.currentScheduleCanceled === (decision === "approved") &&
      typeof data.revision === "number" &&
      data.revision > Number(expectedVersion),
  });
}

export async function partnerBillingDisputeDecisionAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const requestId = value(formData, "requestId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  const decision = value(formData, "decision");
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  const expectedConfirmation =
    decision === "information_provided"
      ? "PROVIDE BILLING INFORMATION"
      : decision === "adjustment_required"
        ? "REQUIRE BILLING ADJUSTMENT"
        : decision === "refund_review"
          ? "SEND TO REFUND REVIEW"
          : decision === "declined"
            ? "DECLINE BILLING REQUEST"
            : "";
  if (
    !hasTeamPermission(principal, "partners.billing_disputes.decide") ||
    !isUuid(requestId) ||
    !isPositiveIntegerVersion(expectedVersion) ||
    !isIdempotencyKey(idempotencyKey) ||
    !expectedConfirmation ||
    confirmation !== expectedConfirmation ||
    reason.length < 12 ||
    reason.length > 2_000
  ) {
    return reject(
      "The billing-request decision is unauthorized, stale, incomplete, or not confirmed. Refresh Billing requests and try again.",
    );
  }

  return performPartnerAdminMutation<{
    requestId?: unknown;
    state?: unknown;
    revision?: unknown;
    monetaryMutationPerformed?: unknown;
    providerActionPerformed?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/billing-disputes/${encodeURIComponent(requestId)}/decision`,
    method: "POST",
    expectedVersion,
    idempotencyKey,
    body: { decision, reason, confirmation },
    failureMessage: "Unable to classify the billing request",
    successMessage:
      decision === "information_provided"
        ? "Billing information provided. No invoice or payment amount was changed."
        : decision === "adjustment_required"
          ? "Billing adjustment follow-up recorded. No invoice amount was changed automatically."
          : decision === "refund_review"
            ? "Request sent to refund review. No provider refund was initiated."
            : "Billing request declined without changing the invoice or payment.",
    validate: (data) =>
      data.requestId === requestId &&
      data.state === decision &&
      data.monetaryMutationPerformed === false &&
      data.providerActionPerformed === false &&
      typeof data.revision === "number" &&
      data.revision > Number(expectedVersion),
  });
}

export async function partnerJobChangeRequestDecisionAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const requestId = value(formData, "requestId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  const decision = value(formData, "decision");
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  const expectedConfirmation =
    decision === "approved"
      ? "APPROVE JOB CHANGE"
      : decision === "declined"
        ? "DECLINE JOB CHANGE"
        : decision === "change_order_required"
          ? "REQUIRE CHANGE ORDER"
          : "";
  if (
    !hasTeamPermission(principal, "partners.change_requests.decide") ||
    !isUuid(requestId) ||
    !isPositiveIntegerVersion(expectedVersion) ||
    !isIdempotencyKey(idempotencyKey) ||
    !expectedConfirmation ||
    confirmation !== expectedConfirmation ||
    reason.length < 12 ||
    reason.length > 1_000
  ) {
    return reject(
      "The job-change decision is unauthorized, stale, incomplete, or not confirmed. Refresh Job change requests and try again.",
    );
  }

  return performPartnerAdminMutation<{
    requestId?: unknown;
    state?: unknown;
    publicStatus?: unknown;
    bookingRevision?: unknown;
    appliedFields?: unknown;
    revision?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/change-requests/${encodeURIComponent(requestId)}/decision`,
    method: "POST",
    expectedVersion,
    idempotencyKey,
    body: { decision, reason, confirmation },
    failureMessage: "Unable to resolve the job change request",
    successMessage:
      decision === "approved"
        ? "Job change approved. Only the validated public scope fields were updated and the Partner was notified."
        : decision === "change_order_required"
          ? "The fixed-price Quote V2 was offered as the job change order. The Partner was notified; operational changes remain pending until Staff confirms them."
          : "Job change declined. The job remains unchanged and the Partner was notified.",
    validate: (data) =>
      data.requestId === requestId &&
      data.state === decision &&
      typeof data.bookingRevision === "number" &&
      data.bookingRevision > 0 &&
      Array.isArray(data.appliedFields) &&
      (decision === "approved" || data.appliedFields.length === 0) &&
      typeof data.revision === "number" &&
      data.revision > Number(expectedVersion),
  });
}

export async function partnerMembershipScopeAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const common = commonMembershipInput(formData);
  const accessLevel = value(formData, "accessLevel");
  const locationIds = parseUuidList(value(formData, "locationIds"));
  const costCenterIds = parseUuidList(value(formData, "costCenterIds"));
  const confirmation = value(formData, "confirmation");
  const validScope =
    locationIds !== null &&
    costCenterIds !== null &&
    ((accessLevel === "account" &&
      locationIds.length === 0 &&
      costCenterIds.length === 0) ||
      (accessLevel === "scoped" &&
        locationIds.length + costCenterIds.length > 0));
  if (
    !hasTeamPermission(principal, "partners.memberships.manage") ||
    !common ||
    !validScope ||
    confirmation !== "UPDATE MEMBERSHIP SCOPE"
  ) {
    return reject(
      "The scope request is unauthorized, incomplete, stale, or contains invalid account resource IDs. Refresh and try again.",
    );
  }
  return performPartnerAdminMutation<{
    membershipId?: unknown;
    partnerAccountId?: unknown;
    accessLevel?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/memberships/${encodeURIComponent(common.membershipId)}/scope`,
    method: "PATCH",
    expectedVersion: common.expectedVersion,
    idempotencyKey: common.idempotencyKey,
    body: {
      accountId: common.accountId,
      accessLevel,
      locationIds,
      costCenterIds,
      confirmation,
    },
    failureMessage: "Unable to update the partner membership scope",
    successMessage:
      accessLevel === "account"
        ? "Membership now has account-wide access."
        : "Membership scope updated to the selected account-owned locations and cost centers.",
    validate: (data) =>
      data.membershipId === common.membershipId &&
      data.partnerAccountId === common.accountId &&
      data.accessLevel === accessLevel,
  });
}

export async function partnerMembershipMigrationReviewAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const common = commonMembershipInput(formData);
  const decision = value(formData, "decision");
  const note = value(formData, "note");
  const ownerOverride = value(formData, "ownerOverride") === "true";
  const confirmation = value(formData, "confirmation");
  const expectedConfirmation =
    decision === "quarantine"
      ? "QUARANTINE MIGRATED MEMBERSHIP"
      : decision === "approve" && ownerOverride
        ? "APPROVE MIGRATED OWNER"
        : decision === "approve"
          ? "APPROVE MIGRATED MEMBERSHIP"
          : "";
  if (
    !hasTeamPermission(principal, "partners.memberships.migration.review") ||
    (ownerOverride &&
      !hasTeamPermission(principal, "partners.memberships.recover_admin")) ||
    !common ||
    !expectedConfirmation ||
    confirmation !== expectedConfirmation ||
    note.length < 12 ||
    note.length > 2_000
  ) {
    return reject(
      "The migration review is unauthorized, incomplete, stale, or not confirmed. Refresh and try again.",
    );
  }
  return performPartnerAdminMutation<{
    membershipId?: unknown;
    partnerAccountId?: unknown;
    migrationReviewStatus?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/memberships/${encodeURIComponent(common.membershipId)}/migration-review`,
    method: "PATCH",
    expectedVersion: common.expectedVersion,
    idempotencyKey: common.idempotencyKey,
    body: {
      accountId: common.accountId,
      decision,
      note,
      ownerOverride,
      confirmation,
    },
    failureMessage: "Unable to complete the migrated-membership review",
    successMessage:
      decision === "approve"
        ? "Migrated membership approved with an immutable staff review receipt."
        : "Migrated membership quarantined and account-bound sessions revoked.",
    validate: (data) =>
      data.membershipId === common.membershipId &&
      data.partnerAccountId === common.accountId &&
      data.migrationReviewStatus ===
        (decision === "approve" ? "approved" : "quarantined"),
  });
}

function parseAccountTarget(candidate: string): {
  accountId: string;
  version: string;
} | null {
  const separator = candidate.indexOf("|");
  if (separator < 0) return null;
  const accountId = candidate.slice(0, separator).trim().toLowerCase();
  const version = candidate.slice(separator + 1).trim();
  return isUuid(accountId) && isExactVersion(version)
    ? { accountId, version }
    : null;
}

export async function partnerAccountDomainCreateAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const mode = value(formData, "domainAction");
  const restoring = mode === "restore";
  const selectedAccount = restoring
    ? {
        accountId: value(formData, "accountId").toLowerCase(),
        version: value(formData, "expectedVersion"),
      }
    : parseAccountTarget(value(formData, "accountTarget"));
  const domain = value(formData, "domain").toLowerCase();
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  const idempotencyKey = value(formData, "idempotencyKey");
  const expectedConfirmation = restoring
    ? "RESTORE REVOKED DOMAIN"
    : "ADD COMPANY DOMAIN";
  if (
    !hasTeamPermission(principal, "partners.domains.manage") ||
    (restoring && !hasTeamPermission(principal, "partners.domains.override")) ||
    (mode !== "create" && mode !== "restore") ||
    !selectedAccount ||
    !isUuid(selectedAccount.accountId) ||
    !isExactVersion(selectedAccount.version) ||
    domain.length < 3 ||
    domain.length > 253 ||
    !isIdempotencyKey(idempotencyKey) ||
    confirmation !== expectedConfirmation ||
    (restoring && (reason.length < 12 || reason.length > 1_000))
  ) {
    return reject(
      "The domain request is unauthorized, incomplete, stale, or not confirmed. Refresh and try again.",
    );
  }
  return performPartnerAdminMutation<{
    domainId?: unknown;
    partnerAccountId?: unknown;
    normalizedDomain?: unknown;
    status?: unknown;
  }>({
    principal,
    path: "/api/admin/partner-management/v1/domains",
    method: "POST",
    expectedVersion: selectedAccount.version,
    idempotencyKey,
    body: {
      accountId: selectedAccount.accountId,
      domain,
      restoreRevoked: restoring,
      ...(restoring ? { reason } : {}),
      confirmation,
    },
    failureMessage: restoring
      ? "Unable to restore the company domain"
      : "Unable to add the company domain",
    successMessage: restoring
      ? "Company domain restored to pending review; it is not verified yet."
      : "Company domain added as pending. It cannot match join requests until verified.",
    validate: (data) =>
      typeof data.domainId === "string" &&
      data.partnerAccountId === selectedAccount.accountId &&
      data.status === "pending",
  });
}

function commonDomainInput(formData: FormData): {
  domainId: string;
  accountId: string;
  expectedVersion: string;
  idempotencyKey: string;
} | null {
  const domainId = value(formData, "domainId").toLowerCase();
  const accountId = value(formData, "accountId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  return isUuid(domainId) &&
    isUuid(accountId) &&
    isExactVersion(expectedVersion) &&
    isIdempotencyKey(idempotencyKey)
    ? { domainId, accountId, expectedVersion, idempotencyKey }
    : null;
}

export async function partnerAccountDomainVerifyAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const common = commonDomainInput(formData);
  const verificationMethod = value(formData, "verificationMethod");
  const verificationEvidence = value(formData, "verificationEvidence");
  const overrideConflictingVerification =
    value(formData, "overrideConflictingVerification") === "true";
  const overrideReason = value(formData, "overrideReason");
  const confirmation = value(formData, "confirmation");
  const expectedConfirmation = overrideConflictingVerification
    ? "TRANSFER VERIFIED DOMAIN"
    : "VERIFY COMPANY DOMAIN";
  if (
    !hasTeamPermission(principal, "partners.domains.verify") ||
    (overrideConflictingVerification &&
      !hasTeamPermission(principal, "partners.domains.override")) ||
    !common ||
    !VERIFICATION_METHODS.has(verificationMethod) ||
    verificationEvidence.length < 8 ||
    verificationEvidence.length > 2_000 ||
    confirmation !== expectedConfirmation ||
    (overrideConflictingVerification &&
      (overrideReason.length < 12 || overrideReason.length > 1_000))
  ) {
    return reject(
      "The verification request is unauthorized, incomplete, stale, or not confirmed. Refresh and try again.",
    );
  }
  return performPartnerAdminMutation<{
    domainId?: unknown;
    partnerAccountId?: unknown;
    status?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/domains/${encodeURIComponent(common.domainId)}/verify`,
    method: "PATCH",
    expectedVersion: common.expectedVersion,
    idempotencyKey: common.idempotencyKey,
    body: {
      accountId: common.accountId,
      verificationMethod,
      verificationEvidence,
      overrideConflictingVerification,
      ...(overrideConflictingVerification ? { overrideReason } : {}),
      confirmation,
    },
    failureMessage: overrideConflictingVerification
      ? "Unable to transfer and verify the company domain"
      : "Unable to verify the company domain",
    successMessage: overrideConflictingVerification
      ? "Verified domain authority transferred to this company; conflicting verified records were revoked."
      : "Company domain verified and eligible for verified-domain company matching.",
    validate: (data) =>
      data.domainId === common.domainId &&
      data.partnerAccountId === common.accountId &&
      data.status === "verified",
  });
}

export async function partnerAccountDomainRevokeAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const common = commonDomainInput(formData);
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  if (
    !hasTeamPermission(principal, "partners.domains.revoke") ||
    !common ||
    reason.length < 12 ||
    reason.length > 1_000 ||
    confirmation !== "REVOKE COMPANY DOMAIN"
  ) {
    return reject(
      "The domain revocation is unauthorized, incomplete, stale, or not confirmed. Refresh and try again.",
    );
  }
  return performPartnerAdminMutation<{
    domainId?: unknown;
    partnerAccountId?: unknown;
    status?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/domains/${encodeURIComponent(common.domainId)}/revoke`,
    method: "PATCH",
    expectedVersion: common.expectedVersion,
    idempotencyKey: common.idempotencyKey,
    body: {
      accountId: common.accountId,
      reason,
      confirmation,
    },
    failureMessage: "Unable to revoke the company domain",
    successMessage:
      "Company domain revoked. It can no longer authorize verified-domain company matching.",
    validate: (data) =>
      data.domainId === common.domainId &&
      data.partnerAccountId === common.accountId &&
      data.status === "revoked",
  });
}

export async function partnerSecuritySessionRevokeAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const sessionId = value(formData, "sessionId").toLowerCase();
  const partnerUserId = value(formData, "partnerUserId").toLowerCase();
  const rawAccountId = value(formData, "accountId").toLowerCase();
  const rawMembershipId = value(formData, "membershipId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  const accountId = rawAccountId || null;
  const membershipId = rawMembershipId || null;
  if (
    !hasTeamPermission(principal, "partners.security.sessions.revoke") ||
    !isUuid(sessionId) ||
    !isUuid(partnerUserId) ||
    (accountId !== null && !isUuid(accountId)) ||
    (membershipId !== null && !isUuid(membershipId)) ||
    !isExactVersion(expectedVersion) ||
    !isIdempotencyKey(idempotencyKey) ||
    reason.length < 12 ||
    reason.length > 1_000 ||
    confirmation !== "REVOKE PARTNER SESSION"
  ) {
    return reject(
      "The session revocation is unauthorized, incomplete, stale, or not confirmed. Refresh and try again.",
    );
  }

  return performPartnerAdminMutation<{
    sessionId?: unknown;
    partnerUserId?: unknown;
    partnerAccountId?: unknown;
    membershipId?: unknown;
    status?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/security/sessions/${encodeURIComponent(sessionId)}/revoke`,
    method: "POST",
    expectedVersion,
    idempotencyKey,
    body: {
      partnerUserId,
      accountId,
      membershipId,
      reason,
      confirmation,
    },
    failureMessage: "Unable to revoke the partner session",
    successMessage:
      "Partner session revoked. The person and company membership remain unchanged.",
    validate: (data) =>
      data.sessionId === sessionId &&
      data.partnerUserId === partnerUserId &&
      data.partnerAccountId === accountId &&
      data.membershipId === membershipId &&
      data.status === "revoked",
  });
}

function commonIdentitySecurityInput(formData: FormData): {
  partnerUserId: string;
  expectedVersion: string;
  membershipSnapshot: string;
  idempotencyKey: string;
  reason: string;
  confirmation: string;
} | null {
  const partnerUserId = value(formData, "partnerUserId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const membershipSnapshot = value(
    formData,
    "membershipSnapshot",
  ).toLowerCase();
  const idempotencyKey = value(formData, "idempotencyKey");
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  return isUuid(partnerUserId) &&
    isExactVersion(expectedVersion) &&
    /^[0-9a-f]{64}$/u.test(membershipSnapshot) &&
    isIdempotencyKey(idempotencyKey) &&
    reason.length >= 20 &&
    reason.length <= 1_000 &&
    confirmation.length >= 1 &&
    confirmation.length <= 320
    ? {
        partnerUserId,
        expectedVersion,
        membershipSnapshot,
        idempotencyKey,
        reason,
        confirmation,
      }
    : null;
}

export async function partnerIdentityDisableAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const common = commonIdentitySecurityInput(formData);
  if (
    !hasTeamPermission(principal, "partners.identities.disable") ||
    !common ||
    !common.confirmation.startsWith("DISABLE ")
  ) {
    return reject(
      "The global identity disable is unauthorized, incomplete, stale, or not exactly confirmed. Refresh and review every affected company again.",
    );
  }
  return performPartnerAdminMutation<{
    partnerUserId?: unknown;
    status?: unknown;
    active?: unknown;
    membershipsChanged?: unknown;
    recordsPreserved?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/security/identities/${encodeURIComponent(common.partnerUserId)}/disable`,
    method: "POST",
    expectedVersion: common.expectedVersion,
    idempotencyKey: common.idempotencyKey,
    body: {
      membershipSnapshot: common.membershipSnapshot,
      reason: common.reason,
      confirmation: common.confirmation,
    },
    failureMessage: "Unable to disable the global partner identity",
    successMessage:
      "Partner identity disabled across every company. Sessions and pending credentials were revoked; memberships and business records were preserved.",
    validate: (data) =>
      data.partnerUserId === common.partnerUserId &&
      data.status === "disabled" &&
      data.active === false &&
      data.membershipsChanged === false &&
      data.recordsPreserved === true,
  });
}

export async function partnerMfaResetAction(formData: FormData): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const common = commonIdentitySecurityInput(formData);
  if (
    !hasTeamPermission(principal, "partners.security.mfa.reset") ||
    !common ||
    !common.confirmation.startsWith("RESET ") ||
    !common.confirmation.endsWith(" MFA")
  ) {
    return reject(
      "The partner MFA reset is unauthorized, incomplete, stale, or not exactly confirmed. Refresh the identity security review and try again.",
    );
  }
  return performPartnerAdminMutation<{
    partnerUserId?: unknown;
    status?: unknown;
    membershipsChanged?: unknown;
    recordsPreserved?: unknown;
    recoveryDelivery?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/security/identities/${encodeURIComponent(common.partnerUserId)}/mfa/reset`,
    method: "POST",
    expectedVersion: common.expectedVersion,
    idempotencyKey: common.idempotencyKey,
    body: {
      membershipSnapshot: common.membershipSnapshot,
      reason: common.reason,
      confirmation: common.confirmation,
    },
    failureMessage: "Unable to reset partner MFA",
    successMessage:
      "Partner MFA and sessions revoked. A purpose-bound re-enrollment email was queued; no company membership or business record changed.",
    validate: (data) =>
      data.partnerUserId === common.partnerUserId &&
      data.status === "re_enrollment_required" &&
      data.membershipsChanged === false &&
      data.recordsPreserved === true &&
      data.recoveryDelivery === "queued",
  });
}

export async function partnerAccountLifecycleAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const accountId = value(formData, "accountId").toLowerCase();
  const accountAction = value(formData, "accountAction");
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  const allowedAction =
    accountAction === "suspend" || accountAction === "reactivate"
      ? accountAction
      : null;
  const expectedConfirmation =
    allowedAction === "suspend"
      ? "SUSPEND PARTNER ACCOUNT"
      : allowedAction === "reactivate"
        ? "REACTIVATE PARTNER ACCOUNT"
        : "";
  if (
    !hasTeamPermission(principal, "partners.accounts.lifecycle") ||
    !isUuid(accountId) ||
    !allowedAction ||
    !isPositiveIntegerVersion(expectedVersion) ||
    !isIdempotencyKey(idempotencyKey) ||
    reason.length < 20 ||
    reason.length > 1_000 ||
    confirmation !== expectedConfirmation
  ) {
    return reject(
      "The account lifecycle request is unauthorized, incomplete, stale, or not exactly confirmed.",
    );
  }
  return performPartnerAdminMutation<{
    partnerAccountId?: unknown;
    status?: unknown;
    recordsPreserved?: unknown;
    version?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/accounts/${encodeURIComponent(accountId)}/${allowedAction}`,
    method: "POST",
    expectedVersion,
    idempotencyKey,
    body: { reason, confirmation },
    failureMessage: `Unable to ${allowedAction} partner account`,
    successMessage:
      allowedAction === "suspend"
        ? "Partner account suspended. Account-bound sessions and pending credentials were revoked; operational and financial records were preserved."
        : "Partner account reactivated. Previously revoked sessions remain revoked and users must sign in again.",
    validate: (data) =>
      data.partnerAccountId === accountId &&
      data.status === (allowedAction === "suspend" ? "suspended" : "active") &&
      data.recordsPreserved === true &&
      typeof data.version === "string",
  });
}

export async function partnerAccountCloseAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const accountId = value(formData, "accountId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  if (
    !hasTeamPermission(principal, "partners.accounts.close") ||
    !isUuid(accountId) ||
    !isPositiveIntegerVersion(expectedVersion) ||
    !isIdempotencyKey(idempotencyKey) ||
    reason.length < 20 ||
    reason.length > 1_000 ||
    confirmation !== "CLOSE PARTNER ACCOUNT"
  ) {
    return reject(
      "The account closure is unauthorized, incomplete, stale, or not exactly confirmed.",
    );
  }
  return performPartnerAdminMutation<{
    partnerAccountId?: unknown;
    status?: unknown;
    recordsPreserved?: unknown;
    version?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/accounts/${encodeURIComponent(accountId)}/close`,
    method: "POST",
    expectedVersion,
    idempotencyKey,
    body: { reason, confirmation },
    failureMessage: "Unable to close partner account",
    successMessage:
      "Partner account closed. Access credentials and pending invitations were revoked while all operational and financial records were preserved.",
    validate: (data) =>
      data.partnerAccountId === accountId &&
      data.status === "closed" &&
      data.recordsPreserved === true &&
      typeof data.version === "string",
  });
}

export async function partnerAdministratorRecoveryAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const accountId = value(formData, "accountId").toLowerCase();
  const membershipId = value(formData, "membershipId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  if (
    !hasTeamPermission(principal, "partners.memberships.recover_admin") ||
    !isUuid(accountId) ||
    !isUuid(membershipId) ||
    !isExactVersion(expectedVersion) ||
    !isIdempotencyKey(idempotencyKey) ||
    reason.length < 20 ||
    reason.length > 1_000 ||
    confirmation !== "RECOVER PARTNER ADMINISTRATOR"
  ) {
    return reject(
      "Administrator recovery is unauthorized, incomplete, stale, or not exactly confirmed.",
    );
  }
  return performPartnerAdminMutation<{
    partnerAccountId?: unknown;
    membershipId?: unknown;
    roleKey?: unknown;
    accessLevel?: unknown;
    version?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/accounts/${encodeURIComponent(accountId)}/recover-administrator`,
    method: "POST",
    expectedVersion,
    idempotencyKey,
    body: { membershipId, reason, confirmation },
    failureMessage: "Unable to recover partner Administrator",
    successMessage:
      "Administrator access recovered. The member is account-wide, MFA remains required, and all of their previous sessions were revoked.",
    validate: (data) =>
      data.partnerAccountId === accountId &&
      data.membershipId === membershipId &&
      data.roleKey === "administrator" &&
      data.accessLevel === "account" &&
      typeof data.version === "string",
  });
}

export async function partnerLocationAddressReviewDecisionAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const reviewId = value(formData, "reviewId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  const decision = value(formData, "decision");
  const note = value(formData, "note");
  const confirmation = value(formData, "confirmation");
  const expectedConfirmation =
    decision === "verified"
      ? "VERIFY LOCATION"
      : decision === "correction_required"
        ? "REQUEST ADDRESS CORRECTION"
        : decision === "dismissed"
          ? "DISMISS ADDRESS REVIEW"
          : "";
  const latitudeRaw = value(formData, "latitude");
  const longitudeRaw = value(formData, "longitude");
  const latitude = latitudeRaw ? Number(latitudeRaw) : undefined;
  const longitude = longitudeRaw ? Number(longitudeRaw) : undefined;
  const serviceAreaRaw = value(formData, "serviceAreaEligible");
  const serviceAreaEligible =
    serviceAreaRaw === "true"
      ? true
      : serviceAreaRaw === "false"
        ? false
        : undefined;
  if (
    !hasTeamPermission(principal, "partners.accounts.manage") ||
    !isUuid(reviewId) ||
    !isPositiveIntegerVersion(expectedVersion) ||
    !isIdempotencyKey(idempotencyKey) ||
    !expectedConfirmation ||
    confirmation !== expectedConfirmation ||
    note.length < 12 ||
    note.length > 1_000 ||
    (decision === "verified" &&
      (typeof latitude !== "number" ||
        !Number.isFinite(latitude) ||
        latitude < -90 ||
        latitude > 90 ||
        typeof longitude !== "number" ||
        !Number.isFinite(longitude) ||
        longitude < -180 ||
        longitude > 180 ||
        typeof serviceAreaEligible !== "boolean"))
  ) {
    return reject(
      "The address decision is incomplete, stale, or unauthorized. Refresh and verify the evidence before retrying.",
    );
  }

  const body: Record<string, unknown> = {
    decision,
    note,
    confirmation,
  };
  if (decision === "verified") {
    body["latitude"] = latitude;
    body["longitude"] = longitude;
    body["serviceAreaEligible"] = serviceAreaEligible;
  }
  return performPartnerAdminMutation<{
    reviewId?: unknown;
    state?: unknown;
    locationId?: unknown;
    version?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/location-reviews/${encodeURIComponent(reviewId)}/decision`,
    method: "POST",
    expectedVersion,
    idempotencyKey,
    body,
    failureMessage: "Unable to decide the Partner address review",
    successMessage:
      decision === "verified"
        ? "Location verified with Staff-recorded coordinates and service-area evidence."
        : decision === "correction_required"
          ? "Address correction requested; instant confirmation remains unavailable."
          : "Address review dismissed without changing the stored location.",
    validate: (data) =>
      data.reviewId === reviewId &&
      data.state === decision &&
      typeof data.locationId === "string" &&
      isUuid(data.locationId) &&
      typeof data.version === "string" &&
      isPositiveIntegerVersion(data.version),
  });
}

export async function partnerAccountMergePrepareAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const sourcePartnerAccountId = value(
    formData,
    "sourcePartnerAccountId",
  ).toLowerCase();
  const targetPartnerAccountId = value(
    formData,
    "targetPartnerAccountId",
  ).toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  if (
    !hasTeamPermission(principal, "partners.accounts.merge") ||
    !isUuid(sourcePartnerAccountId) ||
    !isUuid(targetPartnerAccountId) ||
    sourcePartnerAccountId === targetPartnerAccountId ||
    !isPositiveIntegerVersion(expectedVersion) ||
    !isIdempotencyKey(idempotencyKey) ||
    reason.length < 20 ||
    reason.length > 1_000 ||
    confirmation !== "PREPARE PARTNER ACCOUNT MERGE"
  ) {
    return reject(
      "The merge preflight is incomplete, stale, or unauthorized. Refresh and confirm both exact company records.",
    );
  }
  return performPartnerAdminMutation<{
    mergeCaseId?: unknown;
    sourcePartnerAccountId?: unknown;
    targetPartnerAccountId?: unknown;
    state?: unknown;
    version?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/accounts/${encodeURIComponent(sourcePartnerAccountId)}/merge`,
    method: "POST",
    expectedVersion,
    idempotencyKey,
    body: { targetPartnerAccountId, reason, confirmation },
    failureMessage: "Unable to prepare the Partner account merge",
    successMessage:
      "Merge preflight recorded. Review the Account merges queue; populated accounts remain contained until every binding is reconciled.",
    validate: (data) =>
      typeof data.mergeCaseId === "string" &&
      isUuid(data.mergeCaseId) &&
      data.sourcePartnerAccountId === sourcePartnerAccountId &&
      data.targetPartnerAccountId === targetPartnerAccountId &&
      (data.state === "ready" || data.state === "needs_reconciliation") &&
      typeof data.version === "string" &&
      isPositiveIntegerVersion(data.version),
  });
}

export async function partnerAccountMergeCompleteAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const mergeCaseId = value(formData, "mergeCaseId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  const resolutionNote = value(formData, "resolutionNote");
  const confirmation = value(formData, "confirmation");
  if (
    !hasTeamPermission(principal, "partners.accounts.merge") ||
    !isUuid(mergeCaseId) ||
    !isPositiveIntegerVersion(expectedVersion) ||
    !isIdempotencyKey(idempotencyKey) ||
    resolutionNote.length < 20 ||
    resolutionNote.length > 1_000 ||
    confirmation !== "COMPLETE PARTNER ACCOUNT MERGE"
  ) {
    return reject(
      "The merge completion is incomplete, stale, or unauthorized. Refresh the preflight before retrying.",
    );
  }
  return performPartnerAdminMutation<{
    mergeCaseId?: unknown;
    state?: unknown;
    sourceLifecycleStatus?: unknown;
    version?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/account-merges/${encodeURIComponent(mergeCaseId)}/complete`,
    method: "POST",
    expectedVersion,
    idempotencyKey,
    body: { resolutionNote, confirmation },
    failureMessage: "Unable to complete the Partner account merge",
    successMessage:
      "The empty source account is now merged and access-disabled. The destination remains active and all evidence is retained.",
    validate: (data) =>
      data.mergeCaseId === mergeCaseId &&
      data.state === "completed" &&
      data.sourceLifecycleStatus === "merged" &&
      typeof data.version === "string" &&
      isPositiveIntegerVersion(data.version),
  });
}

export async function partnerQuarantineResolveAction(
  formData: FormData,
): Promise<void> {
  const principal = await requireCurrentTeamPrincipal();
  const caseId = value(formData, "caseId").toLowerCase();
  const operationId = value(formData, "operationId").toLowerCase();
  const expectedVersion = value(formData, "expectedVersion");
  const idempotencyKey = value(formData, "idempotencyKey");
  const outcome = value(formData, "outcome");
  const evidenceType = value(formData, "evidenceType");
  const reviewedChannels = [...new Set(values(formData, "reviewedChannels"))];
  const providerOperationIds = [
    ...new Set(
      value(formData, "providerOperationIds")
        .split(/[\s,]+/u)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),
  ];
  const reason = value(formData, "reason");
  const confirmation = value(formData, "confirmation");
  const expectedConfirmation =
    outcome === "confirmed_sent"
      ? "RESOLVE AS CONFIRMED SENT"
      : outcome === "confirmed_not_sent"
        ? "RESOLVE AS CONFIRMED NOT SENT"
        : "";
  const allowedEvidence = new Set([
    "provider_delivery_record",
    "provider_no_matching_send",
    "provider_support_response",
  ]);
  if (
    !hasTeamPermission(principal, "partners.quarantine.release") ||
    !isUuid(caseId) ||
    !isUuid(operationId) ||
    !isPositiveIntegerVersion(expectedVersion) ||
    !isIdempotencyKey(idempotencyKey) ||
    !expectedConfirmation ||
    confirmation !== expectedConfirmation ||
    !allowedEvidence.has(evidenceType) ||
    reviewedChannels.length < 1 ||
    reviewedChannels.length > 2 ||
    reviewedChannels.some(
      (channel) => channel !== "email" && channel !== "sms",
    ) ||
    providerOperationIds.length > 10 ||
    providerOperationIds.some(
      (providerId) =>
        providerId.length < 1 ||
        providerId.length > 256 ||
        [...providerId].some((character) => {
          const codePoint = character.codePointAt(0) ?? 0;
          return codePoint <= 0x1f || codePoint === 0x7f;
        }),
    ) ||
    (outcome === "confirmed_sent" && providerOperationIds.length === 0) ||
    (outcome === "confirmed_not_sent" && providerOperationIds.length > 0) ||
    reason.length < 20 ||
    reason.length > 1_000
  ) {
    return reject(
      "The quarantine resolution is unauthorized, incomplete, stale, or lacks conclusive provider evidence. Refresh and try again.",
    );
  }

  return performPartnerAdminMutation<{
    caseId?: unknown;
    caseKind?: unknown;
    status?: unknown;
    resolution?: unknown;
    providerCalled?: unknown;
  }>({
    principal,
    path: `/api/admin/partner-management/v1/quarantine/${encodeURIComponent(caseId)}/resolve`,
    method: "POST",
    expectedVersion,
    idempotencyKey,
    body: {
      operationId,
      outcome,
      evidenceType,
      reviewedChannels,
      providerOperationIds,
      reason,
      confirmation,
    },
    failureMessage: "Unable to resolve the quarantine case",
    successMessage:
      "Provider evidence recorded and the duplicate-send guard released. No provider call was made.",
    validate: (data) =>
      data.caseId === caseId &&
      data.caseKind === "invite_delivery" &&
      data.status === "resolved" &&
      data.resolution === outcome &&
      data.providerCalled === false,
  });
}
