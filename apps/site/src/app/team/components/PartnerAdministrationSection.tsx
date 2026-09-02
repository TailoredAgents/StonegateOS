import { randomUUID } from "node:crypto";
import Link from "next/link";
import { SubmitButton } from "@/components/SubmitButton";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
  type TeamRequestPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import { partnerMembershipLifecycleAction } from "../actions";
import {
  partnerAccountCancellationPolicyAction,
  partnerAccountCloseAction,
  partnerAccountLifecycleAction,
  partnerAccountMergeCompleteAction,
  partnerAccountMergePrepareAction,
  partnerAdministratorRecoveryAction,
  partnerAccountSchedulingPolicyAction,
  partnerBillingDisputeDecisionAction,
  partnerCancellationRequestDecisionAction,
  partnerJobChangeRequestDecisionAction,
  partnerLocationAddressReviewDecisionAction,
  partnerIdentityDisableAction,
  partnerMfaResetAction,
  partnerQuarantineResolveAction,
  partnerSecuritySessionRevokeAction,
} from "../actions/partner-administration";
import { teamSurfaceHref } from "../surface-registry";
import { quoteWorkspaceHref } from "../quotes-workspace";
import { PartnersSection } from "./PartnersSection";
import {
  PartnerDomainCreatePanel,
  PartnerDomainMutationControls,
  PartnerMembershipMutationControls,
  type PartnerDomainAccountOption,
} from "./PartnerAdministrationMutations";
import { PartnerAccessApplicationsQueue } from "./PartnerAccessApplicationsQueue";
import {
  PartnerApprovalRuleManager,
  type PartnerApprovalRuleAdminItem,
  type PartnerApprovalRuleAdminOptions,
} from "./PartnerApprovalRuleManager";
import { PartnerPortalOperationsPanel } from "./PartnerPortalOperationsPanel";
import { PartnerServiceAgreementManager } from "./PartnerServiceAgreementManager";
import {
  TEAM_CARD_PADDED,
  TEAM_EMPTY_STATE,
  TEAM_INPUT_COMPACT,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass,
} from "./team-ui";

type AdministrationView =
  | "account-merges"
  | "accounts"
  | "operations"
  | "applications"
  | "billing-disputes"
  | "cancellation-requests"
  | "change-requests"
  | "commercial"
  | "domains"
  | "people"
  | "memberships"
  | "invitations"
  | "join-requests"
  | "location-reviews"
  | "quarantine"
  | "security"
  | "relationships";

type PartnerAdministrationFilters = {
  adminView?: string;
  adminCursor?: string;
  adminQuery?: string;
  adminStatus?: string;
  status?: string;
  ownerId?: string;
  type?: string;
  q?: string;
  cursor?: string;
  selectedId?: string;
  preview?: string;
  previewJobId?: string;
  outboundReturn?: string;
};

type CollectionPayload = {
  ok: true;
  resource: string;
  items: Array<Record<string, unknown>>;
  page: {
    hasMore: boolean;
    limit: number;
    nextCursor: string | null;
    returned: number;
  };
};

type PartnerIdentitySecurityImpact = {
  identity: {
    id: string;
    name: string;
    email: string;
    active: boolean;
    status: string;
    passwordSet: boolean;
    mfaRequired: boolean;
    mfaEnrolledAt: string | null;
    securityVersion: number;
    version: string;
  };
  memberships: Array<{
    id: string;
    partnerAccountId: string;
    accountName: string;
    accountStatus: string;
    portalAccessEnabled: boolean;
    roleKey: string;
    status: string;
    isDefault: boolean;
    version: string;
  }>;
  membershipCount: number;
  membershipSnapshot: string;
  allMembershipsEnumerated: boolean;
  activeSessionCount: number;
  enabledMfaMethodCount: number;
  unusedRecoveryCodeCount: number;
  canDisable: boolean;
  canResetMfa: boolean;
  mfaRecoveryPending: boolean;
};

type PartnerApprovalRuleAdminPayload = {
  rules: PartnerApprovalRuleAdminItem[];
  options: PartnerApprovalRuleAdminOptions;
  hasMore: boolean;
};

type PartnerQuoteStaffContext = {
  account: { id: string; name: string };
  targets: Array<{
    type: "location" | "booking";
    id: string;
    label: string;
    address: string;
    propertyId: string;
    contactId: string;
    contactName: string;
    contactEmail: string | null;
  }>;
  truncated: boolean;
};

const VIEW_CONFIG: ReadonlyArray<{
  id: AdministrationView;
  label: string;
  permission: string;
  description: string;
}> = [
  {
    id: "accounts",
    label: "Companies",
    permission: "partners.accounts.read",
    description: "Canonical partner companies and portal access state.",
  },
  {
    id: "account-merges",
    label: "Account merges",
    permission: "partners.accounts.read",
    description:
      "Owner-controlled duplicate-company preflight, reconciliation, and retained merge evidence.",
  },
  {
    id: "operations",
    label: "Portal health",
    permission: "partners.accounts.read",
    description:
      "Privacy-safe booking, availability, upload, and persona funnel health.",
  },
  {
    id: "applications",
    label: "Applicants",
    permission: "partners.applications.read",
    description: "Every partner access application, including closed states.",
  },
  {
    id: "billing-disputes",
    label: "Billing requests",
    permission: "partners.billing_disputes.read",
    description:
      "Classify Partner billing questions, disputes, and refund-review requests without changing money or invoking a provider.",
  },
  {
    id: "cancellation-requests",
    label: "Cancellation reviews",
    permission: "partners.cancellation_requests.read",
    description:
      "Durable Partner cancellation requests awaiting an immutable Staff decision.",
  },
  {
    id: "change-requests",
    label: "Job change requests",
    permission: "partners.change_requests.read",
    description:
      "Review bounded Partner job-change evidence without silently changing price, schedule, or proof requirements.",
  },
  {
    id: "domains",
    label: "Domains",
    permission: "partners.domains.read",
    description:
      "Verified company-domain authority, evidence state, and lifecycle controls.",
  },
  {
    id: "people",
    label: "People",
    permission: "partners.people.read",
    description: "Every registered partner identity and its security posture.",
  },
  {
    id: "memberships",
    label: "Memberships",
    permission: "partners.memberships.read",
    description: "Account-specific access, role, scope, and lifecycle state.",
  },
  {
    id: "invitations",
    label: "Invitations",
    permission: "partners.invitations.read",
    description: "Account invitations and safe delivery state.",
  },
  {
    id: "join-requests",
    label: "Join requests",
    permission: "partners.joins.read",
    description: "Requests from verified people to join an existing company.",
  },
  {
    id: "location-reviews",
    label: "Address reviews",
    permission: "partners.accounts.read",
    description:
      "Resolve uncertain address validation and probable duplicate-location evidence before scheduling.",
  },
  {
    id: "commercial",
    label: "Commercial",
    permission: "partners.commercial.read",
    description:
      "Account-scoped pricing, approval, invoice, balance, and payment-readiness posture.",
  },
  {
    id: "security",
    label: "Security",
    permission: "partners.security.read",
    description:
      "Partner sign-in sessions, account bindings, assurance, expiry, and focused containment.",
  },
  {
    id: "quarantine",
    label: "Quarantine",
    permission: "partners.quarantine.read",
    description:
      "Contained identity, migrated-access, and legacy provider-delivery anomalies with durable review history.",
  },
  {
    id: "relationships",
    label: "CRM relationships",
    permission: "partners.read",
    description: "Legacy referrals, touches, negotiated rates, and preview.",
  },
];

const VIEW_STATUS_OPTIONS: Readonly<
  Partial<
    Record<Exclude<AdministrationView, "relationships">, readonly string[]>
  >
> = {
  "account-merges": ["needs_reconciliation", "ready", "completed", "cancelled"],
  accounts: [
    "imported",
    "ready_for_first_touch",
    "attempting_contact",
    "conversation_active",
    "qualified_partner",
    "trial_partner",
    "active_partner",
    "portal_partner",
    "managed_partner",
    "dormant",
    "not_a_fit",
  ],
  applications: [
    "submitted",
    "under_review",
    "needs_information",
    "approved",
    "declined",
    "withdrawn",
  ],
  "billing-disputes": [
    "pending",
    "information_provided",
    "adjustment_required",
    "refund_review",
    "declined",
  ],
  "cancellation-requests": ["pending", "approved", "declined"],
  "change-requests": [
    "pending",
    "approved",
    "declined",
    "change_order_required",
  ],
  domains: ["pending", "verified", "revoked"],
  people: [
    "pending_activation",
    "active",
    "suspended",
    "disabled",
    "quarantined",
  ],
  memberships: ["invited", "active", "suspended", "removed"],
  invitations: ["pending", "accepted", "revoked", "expired"],
  "join-requests": [
    "submitted",
    "under_review",
    "needs_information",
    "approved",
    "declined",
    "withdrawn",
  ],
  "location-reviews": [
    "pending",
    "verified",
    "correction_required",
    "dismissed",
  ],
  commercial: ["ready", "attention_required", "unconfigured"],
  security: ["active", "expired", "revoked"],
  quarantine: ["contained", "reconciliation_required", "resolved"],
};

function clean(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
    value,
  );
}

function isExactInstant(value: string): boolean {
  if (!value) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}

function display(value: unknown, fallback = "—"): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return fallback;
}

function noticeDuration(value: unknown): string {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return "Unknown notice";
  }
  if (value % (24 * 60) === 0) {
    const days = value / (24 * 60);
    return `${days} day${days === 1 ? "" : "s"} notice`;
  }
  if (value % 60 === 0) {
    const hours = value / 60;
    return `${hours} hour${hours === 1 ? "" : "s"} notice`;
  }
  return `${value} minutes notice`;
}

function statusLabel(value: string): string {
  return value
    .replace(/[-_]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function dateLabel(value: unknown): string {
  const raw = display(value, "");
  if (!raw) return "—";
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleString();
}

function moneyLabel(cents: unknown, currency: unknown): string {
  if (typeof cents !== "number" || !Number.isSafeInteger(cents)) return "—";
  const currencyCode =
    typeof currency === "string" && /^[A-Z]{3}$/u.test(currency)
      ? currency
      : "USD";
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currencyCode,
    }).format(cents / 100);
  } catch {
    return `${currencyCode} ${(cents / 100).toFixed(2)}`;
  }
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim().length > 0,
      )
    : [];
}

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function proposedJobChangeRows(
  value: unknown,
): Array<{ label: string; value: string }> {
  const proposed = objectRecord(value);
  if (!proposed) return [];
  const rows: Array<{ label: string; value: string }> = [];
  const addText = (key: string, label: string): void => {
    if (!Object.hasOwn(proposed, key)) return;
    rows.push({
      label,
      value:
        proposed[key] === null
          ? "Clear this field"
          : display(proposed[key], "Invalid or unavailable"),
    });
  };
  addText("description", "Description");
  addText("crewInstructions", "Crew instructions");
  addText("accessDetails", "Access details");
  if (Object.hasOwn(proposed, "onSiteContact")) {
    const contact = objectRecord(proposed["onSiteContact"]);
    const contactSummary = contact
      ? [contact["name"], contact["phone"], contact["email"]]
          .map((entry) => display(entry, ""))
          .filter(Boolean)
          .join(" · ")
      : "Clear this field";
    rows.push({
      label: "On-site contact",
      value: contactSummary || "Invalid or unavailable",
    });
  }
  return rows;
}

function proposedJobChangeImpacts(value: unknown): string[] {
  const materiality = objectRecord(objectRecord(value)?.["materiality"]);
  if (!materiality) return [];
  return ["price", "schedule", "service", "quantity", "hazards", "proof"]
    .filter((key) => materiality[key] === true)
    .map(statusLabel);
}

function availableChangeOrderQuotes(value: unknown): Array<{
  id: string;
  label: string;
}> {
  if (!Array.isArray(value) || value.length > 20) return [];
  return value.flatMap((entry) => {
    const quote = objectRecord(entry);
    if (!quote) return [];
    const id = display(quote["id"], "").toLowerCase();
    const number = display(quote["number"], "");
    const version = quote["version"];
    const amountMinor = quote["amountMinor"];
    const currency = quote["currency"];
    if (
      !isUuid(id) ||
      !number ||
      !isSafeWholeNumber(version) ||
      version < 1 ||
      !isSafeWholeNumber(amountMinor) ||
      amountMinor < 1 ||
      typeof currency !== "string" ||
      !/^[A-Z]{3}$/u.test(currency)
    ) {
      return [];
    }
    return [
      {
        id,
        label: `${number} v${version} · ${moneyLabel(amountMinor, currency)}`,
      },
    ];
  });
}

function quarantineHistory(
  value: unknown,
): Array<{ event: string; at: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const event = display((entry as Record<string, unknown>)["event"], "");
    const at = display((entry as Record<string, unknown>)["at"], "");
    return event && at ? [{ event, at }] : [];
  });
}

function statusTone(value: unknown): string {
  const status = display(value, "").toLowerCase();
  if (
    [
      "active",
      "approved",
      "accepted",
      "active_partner",
      "ready",
      "resolved",
      "verified",
    ].includes(status)
  ) {
    return "bg-emerald-50 text-emerald-800";
  }
  if (
    [
      "submitted",
      "under_review",
      "needs_information",
      "pending",
      "invited",
      "attention_required",
      "reconciliation_required",
    ].includes(status)
  ) {
    return "bg-amber-50 text-amber-800";
  }
  if (
    [
      "declined",
      "contained",
      "disabled",
      "expired",
      "removed",
      "revoked",
      "inactive",
      "quarantined",
      "suspended",
    ].includes(status)
  ) {
    return "bg-rose-50 text-rose-800";
  }
  return "bg-slate-100 text-slate-700";
}

function partnerAdminHref(input: {
  view: AdministrationView;
  q?: string;
  status?: string;
  cursor?: string;
  selectedId?: string;
  selectedUserId?: string;
}): ReturnType<typeof teamSurfaceHref> {
  const query = new URLSearchParams({ p_admin: input.view });
  if (input.q) query.set("p_admin_q", input.q);
  if (input.status) query.set("p_admin_status", input.status);
  if (input.cursor) query.set("p_admin_cursor", input.cursor);
  const selectedId = input.selectedId ?? input.selectedUserId;
  if (selectedId) query.set("p_selected", selectedId);
  return teamSurfaceHref("partners", { query });
}

function rowPresentation(
  view: Exclude<AdministrationView, "operations" | "relationships">,
  item: Record<string, unknown>,
): {
  primary: string;
  secondary: string;
  status: string;
  details: Array<{ label: string; value: string }>;
} {
  switch (view) {
    case "account-merges": {
      const conflicts = objectRecord(item["conflictSummary"]);
      const bindingCount = conflicts ? Object.keys(conflicts).length : 0;
      return {
        primary: `${display(item["sourceAccountName"], "Unknown source")} → ${display(item["targetAccountName"], "Unknown destination")}`,
        secondary: display(item["reason"], "No merge reason recorded"),
        status: display(item["state"], "unknown"),
        details: [
          {
            label: "Blocking categories",
            value: String(bindingCount),
          },
          {
            label: "Requested by",
            value: display(item["requestedByName"], "Unknown Team member"),
          },
          { label: "Prepared", value: dateLabel(item["createdAt"]) },
          { label: "Completed", value: dateLabel(item["completedAt"]) },
        ],
      };
    }
    case "accounts":
      return {
        primary: display(item["name"], "Unnamed company"),
        secondary: display(item["domain"], display(item["website"])),
        status: display(item["portalLifecycleStatus"], "active"),
        details: [
          {
            label: "Relationship",
            value: statusLabel(display(item["status"], "unknown")),
          },
          {
            label: "Portal",
            value:
              item["portalAccessEnabled"] === true ? "Enabled" : "Limited/off",
          },
          {
            label: "Location",
            value:
              [display(item["city"], ""), display(item["state"], "")]
                .filter(Boolean)
                .join(", ") || "—",
          },
          {
            label: "Partner scheduling",
            value:
              item["schedulingPolicyConfigured"] === true
                ? `${display(item["schedulingMinimumCalendarLeadDays"], "1")}d lead · ${display(item["schedulingMaximumBookingHorizonDays"], "30")}d horizon · ${item["schedulingInstantConfirmationEnabled"] === true ? "instant eligible" : "review only"}`
                : "Policy missing · review only",
          },
          {
            label: "Cancellation",
            value:
              item["cancellationPolicyConfigured"] === true
                ? `${noticeDuration(item["cancellationMinimumNoticeMinutes"])} · ${item["cancellationDirectEnabled"] === true ? "direct before cutoff" : "staff review"} · no automatic fee`
                : "Policy missing · staff review",
          },
          { label: "Created", value: dateLabel(item["createdAt"]) },
        ],
      };
    case "applications":
      return {
        primary: display(item["name"], "Unnamed applicant"),
        secondary: `${display(item["email"])} · ${display(item["companyName"], "No company")}`,
        status: display(item["status"], "unknown"),
        details: [
          { label: "Persona", value: display(item["partnerType"]) },
          {
            label: "Email",
            value: item["emailVerifiedAt"] ? "Verified" : "Unverified",
          },
          { label: "Submitted", value: dateLabel(item["submittedAt"]) },
        ],
      };
    case "billing-disputes":
      return {
        primary: `Invoice ${display(item["invoiceNumber"], "Unknown invoice")}`,
        secondary: `${display(item["accountName"], "Unknown company")} · requested by ${display(item["requesterName"], display(item["requesterEmail"], "Unknown person"))}`,
        status: display(item["state"], "unknown"),
        details: [
          {
            label: "Category",
            value: statusLabel(display(item["category"], "other")),
          },
          { label: "Requested", value: dateLabel(item["createdAt"]) },
          {
            label: "Invoice state",
            value: statusLabel(display(item["invoiceStatus"], "unknown")),
          },
          { label: "Revision", value: display(item["revision"]) },
        ],
      };
    case "cancellation-requests":
      return {
        primary: `Job ${display(item["partnerBookingId"], "Unknown job")}`,
        secondary: `${display(item["accountName"], "Unknown company")} · requested by ${display(item["requesterName"], display(item["requesterEmail"], "Unknown person"))}`,
        status: display(item["state"], "unknown"),
        details: [
          { label: "Requested", value: dateLabel(item["createdAt"]) },
          {
            label: "Current job state",
            value: statusLabel(display(item["jobStatus"], "unknown")),
          },
          { label: "Revision", value: display(item["revision"]) },
        ],
      };
    case "change-requests":
      return {
        primary: `Job ${display(item["partnerBookingId"], "Unknown job")}`,
        secondary: `${display(item["accountName"], "Unknown company")} · requested by ${display(item["requesterName"], display(item["requesterEmail"], "Unknown person"))}`,
        status: display(item["state"], "unknown"),
        details: [
          { label: "Requested", value: dateLabel(item["createdAt"]) },
          {
            label: "Current job state",
            value: statusLabel(display(item["jobStatus"], "unknown")),
          },
          { label: "Revision", value: display(item["revision"]) },
        ],
      };
    case "domains":
      return {
        primary: display(item["normalizedDomain"], "Unknown domain"),
        secondary: display(item["accountName"], "Unknown company"),
        status: display(item["status"], "unknown"),
        details: [
          {
            label: "Verification",
            value: display(item["verificationMethod"], "Not verified"),
          },
          {
            label: "Evidence",
            value:
              item["verificationEvidencePresent"] === true
                ? "Recorded"
                : "Not recorded",
          },
          { label: "Updated", value: dateLabel(item["updatedAt"]) },
        ],
      };
    case "people":
      return {
        primary: display(item["name"], "Unnamed person"),
        secondary: display(item["email"]),
        status: display(
          item["identityStatus"],
          item["active"] === true ? "active" : "disabled",
        ),
        details: [
          {
            label: "MFA",
            value: item["mfaEnrolledAt"]
              ? "Enrolled"
              : item["mfaRequired"] === true
                ? "Required, not enrolled"
                : "Not required",
          },
          {
            label: "Password",
            value: item["passwordSetAt"]
              ? "Password set"
              : "Activation required",
          },
          { label: "Registered", value: dateLabel(item["createdAt"]) },
        ],
      };
    case "memberships":
      return {
        primary: display(item["personName"], "Unknown person"),
        secondary: `${display(item["personEmail"])} · ${display(item["accountName"], "Unknown company")}`,
        status: display(item["status"], "unknown"),
        details: [
          { label: "Role", value: display(item["roleKey"]) },
          { label: "Access", value: display(item["accessLevel"]) },
          {
            label: "Identity",
            value: display(
              item["identityStatus"],
              item["identityActive"] === true ? "active" : "globally disabled",
            ),
          },
          {
            label: "Migration review",
            value: display(item["migrationReviewStatus"], "not required"),
          },
        ],
      };
    case "invitations":
      return {
        primary: display(item["inviteeName"], "Unnamed invitee"),
        secondary: `${display(item["email"])} · ${display(item["accountName"], "Unknown company")}`,
        status: display(item["status"], "unknown"),
        details: [
          { label: "Role", value: display(item["roleKey"]) },
          { label: "Delivery", value: display(item["deliveryStatus"]) },
          { label: "Expires", value: dateLabel(item["expiresAt"]) },
        ],
      };
    case "join-requests":
      return {
        primary: display(item["personName"], "Unknown person"),
        secondary: `${display(item["personEmail"])} · ${display(item["accountName"], "Unknown company")}`,
        status: display(item["status"], "unknown"),
        details: [
          {
            label: "Requested role",
            value: display(item["requestedRoleKey"]),
          },
          { label: "Requested", value: dateLabel(item["requestedAt"]) },
          {
            label: "Resolution",
            value: item["resolvedMembershipId"]
              ? "Membership created"
              : "Not resolved",
          },
        ],
      };
    case "location-reviews":
      return {
        primary: display(item["siteName"], "Unnamed location"),
        secondary: `${display(item["accountName"], "Unknown company")} · ${[display(item["addressLine1"], ""), display(item["addressLine2"], ""), display(item["city"], ""), display(item["stateCode"], ""), display(item["postalCode"], "")].filter(Boolean).join(", ") || "Address unavailable"}`,
        status: display(item["state"], "unknown"),
        details: [
          {
            label: "Reason",
            value: statusLabel(display(item["reasonCode"], "unknown")),
          },
          {
            label: "Provider confidence",
            value:
              typeof item["providerConfidence"] === "number"
                ? `${item["providerConfidence"]}%`
                : "Unavailable",
          },
          {
            label: "Requested by",
            value: display(
              item["requesterName"],
              display(item["requesterEmail"]),
            ),
          },
          { label: "Requested", value: dateLabel(item["createdAt"]) },
        ],
      };
    case "commercial":
      return {
        primary: display(item["accountName"], "Unknown company"),
        secondary: `${display(item["domain"], "No verified domain")} · ${statusLabel(display(item["accountStatus"], "unknown"))}`,
        status: display(item["status"], "unconfigured"),
        details: [
          {
            label: "Operational pricing",
            value: `${display(item["currentRateCardCount"], "0")} current card · ${display(item["currentRateItemCount"], "0")} rates`,
          },
          {
            label: "Approvals",
            value: `${display(item["activeApprovalRuleCount"], "0")} active rules · ${display(item["pendingApprovalRequestCount"], "0")} pending`,
          },
          {
            label: "Invoices",
            value: `${display(item["openInvoiceCount"], "0")} open · ${display(item["overdueInvoiceCount"], "0")} overdue`,
          },
          {
            label: "Outstanding",
            value: moneyLabel(
              item["outstandingBalanceCents"],
              item["invoiceCurrency"],
            ),
          },
          {
            label: "Payment review",
            value: `${display(item["hostedPaymentGapCount"], "0")} hosted-link gaps · ${display(item["pendingPaymentAllocationCount"], "0")} pending allocations`,
          },
        ],
      };
    case "security":
      return {
        primary: display(item["personName"], "Unknown person"),
        secondary: `${display(item["personEmail"])} · ${display(item["accountName"], "No selected company")}`,
        status: display(item["status"], "unknown"),
        details: [
          {
            label: "Device",
            value: display(item["deviceName"], "Unnamed device"),
          },
          {
            label: "Assurance",
            value: `${statusLabel(display(item["authMethod"], "unknown"))} · ${display(item["assuranceLevel"], "aal1").toUpperCase()}`,
          },
          {
            label: "Company access",
            value: item["activeMembershipId"]
              ? `${display(item["roleKey"], "Unknown role")} · ${display(item["membershipStatus"], "unknown")}`
              : "No active membership binding",
          },
          { label: "Last active", value: dateLabel(item["lastSeenAt"]) },
          { label: "Expires", value: dateLabel(item["expiresAt"]) },
          { label: "Revoked", value: dateLabel(item["revokedAt"]) },
        ],
      };
    case "quarantine":
      return {
        primary: display(item["subjectName"], "Unknown partner"),
        secondary: `${display(item["title"], "Partner anomaly")} · ${display(item["subjectEmail"])}${item["accountName"] ? ` · ${display(item["accountName"])}` : ""}`,
        status: display(item["status"], "contained"),
        details: [
          { label: "Risk", value: display(item["riskLevel"], "high") },
          {
            label: "Case type",
            value: statusLabel(display(item["caseKind"], "unknown")),
          },
          { label: "Reason code", value: display(item["reasonCode"]) },
          { label: "Updated", value: dateLabel(item["updatedAt"]) },
          {
            label: "Resolution",
            value:
              item["resolutionAvailable"] === true
                ? "Owner evidence review available"
                : display(item["resolution"], "Read-only containment"),
          },
        ],
      };
  }
}

function isCollectionPayload(value: unknown): value is CollectionPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<CollectionPayload>;
  return (
    candidate.ok === true &&
    Array.isArray(candidate.items) &&
    Boolean(candidate.page) &&
    typeof candidate.page?.hasMore === "boolean" &&
    (typeof candidate.page?.nextCursor === "string" ||
      candidate.page?.nextCursor === null)
  );
}

function stringArray(
  value: unknown,
  maximum: number,
  predicate: (item: string) => boolean,
): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length > maximum ||
    value.some((item) => typeof item !== "string" || !predicate(item)) ||
    new Set(value).size !== value.length
  ) {
    return null;
  }
  return value as string[];
}

function parseApprovalRuleAdminPayload(
  value: unknown,
  accountId: string,
): PartnerApprovalRuleAdminPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  const rawItems = response["items"];
  const rawPage = response["page"];
  const rawOptions = response["options"];
  if (
    response["ok"] !== true ||
    response["partnerAccountId"] !== accountId ||
    !Array.isArray(rawItems) ||
    rawItems.length > 100 ||
    !rawPage ||
    typeof rawPage !== "object" ||
    Array.isArray(rawPage) ||
    !rawOptions ||
    typeof rawOptions !== "object" ||
    Array.isArray(rawOptions)
  ) {
    return null;
  }
  const page = rawPage as Record<string, unknown>;
  const optionsRecord = rawOptions as Record<string, unknown>;
  const rawServices = optionsRecord["services"];
  const rawLocations = optionsRecord["locations"];
  if (
    typeof page["hasMore"] !== "boolean" ||
    !Array.isArray(rawServices) ||
    rawServices.length > 200 ||
    !Array.isArray(rawLocations) ||
    rawLocations.length > 500 ||
    typeof optionsRecord["servicesTruncated"] !== "boolean" ||
    typeof optionsRecord["locationsTruncated"] !== "boolean"
  ) {
    return null;
  }
  const services = rawServices.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const key = clean(record["key"]);
    const label = clean(record["label"]);
    return /^[a-z][a-z0-9_-]{1,79}$/u.test(key) && label
      ? [{ key, label }]
      : [];
  });
  const locations = rawLocations.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const id = clean(record["id"]).toLowerCase();
    const label = clean(record["label"]);
    const address = clean(record["address"]);
    return isUuid(id) && label && address ? [{ id, label, address }] : [];
  });
  if (
    services.length !== rawServices.length ||
    locations.length !== rawLocations.length ||
    new Set(services.map((item) => item.key)).size !== services.length ||
    new Set(locations.map((item) => item.id)).size !== locations.length
  ) {
    return null;
  }

  const rules = rawItems.flatMap((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const record = raw as Record<string, unknown>;
    const rawConditions = record["conditions"];
    const rawCreator = record["creator"];
    if (
      !rawConditions ||
      typeof rawConditions !== "object" ||
      Array.isArray(rawConditions) ||
      !rawCreator ||
      typeof rawCreator !== "object" ||
      Array.isArray(rawCreator)
    ) {
      return [];
    }
    const conditions = rawConditions as Record<string, unknown>;
    if (
      Object.keys(conditions).some(
        (key) =>
          ![
            "serviceKeys",
            "locationIds",
            "minimumAmountMinor",
            "maximumAmountMinor",
            "requesterRoleKeys",
            "poNumberState",
            "costCenterState",
          ].includes(key),
      )
    ) {
      return [];
    }
    const serviceKeys =
      conditions["serviceKeys"] === undefined
        ? undefined
        : stringArray(conditions["serviceKeys"], 50, (item) =>
            /^[a-z][a-z0-9_-]{1,79}$/u.test(item),
          );
    const locationIds =
      conditions["locationIds"] === undefined
        ? undefined
        : stringArray(conditions["locationIds"], 100, isUuid);
    const requesterRoleKeys =
      conditions["requesterRoleKeys"] === undefined
        ? undefined
        : stringArray(conditions["requesterRoleKeys"], 4, (item) =>
            [
              "administrator",
              "operations",
              "billing_approver",
              "viewer",
            ].includes(item),
          );
    const minimum = conditions["minimumAmountMinor"];
    const maximum = conditions["maximumAmountMinor"];
    const po = conditions["poNumberState"];
    const costCenter = conditions["costCenterState"];
    const creator = rawCreator as Record<string, unknown>;
    const id = clean(record["id"]).toLowerCase();
    const name = clean(record["name"]);
    const revision = record["revision"];
    const creatorId = clean(creator["id"]).toLowerCase();
    const creatorType = creator["type"];
    const capabilities = stringArray(
      record["requiredApproverCapabilities"],
      1,
      (item) => item === "approvals.decide",
    );
    if (
      !isUuid(id) ||
      record["partnerAccountId"] !== accountId ||
      !name ||
      name.length > 160 ||
      serviceKeys === null ||
      locationIds === null ||
      requesterRoleKeys === null ||
      (minimum !== undefined && !isSafeWholeNumber(minimum)) ||
      (maximum !== undefined && !isSafeWholeNumber(maximum)) ||
      (minimum !== undefined &&
        maximum !== undefined &&
        Number(maximum) < Number(minimum)) ||
      (po !== undefined && po !== "present" && po !== "missing") ||
      (costCenter !== undefined &&
        costCenter !== "present" &&
        costCenter !== "missing") ||
      !capabilities ||
      capabilities.length !== 1 ||
      !isSafeWholeNumber(record["requiredDecisionCount"]) ||
      Number(record["requiredDecisionCount"]) < 1 ||
      Number(record["requiredDecisionCount"]) > 20 ||
      typeof record["active"] !== "boolean" ||
      !isSafeWholeNumber(revision) ||
      Number(revision) < 1 ||
      !isUuid(creatorId) ||
      (creatorType !== "team_member" && creatorType !== "partner_membership") ||
      (record["updatedByTeamMemberId"] !== null &&
        !isUuid(clean(record["updatedByTeamMemberId"]))) ||
      !isExactInstant(clean(record["createdAt"])) ||
      !isExactInstant(clean(record["updatedAt"])) ||
      clean(record["etag"]) !== '"' + String(revision) + '"'
    ) {
      return [];
    }
    return [
      {
        id,
        partnerAccountId: accountId,
        name,
        conditions: {
          ...(serviceKeys ? { serviceKeys } : {}),
          ...(locationIds ? { locationIds } : {}),
          ...(minimum !== undefined
            ? { minimumAmountMinor: Number(minimum) }
            : {}),
          ...(maximum !== undefined
            ? { maximumAmountMinor: Number(maximum) }
            : {}),
          ...(requesterRoleKeys ? { requesterRoleKeys } : {}),
          ...(po ? { poNumberState: po } : {}),
          ...(costCenter ? { costCenterState: costCenter } : {}),
        },
        requiredApproverCapabilities: ["approvals.decide"],
        requiredDecisionCount: Number(record["requiredDecisionCount"]),
        active: record["active"],
        revision: Number(revision),
        creator: { type: creatorType, id: creatorId },
        updatedByTeamMemberId:
          record["updatedByTeamMemberId"] === null
            ? null
            : clean(record["updatedByTeamMemberId"]),
        createdAt: clean(record["createdAt"]),
        updatedAt: clean(record["updatedAt"]),
        etag: clean(record["etag"]),
      } as PartnerApprovalRuleAdminItem,
    ];
  });
  if (
    rules.length !== rawItems.length ||
    new Set(rules.map((rule) => rule.id)).size !== rules.length
  ) {
    return null;
  }
  return {
    rules,
    options: {
      services,
      locations,
      servicesTruncated: optionsRecord["servicesTruncated"],
      locationsTruncated: optionsRecord["locationsTruncated"],
    },
    hasMore: page["hasMore"],
  };
}

function parsePartnerQuoteStaffContext(
  value: unknown,
  accountId: string,
): PartnerQuoteStaffContext | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const account = objectRecord(record["account"]);
  const rawTargets = record["targets"];
  if (
    record["ok"] !== true ||
    !account ||
    account["id"] !== accountId ||
    !clean(account["name"]) ||
    !Array.isArray(rawTargets) ||
    rawTargets.length > 100 ||
    typeof record["truncated"] !== "boolean"
  ) {
    return null;
  }
  const targets = rawTargets.flatMap((raw) => {
    const target = objectRecord(raw);
    if (!target) return [];
    const id = clean(target["id"]).toLowerCase();
    const propertyId = clean(target["propertyId"]).toLowerCase();
    const contactId = clean(target["contactId"]).toLowerCase();
    const label = clean(target["label"]);
    const address = clean(target["address"]);
    const contactName = clean(target["contactName"]);
    const contactEmail = target["contactEmail"];
    if (
      !["location", "booking"].includes(display(target["type"], "")) ||
      !isUuid(id) ||
      !isUuid(propertyId) ||
      !isUuid(contactId) ||
      !label ||
      !address ||
      !contactName ||
      (contactEmail !== null && typeof contactEmail !== "string")
    ) {
      return [];
    }
    return [
      {
        type: target["type"] as "location" | "booking",
        id,
        label,
        address,
        propertyId,
        contactId,
        contactName,
        contactEmail,
      },
    ];
  });
  if (
    targets.length !== rawTargets.length ||
    new Set(
      targets.map(
        (target) => `${target.id}:${target.propertyId}:${target.contactId}`,
      ),
    ).size !== targets.length
  ) {
    return null;
  }
  return {
    account: { id: accountId, name: clean(account["name"]) },
    targets,
    truncated: record["truncated"],
  };
}

function PartnerQuoteContextPanel({
  context,
  error,
}: {
  context: PartnerQuoteStaffContext | null;
  error: string;
}) {
  return (
    <section
      className={TEAM_CARD_PADDED}
      aria-labelledby="partner-quote-context-title"
    >
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--team-link)]">
            Canonical Quote V2
          </p>
          <h3
            id="partner-quote-context-title"
            className="mt-1 text-lg font-semibold text-[color:var(--team-text)]"
          >
            Create an account-bound quote
          </h3>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-[color:var(--team-text-muted)]">
            Choose the exact account-owned contact, CRM property, and Partner
            job or active location. The quote builder preserves this tenant and
            target binding through every revision and response.
          </p>
        </div>
      </div>
      {error ? (
        <p
          className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900"
          role="alert"
        >
          {error}
        </p>
      ) : !context ? (
        <p className="mt-4 text-sm text-[color:var(--team-text-muted)]">
          Quote context is unavailable. No unbound quote link is being offered.
        </p>
      ) : context.targets.length === 0 ? (
        <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-950">
          No safe quote target exists yet. Link an active Partner location or
          job to a CRM property and an account-owned CRM contact before creating
          a portal-visible quote.
        </p>
      ) : (
        <>
          <ul className="mt-4 grid gap-3 lg:grid-cols-2">
            {context.targets.map((target) => (
              <li
                key={`${target.id}:${target.contactId}`}
                className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4"
              >
                <p className="font-semibold text-[color:var(--team-text)]">
                  {target.label}
                </p>
                <p className="mt-1 break-words text-xs leading-5 text-[color:var(--team-text-muted)]">
                  {target.address}
                </p>
                <p className="mt-2 break-words text-sm text-[color:var(--team-text)]">
                  {target.contactName}
                  {target.contactEmail ? ` · ${target.contactEmail}` : ""}
                </p>
                <Link
                  className={`${teamButtonClass("primary", "sm")} mt-3`}
                  href={quoteWorkspaceHref("create", {
                    query: {
                      contactId: target.contactId,
                      propertyId: target.propertyId,
                      partnerAccountId: context.account.id,
                      partnerTargetType: target.type,
                      partnerTargetId: target.id,
                    },
                  })}
                >
                  Create quote for this {target.type}
                </Link>
              </li>
            ))}
          </ul>
          {context.truncated ? (
            <p className="mt-3 text-xs leading-5 text-amber-800" role="status">
              Only the first 100 safe target combinations are shown. Narrow the
              account’s CRM relationships before relying on this list.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function isSafeWholeNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parsePartnerIdentitySecurityImpact(
  value: unknown,
  expectedUserId: string,
): PartnerIdentitySecurityImpact | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (response["ok"] !== true) return null;
  const rawImpact = response["impact"];
  if (!rawImpact || typeof rawImpact !== "object" || Array.isArray(rawImpact)) {
    return null;
  }
  const impact = rawImpact as Record<string, unknown>;
  const rawIdentity = impact["identity"];
  const rawMemberships = impact["memberships"];
  if (
    !rawIdentity ||
    typeof rawIdentity !== "object" ||
    Array.isArray(rawIdentity) ||
    !Array.isArray(rawMemberships) ||
    rawMemberships.length > 250
  ) {
    return null;
  }
  const identity = rawIdentity as Record<string, unknown>;
  const id = clean(identity["id"]).toLowerCase();
  const name = clean(identity["name"]);
  const email = clean(identity["email"]);
  const status = clean(identity["status"]);
  const version = clean(identity["version"]);
  if (
    id !== expectedUserId ||
    !name ||
    !email ||
    !status ||
    !isExactInstant(version) ||
    typeof identity["active"] !== "boolean" ||
    typeof identity["passwordSet"] !== "boolean" ||
    typeof identity["mfaRequired"] !== "boolean" ||
    !isSafeWholeNumber(identity["securityVersion"])
  ) {
    return null;
  }
  const memberships = rawMemberships.flatMap((rawMembership) => {
    if (
      !rawMembership ||
      typeof rawMembership !== "object" ||
      Array.isArray(rawMembership)
    ) {
      return [];
    }
    const membership = rawMembership as Record<string, unknown>;
    const parsed = {
      id: clean(membership["id"]).toLowerCase(),
      partnerAccountId: clean(membership["partnerAccountId"]).toLowerCase(),
      accountName: clean(membership["accountName"]),
      accountStatus: clean(membership["accountStatus"]),
      portalAccessEnabled: membership["portalAccessEnabled"],
      roleKey: clean(membership["roleKey"]),
      status: clean(membership["status"]),
      isDefault: membership["isDefault"],
      version: clean(membership["version"]),
    };
    return isUuid(parsed.id) &&
      isUuid(parsed.partnerAccountId) &&
      parsed.accountName &&
      parsed.accountStatus &&
      parsed.roleKey &&
      parsed.status &&
      typeof parsed.portalAccessEnabled === "boolean" &&
      typeof parsed.isDefault === "boolean" &&
      isExactInstant(parsed.version)
      ? [
          {
            ...parsed,
            portalAccessEnabled: parsed.portalAccessEnabled,
            isDefault: parsed.isDefault,
          } as PartnerIdentitySecurityImpact["memberships"][number],
        ]
      : [];
  });
  const membershipIds = new Set(memberships.map((membership) => membership.id));
  const membershipCount = impact["membershipCount"];
  const membershipSnapshot = clean(impact["membershipSnapshot"]);
  if (
    memberships.length !== rawMemberships.length ||
    membershipIds.size !== memberships.length ||
    !isSafeWholeNumber(membershipCount) ||
    membershipCount < memberships.length ||
    !/^[0-9a-f]{64}$/u.test(membershipSnapshot) ||
    typeof impact["allMembershipsEnumerated"] !== "boolean" ||
    (impact["allMembershipsEnumerated"] === true &&
      membershipCount !== memberships.length) ||
    !isSafeWholeNumber(impact["activeSessionCount"]) ||
    !isSafeWholeNumber(impact["enabledMfaMethodCount"]) ||
    !isSafeWholeNumber(impact["unusedRecoveryCodeCount"]) ||
    typeof impact["canDisable"] !== "boolean" ||
    typeof impact["canResetMfa"] !== "boolean" ||
    typeof impact["mfaRecoveryPending"] !== "boolean"
  ) {
    return null;
  }
  const mfaEnrolledAt = identity["mfaEnrolledAt"];
  if (mfaEnrolledAt !== null && !isExactInstant(clean(mfaEnrolledAt))) {
    return null;
  }
  return {
    identity: {
      id,
      name,
      email,
      active: identity["active"],
      status,
      passwordSet: identity["passwordSet"],
      mfaRequired: identity["mfaRequired"],
      mfaEnrolledAt:
        mfaEnrolledAt === null ? null : clean(identity["mfaEnrolledAt"]),
      securityVersion: identity["securityVersion"],
      version,
    },
    memberships,
    membershipCount,
    membershipSnapshot,
    allMembershipsEnumerated: impact["allMembershipsEnumerated"],
    activeSessionCount: impact["activeSessionCount"],
    enabledMfaMethodCount: impact["enabledMfaMethodCount"],
    unusedRecoveryCodeCount: impact["unusedRecoveryCodeCount"],
    canDisable: impact["canDisable"],
    canResetMfa: impact["canResetMfa"],
    mfaRecoveryPending: impact["mfaRecoveryPending"],
  };
}

async function loadDomainAccountOptions(
  principal: TeamRequestPrincipal,
): Promise<{
  accounts: PartnerDomainAccountOption[];
  truncated: boolean;
  error: string;
}> {
  const accounts: PartnerDomainAccountOption[] = [];
  let cursor = "";

  try {
    for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
      const query = new URLSearchParams({ limit: "100" });
      if (cursor) query.set("cursor", cursor);
      const response = await callAdminApiAs(
        principal,
        `/api/admin/partner-management/v1/accounts?${query.toString()}`,
        { timeoutMs: 10_000 },
      );
      if (!response.ok) {
        return {
          accounts: [],
          truncated: false,
          error: `Company choices could not be loaded (HTTP ${response.status}).`,
        };
      }
      const candidate = (await response.json().catch(() => null)) as unknown;
      if (!isCollectionPayload(candidate)) {
        return {
          accounts: [],
          truncated: false,
          error: "Company choices returned an incomplete response.",
        };
      }
      for (const item of candidate.items) {
        const id = clean(item["id"]);
        const name = clean(item["name"]);
        const version = clean(item["updatedAt"]);
        if (id && name && version) accounts.push({ id, name, version });
      }
      if (!candidate.page.hasMore || !candidate.page.nextCursor) {
        return {
          accounts: accounts.sort((left, right) =>
            left.name.localeCompare(right.name),
          ),
          truncated: false,
          error: "",
        };
      }
      cursor = candidate.page.nextCursor;
    }
    return {
      accounts: accounts.sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
      truncated: true,
      error: "",
    };
  } catch {
    return {
      accounts: [],
      truncated: false,
      error: "Company choices could not be reached.",
    };
  }
}

export async function PartnerAdministrationSection({
  filters,
}: {
  filters?: PartnerAdministrationFilters;
}): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const availableViews = VIEW_CONFIG.filter((candidate) =>
    hasTeamPermission(principal, candidate.permission),
  );
  const requested = clean(filters?.adminView) as AdministrationView;
  const view =
    availableViews.find((candidate) => candidate.id === requested)?.id ??
    availableViews[0]?.id ??
    "accounts";
  const activeConfig =
    VIEW_CONFIG.find((candidate) => candidate.id === view) ?? VIEW_CONFIG[0]!;
  const canSuspendMemberships = hasTeamPermission(
    principal,
    "partners.memberships.suspend",
  );
  const membershipPermissions = {
    manage: hasTeamPermission(principal, "partners.memberships.manage"),
    reviewMigration: hasTeamPermission(
      principal,
      "partners.memberships.migration.review",
    ),
    recoverAdministrator: hasTeamPermission(
      principal,
      "partners.memberships.recover_admin",
    ),
  };
  const domainPermissions = {
    manage: hasTeamPermission(principal, "partners.domains.manage"),
    verify: hasTeamPermission(principal, "partners.domains.verify"),
    revoke: hasTeamPermission(principal, "partners.domains.revoke"),
    override: hasTeamPermission(principal, "partners.domains.override"),
  };
  const canRevokePartnerSessions = hasTeamPermission(
    principal,
    "partners.security.sessions.revoke",
  );
  const canDisablePartnerIdentities = hasTeamPermission(
    principal,
    "partners.identities.disable",
  );
  const canResetPartnerMfa = hasTeamPermission(
    principal,
    "partners.security.mfa.reset",
  );
  const canReleaseQuarantine = hasTeamPermission(
    principal,
    "partners.quarantine.release",
  );
  const canManageCommercial = hasTeamPermission(
    principal,
    "partners.commercial.manage",
  );
  const canCreateQuotes = hasTeamPermission(principal, "quotes.write");
  const canManageAccounts = hasTeamPermission(
    principal,
    "partners.accounts.manage",
  );
  const canMergePartnerAccounts = hasTeamPermission(
    principal,
    "partners.accounts.merge",
  );
  const canManageAccountLifecycle = hasTeamPermission(
    principal,
    "partners.accounts.lifecycle",
  );
  const canClosePartnerAccounts = hasTeamPermission(
    principal,
    "partners.accounts.close",
  );
  const canRecoverPartnerAdministrator = hasTeamPermission(
    principal,
    "partners.memberships.recover_admin",
  );
  const canDecideCancellationRequests = hasTeamPermission(
    principal,
    "partners.cancellation_requests.decide",
  );
  const canDecideBillingDisputes = hasTeamPermission(
    principal,
    "partners.billing_disputes.decide",
  );
  const canDecideJobChangeRequests = hasTeamPermission(
    principal,
    "partners.change_requests.decide",
  );

  if (view === "relationships") {
    return (
      <section className="space-y-6">
        <AdministrationHeader
          activeView={view}
          availableViews={availableViews}
        />
        <PartnersSection filters={filters} />
      </section>
    );
  }

  if (view === "operations") {
    const requestedRange = clean(filters?.adminStatus);
    const rangeDays =
      requestedRange === "1"
        ? 1
        : requestedRange === "14"
          ? 14
          : requestedRange === "30"
            ? 30
            : 7;
    return (
      <section className="space-y-6">
        <AdministrationHeader
          activeView={view}
          availableViews={availableViews}
        />
        <PartnerPortalOperationsPanel
          principal={principal}
          rangeDays={rangeDays}
        />
      </section>
    );
  }

  const q = clean(filters?.adminQuery);
  const requestedStatus = clean(filters?.adminStatus).toLowerCase();
  const statusOptions = VIEW_STATUS_OPTIONS[view] ?? [];
  const status = statusOptions.includes(requestedStatus) ? requestedStatus : "";
  const cursor = clean(filters?.adminCursor);
  const selectedIdentityIdCandidate = clean(filters?.selectedId).toLowerCase();
  const selectedIdentityId =
    view === "security" && isUuid(selectedIdentityIdCandidate)
      ? selectedIdentityIdCandidate
      : "";
  const selectedCommercialAccountId =
    view === "commercial" && isUuid(selectedIdentityIdCandidate)
      ? selectedIdentityIdCandidate
      : "";
  const apiQuery = new URLSearchParams({ limit: "50" });
  if (q) apiQuery.set("q", q);
  if (status) apiQuery.set("status", status);
  if (cursor) apiQuery.set("cursor", cursor);
  if (selectedIdentityId) apiQuery.set("userId", selectedIdentityId);

  let payload: CollectionPayload | null = null;
  let loadError = "";
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/${view}?${apiQuery.toString()}`,
      { timeoutMs: 10_000 },
    );
    if (response.ok) {
      const candidate = (await response.json().catch(() => null)) as unknown;
      if (isCollectionPayload(candidate)) payload = candidate;
      else loadError = "The directory returned an incomplete response.";
    } else {
      loadError = `The directory could not be loaded (HTTP ${response.status}).`;
    }
  } catch {
    loadError = "The directory could not be reached.";
  }

  const items = payload?.items ?? [];
  let approvalRulePayload: PartnerApprovalRuleAdminPayload | null = null;
  let approvalRuleLoadError = "";
  let quoteStaffContext: PartnerQuoteStaffContext | null = null;
  let quoteStaffContextError = "";
  if (selectedCommercialAccountId) {
    try {
      const response = await callAdminApiAs(
        principal,
        `/api/admin/partner-management/v1/accounts/${encodeURIComponent(selectedCommercialAccountId)}/approval-rules?includeInactive=true&limit=100`,
        { timeoutMs: 10_000 },
      );
      if (response.ok) {
        const candidate = (await response.json().catch(() => null)) as unknown;
        approvalRulePayload = parseApprovalRuleAdminPayload(
          candidate,
          selectedCommercialAccountId,
        );
        if (!approvalRulePayload) {
          approvalRuleLoadError =
            "The service returned an incomplete response. No approval-rule mutation is available.";
        }
      } else {
        approvalRuleLoadError = `The approval rules could not be loaded (HTTP ${response.status}). No mutation is available.`;
      }
    } catch {
      approvalRuleLoadError =
        "The approval-rule service could not be reached. No mutation is available.";
    }
    if (canCreateQuotes) {
      try {
        const response = await callAdminApiAs(
          principal,
          `/api/admin/partner-management/v1/accounts/${encodeURIComponent(selectedCommercialAccountId)}/quote-context`,
          { timeoutMs: 10_000 },
        );
        if (response.ok) {
          quoteStaffContext = parsePartnerQuoteStaffContext(
            await response.json().catch(() => null),
            selectedCommercialAccountId,
          );
          if (!quoteStaffContext) {
            quoteStaffContextError =
              "The quote-context service returned incomplete account bindings. No quote link is available.";
          }
        } else {
          quoteStaffContextError = `Partner quote context could not be loaded (HTTP ${response.status}). No quote link is available.`;
        }
      } catch {
        quoteStaffContextError =
          "Partner quote context could not be reached. No quote link is available.";
      }
    }
  }
  let securityImpact: PartnerIdentitySecurityImpact | null = null;
  let securityImpactError = "";
  if (selectedIdentityId && canDisablePartnerIdentities) {
    try {
      const response = await callAdminApiAs(
        principal,
        `/api/admin/partner-management/v1/security/identities/${encodeURIComponent(selectedIdentityId)}`,
        { timeoutMs: 10_000 },
      );
      if (response.ok) {
        const candidate = (await response.json().catch(() => null)) as unknown;
        securityImpact = parsePartnerIdentitySecurityImpact(
          candidate,
          selectedIdentityId,
        );
        if (!securityImpact) {
          securityImpactError =
            "The identity impact service returned an incomplete response. No owner action is available.";
        }
      } else {
        securityImpactError = `The identity impact could not be loaded (HTTP ${response.status}). No owner action is available.`;
      }
    } catch {
      securityImpactError =
        "The identity impact service could not be reached. No owner action is available.";
    }
  }
  let domainAccountOptions: PartnerDomainAccountOption[] = [];
  let domainAccountsTruncated = false;
  let domainAccountUnavailableReason = "";
  if (
    (view === "domains" && domainPermissions.manage) ||
    (view === "accounts" && canMergePartnerAccounts)
  ) {
    if (!hasTeamPermission(principal, "partners.accounts.read")) {
      domainAccountUnavailableReason =
        "Company directory read permission is required before this account operation is available.";
    } else {
      const accountOptions = await loadDomainAccountOptions(principal);
      domainAccountOptions = accountOptions.accounts;
      domainAccountsTruncated = accountOptions.truncated;
      domainAccountUnavailableReason = accountOptions.error;
      if (
        !domainAccountUnavailableReason &&
        domainAccountOptions.length === 0
      ) {
        domainAccountUnavailableReason =
          "No partner companies are available. Create or restore a company before continuing.";
      }
    }
  }
  const selectedCommercialAccountName = selectedCommercialAccountId
    ? display(
        items.find(
          (item) => display(item["id"], "") === selectedCommercialAccountId,
        )?.["accountName"],
        selectedCommercialAccountId,
      )
    : "";

  return (
    <section className="space-y-6">
      <AdministrationHeader activeView={view} availableViews={availableViews} />

      <div className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className={TEAM_SECTION_TITLE}>{activeConfig.label}</h2>
            <p className={TEAM_SECTION_SUBTITLE}>{activeConfig.description}</p>
          </div>
          <form
            action="/team/partners"
            method="get"
            className="grid w-full max-w-2xl gap-2 sm:grid-cols-[minmax(0,1fr)_12rem_auto]"
          >
            <input type="hidden" name="p_admin" value={view} />
            {selectedIdentityId || selectedCommercialAccountId ? (
              <input
                type="hidden"
                name="p_selected"
                value={selectedIdentityId || selectedCommercialAccountId}
              />
            ) : null}
            <label className="min-w-0 flex-1">
              <span className="sr-only">
                Search {activeConfig.label.toLowerCase()}
              </span>
              <input
                className={TEAM_INPUT_COMPACT}
                type="search"
                name="p_admin_q"
                defaultValue={q}
                maxLength={160}
                placeholder={`Search ${activeConfig.label.toLowerCase()}`}
              />
            </label>
            {statusOptions.length > 0 ? (
              <label>
                <span className="sr-only">
                  Filter {activeConfig.label.toLowerCase()} by status
                </span>
                <select
                  className={TEAM_INPUT_COMPACT}
                  name="p_admin_status"
                  defaultValue={status}
                >
                  <option value="">All statuses</option>
                  {statusOptions.map((option) => (
                    <option key={option} value={option}>
                      {statusLabel(option)}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <button
              className={teamButtonClass("secondary", "sm")}
              type="submit"
            >
              Search
            </button>
          </form>
        </div>
      </div>

      {view === "domains" && domainPermissions.manage ? (
        <PartnerDomainCreatePanel
          accounts={domainAccountOptions}
          accountsTruncated={domainAccountsTruncated}
          unavailableReason={domainAccountUnavailableReason}
        />
      ) : null}

      {view === "applications" ? (
        <PartnerAccessApplicationsQueue
          principal={principal}
          canReview={hasTeamPermission(
            principal,
            "partners.applications.review",
          )}
          canApprove={hasTeamPermission(
            principal,
            "partners.applications.approve",
          )}
          canDecline={hasTeamPermission(
            principal,
            "partners.applications.decline",
          )}
        />
      ) : null}

      {view === "security" && selectedIdentityId ? (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Link
              className={teamButtonClass("secondary", "sm")}
              href={partnerAdminHref({ view: "security", q, status })}
            >
              Close identity review
            </Link>
          </div>
          {securityImpactError ? (
            <div
              role="alert"
              className="rounded-2xl border border-rose-300 bg-rose-50 p-5 text-sm text-rose-950"
            >
              <h3 className="font-semibold">Owner action unavailable</h3>
              <p className="mt-1">{securityImpactError}</p>
            </div>
          ) : securityImpact ? (
            <PartnerIdentitySecurityOwnerPanel
              impact={securityImpact}
              canDisable={canDisablePartnerIdentities}
              canResetMfa={canResetPartnerMfa}
            />
          ) : null}
        </div>
      ) : null}

      {view === "commercial" && selectedCommercialAccountId ? (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Link
              className={teamButtonClass("secondary", "sm")}
              href={partnerAdminHref({ view: "commercial", q, status })}
            >
              Close approval-rule manager
            </Link>
          </div>
          <PartnerServiceAgreementManager
            principal={principal}
            accountId={selectedCommercialAccountId}
            accountName={selectedCommercialAccountName}
            canManage={canManageCommercial}
          />
          {canCreateQuotes ? (
            <PartnerQuoteContextPanel
              context={quoteStaffContext}
              error={quoteStaffContextError}
            />
          ) : null}
          <PartnerApprovalRuleManager
            accountId={selectedCommercialAccountId}
            accountName={selectedCommercialAccountName}
            rules={approvalRulePayload?.rules ?? []}
            options={
              approvalRulePayload?.options ?? {
                services: [],
                locations: [],
                servicesTruncated: false,
                locationsTruncated: false,
              }
            }
            canManage={canManageCommercial && Boolean(approvalRulePayload)}
            hasMore={approvalRulePayload?.hasMore ?? false}
            loadError={approvalRuleLoadError}
          />
        </div>
      ) : null}

      {loadError ? (
        <div
          role="alert"
          className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-900"
        >
          <h3 className="font-semibold">
            Partner administration is temporarily unavailable
          </h3>
          <p className="mt-1">
            {loadError} This is a load failure, not an empty directory.
          </p>
          <Link
            className={`${teamButtonClass("secondary", "sm")} mt-4`}
            href={partnerAdminHref({
              view,
              q,
              status,
              selectedUserId: selectedIdentityId,
            })}
          >
            Retry first page
          </Link>
        </div>
      ) : items.length === 0 ? (
        <div className={TEAM_EMPTY_STATE}>
          <h3 className="font-semibold text-[color:var(--team-text)]">
            No matching records
          </h3>
          <p className="mt-1">
            Try a different search or return to the complete directory.
          </p>
        </div>
      ) : (
        <ol
          className="space-y-3"
          aria-label={`${activeConfig.label} directory`}
        >
          {items.map((item) => {
            const row = rowPresentation(view, item);
            const membershipStatus = display(item["status"], "");
            const migrationReviewStatus = display(
              item["migrationReviewStatus"],
              "",
            );
            const membershipAction =
              view === "memberships" && membershipStatus === "active"
                ? "suspend"
                : view === "memberships" &&
                    membershipStatus === "suspended" &&
                    migrationReviewStatus !== "quarantined"
                  ? "reactivate"
                  : null;
            const accountLifecycleStatus = display(
              item["portalLifecycleStatus"],
              "active",
            );
            const accountLifecycleAction =
              view === "accounts" && accountLifecycleStatus === "active"
                ? "suspend"
                : view === "accounts" && accountLifecycleStatus === "suspended"
                  ? "reactivate"
                  : null;
            const administratorRecoveryEligible =
              view === "memberships" &&
              canRecoverPartnerAdministrator &&
              display(item["status"], "") === "active" &&
              display(item["identityStatus"], "") === "active" &&
              item["identityActive"] === true &&
              Boolean(item["passwordSetAt"]) &&
              Boolean(item["mfaEnrolledAt"]) &&
              display(item["migrationReviewStatus"], "not_required") !==
                "pending" &&
              display(item["migrationReviewStatus"], "not_required") !==
                "quarantined" &&
              Number(item["activeAdministratorCount"]) === 0 &&
              item["accountPortalAccessEnabled"] === true &&
              display(item["accountPortalLifecycleStatus"], "active") ===
                "active";
            return (
              <li key={display(item["id"])} className={TEAM_CARD_PADDED}>
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="truncate text-base font-semibold text-[color:var(--team-text)]">
                        {row.primary}
                      </h3>
                      <span
                        className={`rounded-full px-2.5 py-1 text-xs font-semibold ${statusTone(row.status)}`}
                      >
                        {row.status}
                      </span>
                    </div>
                    <p className="mt-1 break-words text-sm text-[color:var(--team-text-muted)]">
                      {row.secondary}
                    </p>
                  </div>
                  <dl className="grid gap-3 text-sm sm:grid-cols-3 lg:min-w-[32rem]">
                    {row.details.map((detail) => (
                      <div key={detail.label}>
                        <dt className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                          {detail.label}
                        </dt>
                        <dd className="mt-1 break-words text-[color:var(--team-text)]">
                          {detail.value}
                        </dd>
                      </div>
                    ))}
                  </dl>
                </div>
                {view === "accounts" && canManageAccounts ? (
                  <div className="mt-4 space-y-3">
                    <details className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4">
                      <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-semibold text-[color:var(--team-text)]">
                        Configure Partner scheduling limits
                      </summary>
                      <p className="mt-1 max-w-3xl text-xs leading-5 text-[color:var(--team-text-muted)]">
                        Account settings can require more notice, require more
                        local-calendar lead days, shorten the booking horizon,
                        or disable instant confirmation. They never expand
                        Stonegate hours or capacity and cannot override a
                        stricter global, service, pricing, approval, calendar,
                        routing, or capacity gate.
                      </p>
                      {item["schedulingPolicyConfigured"] !== true ? (
                        <div
                          role="alert"
                          className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900"
                        >
                          The persisted policy is missing. Instant confirmation
                          remains disabled. Apply migration 0147 and refresh; do
                          not bypass this control.
                        </div>
                      ) : (
                        <form
                          action={partnerAccountSchedulingPolicyAction}
                          className="mt-4 grid gap-4 lg:grid-cols-4"
                        >
                          <input
                            type="hidden"
                            name="accountId"
                            value={display(item["id"], "")}
                          />
                          <input
                            type="hidden"
                            name="expectedVersion"
                            value={display(
                              item["schedulingPolicyRevision"],
                              "",
                            )}
                          />
                          <input
                            type="hidden"
                            name="idempotencyKey"
                            value={`partner-scheduling-policy:${display(item["id"], "unknown")}:${randomUUID()}`}
                          />
                          <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                            Minimum notice (minutes)
                            <input
                              className={`${TEAM_INPUT_COMPACT} mt-1`}
                              name="minimumNoticeMinutes"
                              type="number"
                              inputMode="numeric"
                              min={0}
                              max={10_080}
                              step={1}
                              required
                              defaultValue={display(
                                item["schedulingMinimumNoticeMinutes"],
                                "0",
                              )}
                            />
                          </label>
                          <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                            Local-calendar lead (days)
                            <input
                              className={`${TEAM_INPUT_COMPACT} mt-1`}
                              name="minimumCalendarLeadDays"
                              type="number"
                              inputMode="numeric"
                              min={1}
                              max={30}
                              step={1}
                              required
                              defaultValue={display(
                                item["schedulingMinimumCalendarLeadDays"],
                                "1",
                              )}
                            />
                          </label>
                          <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                            Maximum horizon (days)
                            <input
                              className={`${TEAM_INPUT_COMPACT} mt-1`}
                              name="maximumBookingHorizonDays"
                              type="number"
                              inputMode="numeric"
                              min={1}
                              max={30}
                              step={1}
                              required
                              defaultValue={display(
                                item["schedulingMaximumBookingHorizonDays"],
                                "30",
                              )}
                            />
                          </label>
                          <label className="flex min-h-[44px] items-center gap-3 self-end rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-2 text-sm font-semibold text-[color:var(--team-text)]">
                            <input
                              name="instantConfirmationEnabled"
                              type="checkbox"
                              value="true"
                              defaultChecked={
                                item["schedulingInstantConfirmationEnabled"] ===
                                true
                              }
                              className="h-5 w-5"
                            />
                            Allow instant confirmation when every stricter gate
                            passes
                          </label>
                          <label className="text-xs font-semibold text-[color:var(--team-text-muted)] lg:col-span-2">
                            Operational reason
                            <textarea
                              className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24`}
                              name="reason"
                              minLength={12}
                              maxLength={1_000}
                              required
                              placeholder="Explain the account-specific scheduling requirement."
                            />
                          </label>
                          <label className="text-xs font-semibold text-[color:var(--team-text-muted)] lg:col-span-2">
                            Type UPDATE SCHEDULING POLICY
                            <input
                              className={`${TEAM_INPUT_COMPACT} mt-1`}
                              name="confirmation"
                              required
                              autoComplete="off"
                            />
                          </label>
                          <div className="lg:col-span-4">
                            <SubmitButton
                              className={teamButtonClass("primary", "sm")}
                              pendingLabel="Saving policy…"
                            >
                              Save scheduling policy
                            </SubmitButton>
                          </div>
                        </form>
                      )}
                    </details>
                    <details className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4">
                      <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-semibold text-[color:var(--team-text)]">
                        Configure Partner cancellation policy
                      </summary>
                      <p className="mt-1 max-w-3xl text-xs leading-5 text-[color:var(--team-text-muted)]">
                        Account policy can require more than Stonegate’s 24-hour
                        minimum or require staff review for every confirmed-job
                        cancellation. It cannot shorten a stricter Stonegate
                        cutoff. Late requests stay scheduled for staff review,
                        and this policy never applies a fee automatically.
                      </p>
                      {item["cancellationPolicyConfigured"] !== true ? (
                        <div
                          role="alert"
                          className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900"
                        >
                          The persisted policy is missing. Confirmed-job
                          cancellations remain in staff review. Apply migration
                          0148 and refresh; do not bypass this control.
                        </div>
                      ) : (
                        <form
                          action={partnerAccountCancellationPolicyAction}
                          className="mt-4 grid gap-4 lg:grid-cols-2"
                        >
                          <input
                            type="hidden"
                            name="accountId"
                            value={display(item["id"], "")}
                          />
                          <input
                            type="hidden"
                            name="expectedVersion"
                            value={display(
                              item["cancellationPolicyRevision"],
                              "",
                            )}
                          />
                          <input
                            type="hidden"
                            name="idempotencyKey"
                            value={`partner-cancellation-policy:${display(item["id"], "unknown")}:${randomUUID()}`}
                          />
                          <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                            Minimum notice (minutes)
                            <input
                              className={`${TEAM_INPUT_COMPACT} mt-1`}
                              name="minimumNoticeMinutes"
                              type="number"
                              inputMode="numeric"
                              min={1_440}
                              max={525_600}
                              step={1}
                              required
                              defaultValue={display(
                                item["cancellationMinimumNoticeMinutes"],
                                "1440",
                              )}
                              aria-describedby={`partner-cancellation-notice-${display(item["id"], "unknown")}`}
                            />
                            <span
                              id={`partner-cancellation-notice-${display(item["id"], "unknown")}`}
                              className="mt-1 block font-normal leading-5"
                            >
                              1,440 minutes is 24 hours. Maximum: 365 days.
                            </span>
                          </label>
                          <label className="flex min-h-[44px] items-center gap-3 self-start rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-3 py-2 text-sm font-semibold text-[color:var(--team-text)]">
                            <input
                              name="directCancellationEnabled"
                              type="checkbox"
                              value="true"
                              defaultChecked={
                                item["cancellationDirectEnabled"] === true
                              }
                              className="h-5 w-5"
                            />
                            Allow direct cancellation before the effective
                            cutoff
                          </label>
                          <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                            Operational reason
                            <textarea
                              className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24`}
                              name="reason"
                              minLength={12}
                              maxLength={1_000}
                              required
                              placeholder="Explain the account-specific cancellation requirement."
                            />
                          </label>
                          <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                            Type UPDATE CANCELLATION POLICY
                            <input
                              className={`${TEAM_INPUT_COMPACT} mt-1`}
                              name="confirmation"
                              required
                              autoComplete="off"
                            />
                          </label>
                          <div className="lg:col-span-2">
                            <SubmitButton
                              className={teamButtonClass("primary", "sm")}
                              pendingLabel="Saving policy…"
                            >
                              Save cancellation policy
                            </SubmitButton>
                          </div>
                        </form>
                      )}
                    </details>
                  </div>
                ) : null}
                {view === "accounts" &&
                accountLifecycleAction &&
                canManageAccountLifecycle ? (
                  <details className="mt-4 rounded-xl border border-amber-300 bg-amber-50 p-4">
                    <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-semibold text-amber-950">
                      {accountLifecycleAction === "suspend"
                        ? "Suspend Partner account access"
                        : "Reactivate Partner account access"}
                    </summary>
                    <p className="mt-2 text-xs leading-5 text-amber-950">
                      {accountLifecycleAction === "suspend"
                        ? "Suspension immediately revokes account-bound sessions and pending credentials. Jobs, proof, documents, invoices, and payments remain intact."
                        : "Reactivation restores the account's prior portal eligibility. Revoked sessions stay revoked, so every person must sign in again."}
                    </p>
                    <form
                      action={partnerAccountLifecycleAction}
                      className="mt-3 grid gap-3 lg:grid-cols-2"
                    >
                      <input
                        type="hidden"
                        name="accountId"
                        value={display(item["id"], "")}
                      />
                      <input
                        type="hidden"
                        name="accountAction"
                        value={accountLifecycleAction}
                      />
                      <input
                        type="hidden"
                        name="expectedVersion"
                        value={display(item["lifecycleVersion"], "")}
                      />
                      <input
                        type="hidden"
                        name="idempotencyKey"
                        value={`partner-account-${accountLifecycleAction}:${display(item["id"], "unknown")}:${randomUUID()}`}
                      />
                      <label className="text-xs font-semibold text-amber-950">
                        Durable reason
                        <textarea
                          className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                          name="reason"
                          minLength={20}
                          maxLength={1_000}
                          required
                        />
                      </label>
                      <label className="text-xs font-semibold text-amber-950">
                        Type {accountLifecycleAction.toUpperCase()} PARTNER
                        ACCOUNT
                        <input
                          className={`${TEAM_INPUT_COMPACT} mt-1`}
                          name="confirmation"
                          autoComplete="off"
                          required
                        />
                      </label>
                      <div className="lg:col-span-2">
                        <SubmitButton
                          className={teamButtonClass(
                            accountLifecycleAction === "suspend"
                              ? "danger"
                              : "primary",
                            "sm",
                          )}
                          pendingLabel={
                            accountLifecycleAction === "suspend"
                              ? "Suspending account…"
                              : "Reactivating account…"
                          }
                        >
                          {accountLifecycleAction === "suspend"
                            ? "Suspend account"
                            : "Reactivate account"}
                        </SubmitButton>
                      </div>
                    </form>
                  </details>
                ) : null}
                {view === "accounts" &&
                canClosePartnerAccounts &&
                (accountLifecycleStatus === "active" ||
                  accountLifecycleStatus === "suspended") ? (
                  <details className="mt-4 rounded-xl border-2 border-rose-300 bg-rose-50 p-4">
                    <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-bold text-rose-950">
                      Permanently close Partner account access
                    </summary>
                    <p className="mt-2 text-xs leading-5 text-rose-950">
                      Team Owner only. Closure revokes sessions, pending account
                      credentials, and pending invitations. It never deletes
                      jobs, proof, documents, invoices, payments, or audit
                      evidence.
                    </p>
                    <form
                      action={partnerAccountCloseAction}
                      className="mt-3 grid gap-3 lg:grid-cols-2"
                    >
                      <input
                        type="hidden"
                        name="accountId"
                        value={display(item["id"], "")}
                      />
                      <input
                        type="hidden"
                        name="expectedVersion"
                        value={display(item["lifecycleVersion"], "")}
                      />
                      <input
                        type="hidden"
                        name="idempotencyKey"
                        value={`partner-account-close:${display(item["id"], "unknown")}:${randomUUID()}`}
                      />
                      <label className="text-xs font-semibold text-rose-950">
                        Closure reason
                        <textarea
                          className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                          name="reason"
                          minLength={20}
                          maxLength={1_000}
                          required
                        />
                      </label>
                      <label className="text-xs font-semibold text-rose-950">
                        Type CLOSE PARTNER ACCOUNT
                        <input
                          className={`${TEAM_INPUT_COMPACT} mt-1`}
                          name="confirmation"
                          autoComplete="off"
                          required
                        />
                      </label>
                      <div className="lg:col-span-2">
                        <SubmitButton
                          className={teamButtonClass("danger", "sm")}
                          pendingLabel="Closing account…"
                        >
                          Close account access
                        </SubmitButton>
                      </div>
                    </form>
                  </details>
                ) : null}
                {view === "accounts" &&
                canMergePartnerAccounts &&
                (accountLifecycleStatus === "active" ||
                  accountLifecycleStatus === "suspended") ? (
                  <details className="mt-4 rounded-xl border-2 border-rose-300 bg-rose-50 p-4">
                    <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-bold text-rose-950">
                      Prepare duplicate-account merge
                    </summary>
                    <p className="mt-2 max-w-3xl text-xs leading-5 text-rose-950">
                      Team Owner only. This first creates a bounded preflight;
                      it never moves tenant data. Any membership, location, job,
                      proof, financial, or communication binding keeps the
                      source contained in reconciliation. Only an empty source
                      can be completed from the Account merges queue.
                    </p>
                    {domainAccountUnavailableReason ? (
                      <p role="alert" className="mt-3 text-sm text-rose-950">
                        {domainAccountUnavailableReason}
                      </p>
                    ) : (
                      <form
                        action={partnerAccountMergePrepareAction}
                        className="mt-3 grid gap-3 lg:grid-cols-2"
                      >
                        <input
                          type="hidden"
                          name="sourcePartnerAccountId"
                          value={display(item["id"], "")}
                        />
                        <input
                          type="hidden"
                          name="expectedVersion"
                          value={display(item["lifecycleVersion"], "")}
                        />
                        <input
                          type="hidden"
                          name="idempotencyKey"
                          value={`partner-account-merge-prepare:${display(item["id"], "unknown")}:${randomUUID()}`}
                        />
                        <label className="text-xs font-semibold text-rose-950">
                          Exact destination company
                          <select
                            className={`${TEAM_INPUT_COMPACT} mt-1`}
                            name="targetPartnerAccountId"
                            defaultValue=""
                            required
                          >
                            <option value="" disabled>
                              Select the retained company
                            </option>
                            {domainAccountOptions
                              .filter(
                                (account) =>
                                  account.id !== display(item["id"], ""),
                              )
                              .map((account) => (
                                <option key={account.id} value={account.id}>
                                  {account.name} · {account.id}
                                </option>
                              ))}
                          </select>
                          {domainAccountsTruncated ? (
                            <span className="mt-1 block font-normal">
                              The company list is truncated; use search to
                              narrow the directory before merging.
                            </span>
                          ) : null}
                        </label>
                        <label className="text-xs font-semibold text-rose-950">
                          Tenant-reconciliation reason
                          <textarea
                            className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                            name="reason"
                            minLength={20}
                            maxLength={1_000}
                            required
                          />
                        </label>
                        <label className="text-xs font-semibold text-rose-950 lg:col-span-2">
                          Type PREPARE PARTNER ACCOUNT MERGE
                          <input
                            className={`${TEAM_INPUT_COMPACT} mt-1`}
                            name="confirmation"
                            autoComplete="off"
                            required
                          />
                        </label>
                        <div className="lg:col-span-2">
                          <SubmitButton
                            className={teamButtonClass("danger", "sm")}
                            pendingLabel="Running binding preflight…"
                          >
                            Prepare merge preflight
                          </SubmitButton>
                        </div>
                      </form>
                    )}
                  </details>
                ) : null}
                {view === "account-merges" ? (
                  <div className="mt-4 space-y-4 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4">
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                        Tenant-binding preflight
                      </h4>
                      {Object.entries(
                        objectRecord(item["conflictSummary"]) ?? {},
                      ).length > 0 ? (
                        <ul className="mt-2 grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                          {Object.entries(
                            objectRecord(item["conflictSummary"]) ?? {},
                          ).map(([binding, count]) => (
                            <li
                              key={binding}
                              className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-amber-950"
                            >
                              <span className="font-semibold">
                                {statusLabel(binding)}
                              </span>{" "}
                              · {display(count, "?")}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-sm text-emerald-800">
                          No blocking tenant records were present at preflight.
                          Completion rechecks the live database under lock.
                        </p>
                      )}
                    </div>
                    {display(item["state"], "") === "ready" &&
                    canMergePartnerAccounts ? (
                      <form
                        action={partnerAccountMergeCompleteAction}
                        className="grid gap-3 rounded-xl border-2 border-rose-300 bg-rose-50 p-4 lg:grid-cols-2"
                      >
                        <input
                          type="hidden"
                          name="mergeCaseId"
                          value={display(item["id"], "")}
                        />
                        <input
                          type="hidden"
                          name="expectedVersion"
                          value={display(item["version"], "")}
                        />
                        <input
                          type="hidden"
                          name="idempotencyKey"
                          value={`partner-account-merge-complete:${display(item["id"], "unknown")}:${randomUUID()}`}
                        />
                        <label className="text-xs font-semibold text-rose-950">
                          Reconciliation completion evidence
                          <textarea
                            className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                            name="resolutionNote"
                            minLength={20}
                            maxLength={1_000}
                            required
                          />
                        </label>
                        <label className="text-xs font-semibold text-rose-950">
                          Type COMPLETE PARTNER ACCOUNT MERGE
                          <input
                            className={`${TEAM_INPUT_COMPACT} mt-1`}
                            name="confirmation"
                            autoComplete="off"
                            required
                          />
                        </label>
                        <div className="lg:col-span-2">
                          <SubmitButton
                            className={teamButtonClass("danger", "sm")}
                            pendingLabel="Rechecking and merging…"
                          >
                            Complete empty-account merge
                          </SubmitButton>
                        </div>
                      </form>
                    ) : display(item["state"], "") ===
                      "needs_reconciliation" ? (
                      <p className="text-xs leading-5 text-amber-950">
                        Completion is blocked. Reconcile the listed records
                        through their owning workflows, then rerun the source
                        account preflight. No automatic cross-tenant rewrite is
                        available.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {view === "location-reviews" ? (
                  <div className="mt-4 space-y-4 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4">
                    <div className="grid gap-4 lg:grid-cols-2">
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                          Entered address
                        </h4>
                        <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-3 font-sans text-sm text-[color:var(--team-text)]">
                          {JSON.stringify(item["enteredAddress"], null, 2)}
                        </pre>
                      </div>
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                          Provider suggestion
                        </h4>
                        <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-3 font-sans text-sm text-[color:var(--team-text)]">
                          {item["providerSuggestion"]
                            ? JSON.stringify(
                                item["providerSuggestion"],
                                null,
                                2,
                              )
                            : "No provider correction was returned."}
                        </pre>
                      </div>
                    </div>
                    {display(item["state"], "") === "pending" &&
                    canManageAccounts ? (
                      <div className="grid gap-4 xl:grid-cols-3">
                        {(
                          [
                            {
                              decision: "verified",
                              title: "Verify with Staff evidence",
                              confirmation: "VERIFY LOCATION",
                              button: "Verify location",
                              tone: "primary" as const,
                            },
                            {
                              decision: "correction_required",
                              title: "Request Partner correction",
                              confirmation: "REQUEST ADDRESS CORRECTION",
                              button: "Require correction",
                              tone: "secondary" as const,
                            },
                            {
                              decision: "dismissed",
                              title: "Dismiss review",
                              confirmation: "DISMISS ADDRESS REVIEW",
                              button: "Dismiss without change",
                              tone: "danger" as const,
                            },
                          ] as const
                        ).map((decision) => (
                          <form
                            key={decision.decision}
                            action={partnerLocationAddressReviewDecisionAction}
                            className="grid gap-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4"
                          >
                            <input
                              type="hidden"
                              name="reviewId"
                              value={display(item["id"], "")}
                            />
                            <input
                              type="hidden"
                              name="expectedVersion"
                              value={display(item["revision"], "")}
                            />
                            <input
                              type="hidden"
                              name="idempotencyKey"
                              value={`partner-location-review:${decision.decision}:${display(item["id"], "unknown")}:${randomUUID()}`}
                            />
                            <input
                              type="hidden"
                              name="decision"
                              value={decision.decision}
                            />
                            <h5 className="text-sm font-semibold text-[color:var(--team-text)]">
                              {decision.title}
                            </h5>
                            {decision.decision === "verified" ? (
                              <div className="grid gap-3 sm:grid-cols-2">
                                <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                                  Latitude
                                  <input
                                    className={`${TEAM_INPUT_COMPACT} mt-1`}
                                    name="latitude"
                                    type="number"
                                    min={-90}
                                    max={90}
                                    step="any"
                                    required
                                  />
                                </label>
                                <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                                  Longitude
                                  <input
                                    className={`${TEAM_INPUT_COMPACT} mt-1`}
                                    name="longitude"
                                    type="number"
                                    min={-180}
                                    max={180}
                                    step="any"
                                    required
                                  />
                                </label>
                                <label className="text-xs font-semibold text-[color:var(--team-text-muted)] sm:col-span-2">
                                  Service-area decision
                                  <select
                                    className={`${TEAM_INPUT_COMPACT} mt-1`}
                                    name="serviceAreaEligible"
                                    required
                                    defaultValue=""
                                  >
                                    <option value="" disabled>
                                      Choose verified result
                                    </option>
                                    <option value="true">Eligible</option>
                                    <option value="false">Outside area</option>
                                  </select>
                                </label>
                              </div>
                            ) : null}
                            <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                              Decision evidence
                              <textarea
                                className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                                name="note"
                                minLength={12}
                                maxLength={1_000}
                                required
                              />
                            </label>
                            <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                              Type {decision.confirmation}
                              <input
                                className={`${TEAM_INPUT_COMPACT} mt-1`}
                                name="confirmation"
                                autoComplete="off"
                                required
                              />
                            </label>
                            <SubmitButton
                              className={teamButtonClass(decision.tone, "sm")}
                              pendingLabel="Recording decision…"
                            >
                              {decision.button}
                            </SubmitButton>
                          </form>
                        ))}
                      </div>
                    ) : null}
                  </div>
                ) : null}
                {view === "billing-disputes" ? (
                  <div className="mt-4 space-y-4 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4">
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                        Partner billing request
                      </h4>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[color:var(--team-text)]">
                        {display(item["reason"], "No request reason recorded.")}
                      </p>
                      <p className="mt-2 text-xs leading-5 text-[color:var(--team-text-muted)]">
                        This decision classifies the next Staff follow-up only.
                        It never changes the invoice balance, payment
                        allocation, or provider refund state. Any adjustment or
                        refund still requires its separate controlled workflow.
                      </p>
                    </div>
                    {display(item["state"], "") === "pending" ? (
                      canDecideBillingDisputes ? (
                        <div className="grid gap-4 xl:grid-cols-2">
                          {(
                            [
                              {
                                decision: "information_provided",
                                title: "Provide information",
                                confirmation: "PROVIDE BILLING INFORMATION",
                                button: "Record information provided",
                                tone: "primary" as const,
                              },
                              {
                                decision: "adjustment_required",
                                title: "Adjustment follow-up",
                                confirmation: "REQUIRE BILLING ADJUSTMENT",
                                button: "Require adjustment review",
                                tone: "secondary" as const,
                              },
                              {
                                decision: "refund_review",
                                title: "Refund review",
                                confirmation: "SEND TO REFUND REVIEW",
                                button: "Send to refund review",
                                tone: "secondary" as const,
                              },
                              {
                                decision: "declined",
                                title: "Decline request",
                                confirmation: "DECLINE BILLING REQUEST",
                                button: "Decline billing request",
                                tone: "danger" as const,
                              },
                            ] as const
                          ).map((decision) => (
                            <form
                              key={decision.decision}
                              action={partnerBillingDisputeDecisionAction}
                              className="grid gap-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4"
                            >
                              <input
                                type="hidden"
                                name="requestId"
                                value={display(item["id"], "")}
                              />
                              <input
                                type="hidden"
                                name="expectedVersion"
                                value={display(item["revision"], "")}
                              />
                              <input
                                type="hidden"
                                name="idempotencyKey"
                                value={`partner-billing-dispute:${decision.decision}:${display(item["id"], "unknown")}:${randomUUID()}`}
                              />
                              <input
                                type="hidden"
                                name="decision"
                                value={decision.decision}
                              />
                              <h5 className="text-sm font-semibold text-[color:var(--team-text)]">
                                {decision.title}
                              </h5>
                              <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                                Partner-visible outcome explanation
                                <textarea
                                  className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                                  name="reason"
                                  minLength={12}
                                  maxLength={2_000}
                                  required
                                />
                              </label>
                              <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                                Type {decision.confirmation}
                                <input
                                  className={`${TEAM_INPUT_COMPACT} mt-1`}
                                  name="confirmation"
                                  autoComplete="off"
                                  required
                                />
                              </label>
                              <SubmitButton
                                className={teamButtonClass(decision.tone, "sm")}
                                pendingLabel="Recording outcome…"
                              >
                                {decision.button}
                              </SubmitButton>
                            </form>
                          ))}
                        </div>
                      ) : (
                        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                          Commercial Manager or Team Owner permission and recent
                          MFA are required to classify this request.
                        </p>
                      )
                    ) : (
                      <p className="text-xs text-[color:var(--team-text-muted)]">
                        Resolved {dateLabel(item["resolvedAt"])} by{" "}
                        {display(item["resolverName"], "Staff")}. The recorded
                        classification is immutable and did not change money or
                        call a payment provider.
                      </p>
                    )}
                  </div>
                ) : null}
                {view === "cancellation-requests" ? (
                  <div className="mt-4 space-y-4 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4">
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                        Partner request
                      </h4>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[color:var(--team-text)]">
                        {display(item["reason"], "No request reason recorded.")}
                      </p>
                      <p className="mt-2 text-xs leading-5 text-[color:var(--team-text-muted)]">
                        No fee is applied automatically. Approving cancels the
                        current appointment and supersedes any pending schedule
                        change. Declining leaves the current schedule intact.
                        The winning decision is immutable and the Partner is
                        notified.
                      </p>
                    </div>
                    {display(item["state"], "") === "pending" ? (
                      canDecideCancellationRequests ? (
                        <div className="grid gap-4 xl:grid-cols-2">
                          {(
                            [
                              {
                                decision: "approved",
                                title: "Approve cancellation",
                                confirmation: "APPROVE CANCELLATION",
                                button: "Approve and cancel job",
                                tone: "danger" as const,
                              },
                              {
                                decision: "declined",
                                title: "Decline cancellation",
                                confirmation: "DECLINE CANCELLATION",
                                button: "Decline and keep schedule",
                                tone: "secondary" as const,
                              },
                            ] as const
                          ).map((decision) => (
                            <form
                              key={decision.decision}
                              action={partnerCancellationRequestDecisionAction}
                              className="grid gap-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4"
                            >
                              <input
                                type="hidden"
                                name="requestId"
                                value={display(item["id"], "")}
                              />
                              <input
                                type="hidden"
                                name="expectedVersion"
                                value={display(item["revision"], "")}
                              />
                              <input
                                type="hidden"
                                name="idempotencyKey"
                                value={`partner-cancellation-decision:${decision.decision}:${display(item["id"], "unknown")}:${randomUUID()}`}
                              />
                              <input
                                type="hidden"
                                name="decision"
                                value={decision.decision}
                              />
                              <h5 className="text-sm font-semibold text-[color:var(--team-text)]">
                                {decision.title}
                              </h5>
                              <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                                Staff decision reason
                                <textarea
                                  className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                                  name="reason"
                                  minLength={12}
                                  maxLength={1_000}
                                  required
                                />
                              </label>
                              <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                                Type {decision.confirmation}
                                <input
                                  className={`${TEAM_INPUT_COMPACT} mt-1`}
                                  name="confirmation"
                                  autoComplete="off"
                                  required
                                />
                              </label>
                              <SubmitButton
                                className={teamButtonClass(decision.tone, "sm")}
                                pendingLabel="Recording decision…"
                              >
                                {decision.button}
                              </SubmitButton>
                            </form>
                          ))}
                        </div>
                      ) : (
                        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                          Recent-MFA Staff decision permission is required to
                          resolve this request.
                        </p>
                      )
                    ) : (
                      <p className="text-xs text-[color:var(--team-text-muted)]">
                        Resolved {dateLabel(item["resolvedAt"])} by{" "}
                        {display(item["resolverName"], "Staff")}. The recorded
                        decision cannot be changed.
                      </p>
                    )}
                  </div>
                ) : null}
                {view === "change-requests" ? (
                  <div className="mt-4 space-y-4 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4">
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                        Partner request
                      </h4>
                      <p className="mt-1 whitespace-pre-wrap break-words text-sm text-[color:var(--team-text)]">
                        {display(item["reason"], "No request reason recorded.")}
                      </p>
                      <p className="mt-2 text-xs leading-5 text-[color:var(--team-text-muted)]">
                        Approval can update only the displayed description, crew
                        instructions, access details, or on-site contact. It
                        cannot change price, schedule, service, quantity,
                        hazards, or proof requirements. A material request must
                        be routed to a change order and leaves the job
                        unchanged.
                      </p>
                    </div>

                    <div className="grid gap-4 lg:grid-cols-2">
                      <div className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4">
                        <h5 className="text-sm font-semibold text-[color:var(--team-text)]">
                          Proposed public fields
                        </h5>
                        {proposedJobChangeRows(item["proposedChanges"]).length >
                        0 ? (
                          <dl className="mt-3 space-y-3">
                            {proposedJobChangeRows(item["proposedChanges"]).map(
                              (field) => (
                                <div key={field.label}>
                                  <dt className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                                    {field.label}
                                  </dt>
                                  <dd className="mt-1 whitespace-pre-wrap break-words text-sm text-[color:var(--team-text)]">
                                    {field.value}
                                  </dd>
                                </div>
                              ),
                            )}
                          </dl>
                        ) : (
                          <p className="mt-2 text-sm text-[color:var(--team-text-muted)]">
                            No directly applicable public-field changes were
                            proposed.
                          </p>
                        )}
                      </div>
                      <div className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4">
                        <h5 className="text-sm font-semibold text-[color:var(--team-text)]">
                          Declared material impacts
                        </h5>
                        {proposedJobChangeImpacts(item["proposedChanges"])
                          .length > 0 ? (
                          <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-amber-950">
                            {proposedJobChangeImpacts(
                              item["proposedChanges"],
                            ).map((impact) => (
                              <li key={impact}>{impact}</li>
                            ))}
                          </ul>
                        ) : (
                          <p className="mt-2 text-sm text-[color:var(--team-text-muted)]">
                            The Partner did not declare a price, schedule,
                            service, quantity, hazard, or proof impact. Staff
                            must still validate materiality before approval.
                          </p>
                        )}
                      </div>
                    </div>

                    {display(item["state"], "") === "pending" ? (
                      canDecideJobChangeRequests ? (
                        <div className="grid gap-4 xl:grid-cols-3">
                          {(
                            [
                              ...(proposedJobChangeImpacts(
                                item["proposedChanges"],
                              ).length === 0
                                ? [
                                    {
                                      decision: "approved" as const,
                                      title: "Approve safe fields",
                                      confirmation: "APPROVE JOB CHANGE",
                                      button: "Approve public-field change",
                                      tone: "primary" as const,
                                    },
                                  ]
                                : []),
                              {
                                decision: "change_order_required" as const,
                                title: "Require change order",
                                confirmation: "REQUIRE CHANGE ORDER",
                                button: "Route to change order",
                                tone: "secondary" as const,
                              },
                              {
                                decision: "declined" as const,
                                title: "Decline request",
                                confirmation: "DECLINE JOB CHANGE",
                                button: "Decline without changes",
                                tone: "danger" as const,
                              },
                            ] as const
                          ).map((decision) => (
                            <form
                              key={decision.decision}
                              action={partnerJobChangeRequestDecisionAction}
                              className="grid gap-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4"
                            >
                              <input
                                type="hidden"
                                name="requestId"
                                value={display(item["id"], "")}
                              />
                              <input
                                type="hidden"
                                name="expectedVersion"
                                value={display(item["revision"], "")}
                              />
                              <input
                                type="hidden"
                                name="idempotencyKey"
                                value={`partner-job-change-decision:${decision.decision}:${display(item["id"], "unknown")}:${randomUUID()}`}
                              />
                              <input
                                type="hidden"
                                name="decision"
                                value={decision.decision}
                              />
                              <h5 className="text-sm font-semibold text-[color:var(--team-text)]">
                                {decision.title}
                              </h5>
                              {decision.decision === "change_order_required" ? (
                                availableChangeOrderQuotes(
                                  item["availableChangeOrderQuotes"],
                                ).length > 0 ? (
                                  <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                                    Issued fixed-price job quote
                                    <select
                                      className={`${TEAM_INPUT_COMPACT} mt-1`}
                                      name="partnerQuoteId"
                                      required
                                      defaultValue=""
                                    >
                                      <option value="" disabled>
                                        Choose the exact Quote V2
                                      </option>
                                      {availableChangeOrderQuotes(
                                        item["availableChangeOrderQuotes"],
                                      ).map((quote) => (
                                        <option key={quote.id} value={quote.id}>
                                          {quote.label}
                                        </option>
                                      ))}
                                    </select>
                                    <span className="mt-1 block font-normal leading-5">
                                      Acceptance finalizes only this price and
                                      the safe public fields. Schedule, service,
                                      and proof changes still require Staff
                                      execution.
                                    </span>
                                  </label>
                                ) : (
                                  <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-5 text-amber-950">
                                    No current issued fixed-price Quote V2 is
                                    bound to this job. Create and issue one from
                                    the account’s Commercial workspace before
                                    requiring a change order.
                                  </div>
                                )
                              ) : (
                                <input
                                  type="hidden"
                                  name="partnerQuoteId"
                                  value=""
                                />
                              )}
                              <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                                Staff decision reason
                                <textarea
                                  className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                                  name="reason"
                                  minLength={12}
                                  maxLength={1_000}
                                  required
                                />
                              </label>
                              <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                                Type {decision.confirmation}
                                <input
                                  className={`${TEAM_INPUT_COMPACT} mt-1`}
                                  name="confirmation"
                                  autoComplete="off"
                                  required
                                />
                              </label>
                              <SubmitButton
                                className={teamButtonClass(decision.tone, "sm")}
                                pendingLabel="Recording decision…"
                                disabled={
                                  decision.decision ===
                                    "change_order_required" &&
                                  availableChangeOrderQuotes(
                                    item["availableChangeOrderQuotes"],
                                  ).length === 0
                                }
                              >
                                {decision.button}
                              </SubmitButton>
                            </form>
                          ))}
                        </div>
                      ) : (
                        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                          Recent-MFA Staff decision permission is required to
                          resolve this request.
                        </p>
                      )
                    ) : (
                      <p className="text-xs text-[color:var(--team-text-muted)]">
                        Resolved {dateLabel(item["resolvedAt"])} by{" "}
                        {display(item["resolverName"], "Staff")}. The recorded
                        outcome is immutable; applied fields:{" "}
                        {stringList(
                          objectRecord(item["resolutionSnapshot"])?.[
                            "appliedFields"
                          ],
                        ).join(", ") || "none"}
                        .
                      </p>
                    )}
                  </div>
                ) : null}
                {(view === "people" || view === "security") &&
                canDisablePartnerIdentities ? (
                  <div className="mt-3">
                    <Link
                      className={teamButtonClass("secondary", "sm")}
                      href={partnerAdminHref({
                        view: "security",
                        selectedUserId:
                          view === "people"
                            ? display(item["id"], "")
                            : display(item["partnerUserId"], ""),
                      })}
                    >
                      Review global identity security
                    </Link>
                  </div>
                ) : null}
                {view === "memberships" ? (
                  <PartnerMembershipMutationControls
                    item={item}
                    permissions={membershipPermissions}
                  />
                ) : null}
                {view === "domains" ? (
                  <PartnerDomainMutationControls
                    item={item}
                    permissions={domainPermissions}
                  />
                ) : null}
                {view === "commercial" ? (
                  <div className="mt-4 grid gap-4 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4 lg:grid-cols-2">
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                        Readiness findings
                      </h4>
                      {stringList(item["readinessIssues"]).length > 0 ? (
                        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[color:var(--team-text)]">
                          {stringList(item["readinessIssues"]).map((issue) => (
                            <li key={issue}>{statusLabel(issue)}</li>
                          ))}
                        </ul>
                      ) : (
                        <p className="mt-2 text-sm text-emerald-800">
                          No pricing or hosted-invoice gap is detected in the
                          currently modeled account records.
                        </p>
                      )}
                    </div>
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                        Configuration evidence
                      </h4>
                      <dl className="mt-2 grid grid-cols-2 gap-3 text-sm">
                        <div>
                          <dt className="text-[color:var(--team-text-muted)]">
                            Rate-card records
                          </dt>
                          <dd className="font-medium text-[color:var(--team-text)]">
                            {display(item["totalRateCardCount"], "0")}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[color:var(--team-text-muted)]">
                            Versioned rate cards
                          </dt>
                          <dd className="font-medium text-[color:var(--team-text)]">
                            {display(item["versionedRateCardCount"], "0")}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[color:var(--team-text-muted)]">
                            Quotes
                          </dt>
                          <dd className="font-medium text-[color:var(--team-text)]">
                            {display(item["quoteCount"], "0")}
                          </dd>
                        </div>
                        <div>
                          <dt className="text-[color:var(--team-text-muted)]">
                            Invoice records
                          </dt>
                          <dd className="font-medium text-[color:var(--team-text)]">
                            {display(item["invoiceCount"], "0")}
                          </dd>
                        </div>
                      </dl>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3 lg:col-span-2">
                      <p className="max-w-3xl text-xs text-[color:var(--team-text-muted)]">
                        Account billing-policy configuration and provider
                        payment readiness do not have a canonical writable
                        account record yet. This inventory never exposes hosted
                        URLs, provider identifiers, payloads, credentials,
                        margins, or commissions. Approval rules use a separate
                        account-scoped, audited writer.
                        {canManageCommercial
                          ? " Commercial management authority may create, revise, activate, or deactivate approval rules after recent MFA."
                          : ""}
                      </p>
                      <Link
                        className={teamButtonClass("secondary", "sm")}
                        href={partnerAdminHref({
                          view: "commercial",
                          q,
                          status,
                          selectedId: display(item["id"], ""),
                        })}
                        aria-current={
                          selectedCommercialAccountId ===
                          display(item["id"], "")
                            ? "page"
                            : undefined
                        }
                      >
                        Manage approval rules
                      </Link>
                    </div>
                  </div>
                ) : null}
                {view === "security" &&
                canRevokePartnerSessions &&
                row.status === "active" ? (
                  <details className="mt-4 rounded-xl border border-rose-200 bg-rose-50/70 p-3">
                    <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-semibold text-rose-950">
                      Revoke this partner session
                    </summary>
                    <p
                      id={`session-revoke-help-${display(item["id"], "unknown")}`}
                      className="mt-1 text-xs text-rose-900"
                    >
                      This signs out only this device session. It does not
                      suspend the company membership or disable the person
                      across their other companies.
                    </p>
                    <form
                      action={partnerSecuritySessionRevokeAction}
                      className="mt-3 grid gap-3 lg:grid-cols-2"
                      aria-describedby={`session-revoke-help-${display(item["id"], "unknown")}`}
                    >
                      <input
                        type="hidden"
                        name="sessionId"
                        value={display(item["id"], "")}
                      />
                      <input
                        type="hidden"
                        name="partnerUserId"
                        value={display(item["partnerUserId"], "")}
                      />
                      <input
                        type="hidden"
                        name="accountId"
                        value={display(item["activePartnerAccountId"], "")}
                      />
                      <input
                        type="hidden"
                        name="membershipId"
                        value={display(item["activeMembershipId"], "")}
                      />
                      <input
                        type="hidden"
                        name="expectedVersion"
                        value={display(item["version"], "")}
                      />
                      <input
                        type="hidden"
                        name="idempotencyKey"
                        value={`partner-session:${display(item["id"], "unknown")}:${randomUUID()}`}
                      />
                      <label className="text-xs font-semibold text-rose-950">
                        Reason for revocation
                        <textarea
                          className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                          name="reason"
                          minLength={12}
                          maxLength={1000}
                          required
                        />
                      </label>
                      <label className="text-xs font-semibold text-rose-950">
                        Type REVOKE PARTNER SESSION
                        <input
                          className={`${TEAM_INPUT_COMPACT} mt-1`}
                          name="confirmation"
                          autoComplete="off"
                          required
                        />
                      </label>
                      <div className="lg:col-span-2">
                        <SubmitButton
                          className={teamButtonClass("danger", "sm")}
                          pendingLabel="Revoking session…"
                        >
                          Revoke session
                        </SubmitButton>
                      </div>
                    </form>
                  </details>
                ) : null}
                {view === "quarantine" ? (
                  <div className="mt-4 space-y-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4">
                    <div>
                      <h4 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                        Containment reason
                      </h4>
                      <p className="mt-1 text-sm text-[color:var(--team-text)]">
                        {display(
                          item["reason"],
                          "This case remains contained pending reconciliation.",
                        )}
                      </p>
                    </div>
                    {quarantineHistory(item["history"]).length > 0 ? (
                      <div>
                        <h4 className="text-xs font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                          Recorded history
                        </h4>
                        <ol className="mt-2 space-y-2 border-l-2 border-slate-200 pl-4">
                          {quarantineHistory(item["history"]).map(
                            (history, index) => (
                              <li key={`${history.at}-${index}`}>
                                <p className="text-sm font-medium text-[color:var(--team-text)]">
                                  {history.event}
                                </p>
                                <p className="text-xs text-[color:var(--team-text-soft)]">
                                  {dateLabel(history.at)}
                                </p>
                              </li>
                            ),
                          )}
                        </ol>
                      </div>
                    ) : null}
                    {stringList(item["requestedChannels"]).length > 0 ? (
                      <p className="text-xs text-[color:var(--team-text-muted)]">
                        Requested channels:{" "}
                        {stringList(item["requestedChannels"]).join(", ")}
                        {stringList(item["providerOperationIds"]).length > 0
                          ? ` · Recorded provider IDs: ${stringList(item["providerOperationIds"]).join(", ")}`
                          : " · No provider operation ID is recorded"}
                      </p>
                    ) : null}
                    {item["resolutionAvailable"] === true ? (
                      canReleaseQuarantine ? (
                        <details className="rounded-xl border border-rose-200 bg-rose-50 p-3">
                          <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-semibold text-rose-950">
                            Resolve provider uncertainty
                          </summary>
                          <p
                            id={`quarantine-resolution-help-${display(item["id"], "unknown")}`}
                            className="mt-1 text-xs text-rose-900"
                          >
                            Team Owner only. Verify every requested channel
                            outside Stonegate first. This records evidence and
                            releases the duplicate-send guard; it never calls a
                            provider or retries delivery.
                          </p>
                          <form
                            action={partnerQuarantineResolveAction}
                            className="mt-3 grid gap-3 lg:grid-cols-2"
                            aria-describedby={`quarantine-resolution-help-${display(item["id"], "unknown")}`}
                          >
                            <input
                              type="hidden"
                              name="caseId"
                              value={display(item["id"], "")}
                            />
                            <input
                              type="hidden"
                              name="operationId"
                              value={display(item["sourceId"], "")}
                            />
                            <input
                              type="hidden"
                              name="expectedVersion"
                              value={display(item["version"], "")}
                            />
                            <input
                              type="hidden"
                              name="idempotencyKey"
                              value={`partner-quarantine:${display(item["id"], "unknown")}:${randomUUID()}`}
                            />
                            {stringList(item["requestedChannels"]).map(
                              (channel) => (
                                <input
                                  key={channel}
                                  type="hidden"
                                  name="reviewedChannels"
                                  value={channel}
                                />
                              ),
                            )}
                            <label className="text-xs font-semibold text-rose-950">
                              Provider outcome
                              <select
                                className={`${TEAM_INPUT_COMPACT} mt-1`}
                                name="outcome"
                                defaultValue=""
                                required
                              >
                                <option value="" disabled>
                                  Select only after provider review
                                </option>
                                <option value="confirmed_sent">
                                  Confirmed sent
                                </option>
                                <option value="confirmed_not_sent">
                                  Confirmed not sent
                                </option>
                              </select>
                            </label>
                            <label className="text-xs font-semibold text-rose-950">
                              Evidence type
                              <select
                                className={`${TEAM_INPUT_COMPACT} mt-1`}
                                name="evidenceType"
                                defaultValue=""
                                required
                              >
                                <option value="" disabled>
                                  Select conclusive evidence
                                </option>
                                <option value="provider_delivery_record">
                                  Provider delivery record
                                </option>
                                <option value="provider_no_matching_send">
                                  Provider search found no send
                                </option>
                                <option value="provider_support_response">
                                  Provider support response
                                </option>
                              </select>
                            </label>
                            <label className="text-xs font-semibold text-rose-950">
                              Provider operation IDs
                              <textarea
                                className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                                name="providerOperationIds"
                                defaultValue={stringList(
                                  item["providerOperationIds"],
                                ).join("\n")}
                                maxLength={2560}
                                aria-describedby={`quarantine-provider-help-${display(item["id"], "unknown")}`}
                              />
                              <span
                                id={`quarantine-provider-help-${display(item["id"], "unknown")}`}
                                className="mt-1 block font-normal"
                              >
                                Required for confirmed sent; must be empty for
                                confirmed not sent.
                              </span>
                            </label>
                            <label className="text-xs font-semibold text-rose-950">
                              Evidence and decision reason
                              <textarea
                                className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                                name="reason"
                                minLength={20}
                                maxLength={1000}
                                required
                              />
                            </label>
                            <label className="text-xs font-semibold text-rose-950 lg:col-span-2">
                              Type RESOLVE AS CONFIRMED SENT or RESOLVE AS
                              CONFIRMED NOT SENT to match the selected outcome
                              <input
                                className={`${TEAM_INPUT_COMPACT} mt-1`}
                                name="confirmation"
                                autoComplete="off"
                                required
                              />
                            </label>
                            <div className="lg:col-span-2">
                              <SubmitButton
                                className={teamButtonClass("danger", "sm")}
                                pendingLabel="Recording resolution…"
                              >
                                Record evidence and resolve
                              </SubmitButton>
                            </div>
                          </form>
                        </details>
                      ) : (
                        <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-950">
                          A Team Owner with quarantine-release permission must
                          record the provider resolution.
                        </p>
                      )
                    ) : item["status"] !== "resolved" ? (
                      <p className="rounded-lg border border-slate-200 bg-white p-3 text-xs text-slate-700">
                        Read-only containment: this record has no safe
                        reversible release lifecycle in the current schema.
                        Reconcile the underlying ownership or migration evidence
                        without mutating it from this queue.
                      </p>
                    ) : null}
                  </div>
                ) : null}
                {canSuspendMemberships && membershipAction ? (
                  <details className="mt-4 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-3">
                    <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-semibold text-[color:var(--team-text)]">
                      {membershipAction === "suspend"
                        ? "Suspend this company membership"
                        : "Reactivate this company membership"}
                    </summary>
                    <p className="mt-1 text-xs text-[color:var(--team-text-muted)]">
                      {membershipAction === "suspend"
                        ? "This revokes sessions bound to this company only. The final active administrator is protected."
                        : "This restores membership access, but it does not restore previously revoked sessions."}
                    </p>
                    <form
                      action={partnerMembershipLifecycleAction}
                      className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-end"
                    >
                      <input
                        type="hidden"
                        name="membershipId"
                        value={display(item["id"], "")}
                      />
                      <input
                        type="hidden"
                        name="accountId"
                        value={display(item["partnerAccountId"], "")}
                      />
                      <input
                        type="hidden"
                        name="membershipAction"
                        value={membershipAction}
                      />
                      <input
                        type="hidden"
                        name="expectedVersion"
                        value={display(item["updatedAt"], "")}
                      />
                      <input
                        type="hidden"
                        name="idempotencyKey"
                        value={`partner-membership:${display(item["id"], "unknown")}:${randomUUID()}`}
                      />
                      {membershipAction === "suspend" ? (
                        <label className="min-w-0 flex-1 text-xs font-semibold text-[color:var(--team-text-muted)]">
                          Type SUSPEND MEMBERSHIP
                          <input
                            className={`${TEAM_INPUT_COMPACT} mt-1`}
                            name="confirmation"
                            required
                            autoComplete="off"
                          />
                        </label>
                      ) : (
                        <input
                          type="hidden"
                          name="confirmation"
                          value="REACTIVATE MEMBERSHIP"
                        />
                      )}
                      <SubmitButton
                        className={teamButtonClass(
                          membershipAction === "suspend" ? "danger" : "primary",
                          "sm",
                        )}
                        pendingLabel={
                          membershipAction === "suspend"
                            ? "Suspending…"
                            : "Reactivating…"
                        }
                      >
                        {membershipAction === "suspend"
                          ? "Suspend membership"
                          : "Reactivate membership"}
                      </SubmitButton>
                    </form>
                  </details>
                ) : null}
                {administratorRecoveryEligible ? (
                  <details className="mt-4 rounded-xl border-2 border-rose-300 bg-rose-50 p-4">
                    <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-bold text-rose-950">
                      Recover the missing account Administrator
                    </summary>
                    <p className="mt-2 text-xs leading-5 text-rose-950">
                      Team Owner only. This control appears only when the
                      company has no active Administrator and this member is
                      active, reviewed, password-enabled, and MFA-enrolled. It
                      promotes the member account-wide and revokes all of their
                      sessions.
                    </p>
                    <form
                      action={partnerAdministratorRecoveryAction}
                      className="mt-3 grid gap-3 lg:grid-cols-2"
                    >
                      <input
                        type="hidden"
                        name="accountId"
                        value={display(item["partnerAccountId"], "")}
                      />
                      <input
                        type="hidden"
                        name="membershipId"
                        value={display(item["id"], "")}
                      />
                      <input
                        type="hidden"
                        name="expectedVersion"
                        value={display(item["version"], "")}
                      />
                      <input
                        type="hidden"
                        name="idempotencyKey"
                        value={`partner-admin-recovery:${display(item["id"], "unknown")}:${randomUUID()}`}
                      />
                      <label className="text-xs font-semibold text-rose-950">
                        Recovery reason
                        <textarea
                          className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                          name="reason"
                          minLength={20}
                          maxLength={1_000}
                          required
                        />
                      </label>
                      <label className="text-xs font-semibold text-rose-950">
                        Type RECOVER PARTNER ADMINISTRATOR
                        <input
                          className={`${TEAM_INPUT_COMPACT} mt-1`}
                          name="confirmation"
                          autoComplete="off"
                          required
                        />
                      </label>
                      <div className="lg:col-span-2">
                        <SubmitButton
                          className={teamButtonClass("danger", "sm")}
                          pendingLabel="Recovering Administrator…"
                        >
                          Recover Administrator
                        </SubmitButton>
                      </div>
                    </form>
                  </details>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}

      {payload ? (
        <nav
          aria-label={`${activeConfig.label} pagination`}
          className="flex items-center justify-between gap-3"
        >
          <p className="text-sm text-[color:var(--team-text-soft)]">
            Showing {payload.page.returned} records on this page.
          </p>
          <div className="flex gap-2">
            {cursor ? (
              <Link
                className={teamButtonClass("secondary", "sm")}
                href={partnerAdminHref({
                  view,
                  q,
                  status,
                  selectedId: selectedIdentityId || selectedCommercialAccountId,
                })}
              >
                First page
              </Link>
            ) : null}
            {payload.page.hasMore && payload.page.nextCursor ? (
              <Link
                className={teamButtonClass("primary", "sm")}
                href={partnerAdminHref({
                  view,
                  q,
                  status,
                  cursor: payload.page.nextCursor,
                  selectedId: selectedIdentityId || selectedCommercialAccountId,
                })}
              >
                Next page
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}

      {view === "memberships" ? (
        <aside className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
          Suspend access at the company membership whenever possible. Global
          identity disable is an owner-only containment action because it
          revokes access to every company the person belongs to.
        </aside>
      ) : null}
      {view === "commercial" ? (
        <aside className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
          Commercial readiness is account-scoped. Approval rules now have a
          versioned, audited Staff writer; captured requests never change when a
          rule is revised. Pricing and invoice records remain read-only here,
          while billing-policy setup and provider payment configuration still
          need separate canonical writers.
        </aside>
      ) : null}
      {view === "security" ? (
        <aside className="rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
          Session revocation is device-specific containment. Use Memberships to
          remove access to one company; global identity disable remains a
          distinct Team Owner-only action affecting every company.
        </aside>
      ) : null}
      {view === "quarantine" ? (
        <aside className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          Quarantine is evidence, not a repair button. Only legacy provider
          uncertainty with a durable resolution schema can be resolved here;
          identity and migrated-membership containment remain read-only.
        </aside>
      ) : null}
    </section>
  );
}

function PartnerIdentitySecurityOwnerPanel({
  impact,
  canDisable,
  canResetMfa,
}: {
  impact: PartnerIdentitySecurityImpact;
  canDisable: boolean;
  canResetMfa: boolean;
}): React.ReactElement {
  const identity = impact.identity;
  const disableConfirmation = `DISABLE ${identity.email}`;
  const mfaConfirmation = `RESET ${identity.email} MFA`;
  const membershipCountLabel = impact.allMembershipsEnumerated
    ? String(impact.membershipCount)
    : `${impact.membershipCount}+`;
  const panelHelpId = `partner-global-security-help-${identity.id}`;

  return (
    <section
      className="rounded-2xl border-2 border-rose-300 bg-rose-50/80 p-5 shadow-sm"
      aria-labelledby={`partner-global-security-title-${identity.id}`}
    >
      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.18em] text-rose-800">
            Team Owner only · global identity boundary
          </p>
          <h3
            id={`partner-global-security-title-${identity.id}`}
            className="mt-1 text-xl font-semibold text-rose-950"
          >
            {identity.name}
          </h3>
          <p className="mt-1 break-all text-sm text-rose-900">
            {identity.email}
          </p>
        </div>
        <span
          className={`w-fit rounded-full px-3 py-1 text-xs font-semibold ${statusTone(identity.status)}`}
        >
          {statusLabel(identity.status)}
        </span>
      </div>

      <p id={panelHelpId} className="mt-4 text-sm leading-6 text-rose-950">
        Global disable signs this person out of every company while preserving
        every membership, account, job, document, payment, and financial record.
        Use a membership suspension when only one company should lose access.
      </p>

      <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-rose-200 bg-white/80 p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-rose-700">
            Affected memberships
          </dt>
          <dd className="mt-1 text-lg font-semibold text-rose-950">
            {membershipCountLabel}
          </dd>
        </div>
        <div className="rounded-xl border border-rose-200 bg-white/80 p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-rose-700">
            Active sessions
          </dt>
          <dd className="mt-1 text-lg font-semibold text-rose-950">
            {impact.activeSessionCount}
          </dd>
        </div>
        <div className="rounded-xl border border-rose-200 bg-white/80 p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-rose-700">
            MFA methods
          </dt>
          <dd className="mt-1 text-lg font-semibold text-rose-950">
            {impact.enabledMfaMethodCount}
          </dd>
        </div>
        <div className="rounded-xl border border-rose-200 bg-white/80 p-3">
          <dt className="text-xs font-semibold uppercase tracking-wide text-rose-700">
            Recovery codes
          </dt>
          <dd className="mt-1 text-lg font-semibold text-rose-950">
            {impact.unusedRecoveryCodeCount}
          </dd>
        </div>
      </dl>

      <div className="mt-5 rounded-xl border border-rose-200 bg-white/80 p-4">
        <h4 className="text-sm font-semibold text-rose-950">
          Review every affected company membership
        </h4>
        {!impact.allMembershipsEnumerated ? (
          <p role="alert" className="mt-2 text-sm font-semibold text-rose-900">
            This identity exceeds the bounded 250-membership review. Global
            actions are blocked until an offline owner review can enumerate the
            complete impact.
          </p>
        ) : impact.memberships.length === 0 ? (
          <p className="mt-2 text-sm text-rose-900">
            No company memberships are attached. The identity and its
            credentials are still global records.
          </p>
        ) : (
          <ol
            className="mt-3 divide-y divide-rose-100"
            aria-label="Affected partner account memberships"
          >
            {impact.memberships.map((membership) => (
              <li
                key={membership.id}
                className="grid gap-1 py-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-4"
              >
                <div>
                  <p className="font-semibold text-rose-950">
                    {membership.accountName}
                    {membership.isDefault ? " · Default company" : ""}
                  </p>
                  <p className="text-rose-800">
                    {statusLabel(membership.roleKey)} · Membership{" "}
                    {statusLabel(membership.status)}
                  </p>
                </div>
                <p className="text-rose-800 sm:text-right">
                  {statusLabel(membership.accountStatus)} · Portal{" "}
                  {membership.portalAccessEnabled ? "enabled" : "disabled"}
                </p>
              </li>
            ))}
          </ol>
        )}
      </div>

      <div className="mt-5 grid gap-4 xl:grid-cols-2">
        <details className="rounded-xl border-2 border-rose-300 bg-white p-4">
          <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-bold text-rose-950">
            Disable identity across every company
          </summary>
          {canDisable && impact.canDisable ? (
            <form
              action={partnerIdentityDisableAction}
              className="mt-3 space-y-3"
              aria-describedby={panelHelpId}
            >
              <input type="hidden" name="partnerUserId" value={identity.id} />
              <input
                type="hidden"
                name="expectedVersion"
                value={identity.version}
              />
              <input
                type="hidden"
                name="membershipSnapshot"
                value={impact.membershipSnapshot}
              />
              <input
                type="hidden"
                name="idempotencyKey"
                value={`partner-identity-disable:${identity.id}:${randomUUID()}`}
              />
              <label className="block text-xs font-semibold text-rose-950">
                Security reason
                <textarea
                  className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                  name="reason"
                  minLength={20}
                  maxLength={1000}
                  required
                />
              </label>
              <label className="block text-xs font-semibold text-rose-950">
                Type {disableConfirmation}
                <input
                  className={`${TEAM_INPUT_COMPACT} mt-1`}
                  name="confirmation"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </label>
              <SubmitButton
                className={teamButtonClass("danger", "sm")}
                pendingLabel="Disabling every session…"
              >
                Disable global identity
              </SubmitButton>
            </form>
          ) : (
            <p className="mt-3 text-sm text-rose-900">
              {identity.status === "quarantined"
                ? "Quarantine cannot be reclassified through this control. Reconcile the tenant binding separately."
                : identity.status === "disabled"
                  ? "This identity is already globally disabled."
                  : "The complete membership impact could not be established, so disable is blocked."}
            </p>
          )}
        </details>

        <details className="rounded-xl border-2 border-amber-300 bg-amber-50 p-4">
          <summary className="flex min-h-[44px] cursor-pointer items-center text-sm font-bold text-amber-950">
            Reset partner MFA and require re-enrollment
          </summary>
          <p className="mt-2 text-sm leading-6 text-amber-950">
            This revokes all sessions, authenticators, recovery codes, and
            pending credentials. It does not activate or suspend any company
            membership. The person must verify their existing password and
            enroll a new authenticator through the one-use activation link.
          </p>
          {impact.mfaRecoveryPending ? (
            <p className="mt-2 rounded-lg border border-amber-300 bg-white/70 p-3 text-xs font-semibold text-amber-950">
              Re-enrollment is already pending. Repeating this action revokes
              the earlier link and queues a newly security-version-bound link.
            </p>
          ) : null}
          {canResetMfa && impact.canResetMfa ? (
            <form action={partnerMfaResetAction} className="mt-3 space-y-3">
              <input type="hidden" name="partnerUserId" value={identity.id} />
              <input
                type="hidden"
                name="expectedVersion"
                value={identity.version}
              />
              <input
                type="hidden"
                name="membershipSnapshot"
                value={impact.membershipSnapshot}
              />
              <input
                type="hidden"
                name="idempotencyKey"
                value={`partner-mfa-reset:${identity.id}:${randomUUID()}`}
              />
              <label className="block text-xs font-semibold text-amber-950">
                Security and recovery reason
                <textarea
                  className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 resize-y`}
                  name="reason"
                  minLength={20}
                  maxLength={1000}
                  required
                />
              </label>
              <label className="block text-xs font-semibold text-amber-950">
                Type {mfaConfirmation}
                <input
                  className={`${TEAM_INPUT_COMPACT} mt-1`}
                  name="confirmation"
                  autoComplete="off"
                  spellCheck={false}
                  required
                />
              </label>
              <SubmitButton
                className={teamButtonClass("danger", "sm")}
                pendingLabel="Revoking MFA and sessions…"
              >
                Reset MFA and queue recovery
              </SubmitButton>
            </form>
          ) : (
            <p className="mt-3 text-sm text-amber-950">
              Safe reset is unavailable. The identity must be active, have an
              existing password and MFA posture, and retain at least one active
              portal-enabled membership for purpose-bound recovery.
            </p>
          )}
        </details>
      </div>
    </section>
  );
}

function AdministrationHeader({
  activeView,
  availableViews,
}: {
  activeView: AdministrationView;
  availableViews: typeof VIEW_CONFIG;
}): React.ReactElement {
  return (
    <header className="space-y-4">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary-700">
          Partner Portal
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-[color:var(--team-text)]">
          Partner administration
        </h1>
        <p className="mt-1 max-w-3xl text-sm text-[color:var(--team-text-muted)]">
          Account-centred access operations for every applicant, company,
          registered person, membership, invitation, join request, and verified
          company-domain authority, session, quarantine case, or commercial
          readiness record.
        </p>
      </div>
      <nav
        aria-label="Partner administration sections"
        className="flex gap-2 overflow-x-auto rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-2"
      >
        {availableViews.map((view) => (
          <Link
            key={view.id}
            href={partnerAdminHref({ view: view.id })}
            aria-current={activeView === view.id ? "page" : undefined}
            className={`inline-flex min-h-[44px] shrink-0 items-center rounded-xl px-4 py-2 text-sm font-semibold ${
              activeView === view.id
                ? "bg-primary-50 text-primary-800"
                : "text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)] hover:text-[color:var(--team-text)]"
            }`}
          >
            {view.label}
          </Link>
        ))}
      </nav>
    </header>
  );
}
