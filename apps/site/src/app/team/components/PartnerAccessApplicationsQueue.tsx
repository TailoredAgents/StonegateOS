import { randomUUID } from "node:crypto";
import { SubmitButton } from "@/components/SubmitButton";
import type { TeamRequestPrincipal } from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import { partnerAccessApplicationDecisionAction } from "../actions";
import {
  TEAM_CARD_PADDED,
  TEAM_EMPTY_STATE,
  TEAM_INPUT_COMPACT,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass,
} from "./team-ui";

type AccessApplication = {
  id: string;
  status: "submitted" | "under_review" | "needs_information";
  version: string;
  applicant: {
    name: string;
    email: string;
    phone: string | null;
    identityActive: boolean;
    emailVerifiedAt: string | null;
  };
  company: {
    name: string;
    website: string | null;
    persona: string;
    serviceAreas: string[];
    requestedNeeds: string[];
  };
  account: {
    name: string | null;
    status: string | null;
    portalAccessEnabled: boolean;
  } | null;
  review: { note: string | null; reviewedAt: string | null };
  submittedAt: string;
  allowedActions: Array<"needs_information" | "approve" | "decline">;
  decisionBlockedReason: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseApplication(value: unknown): AccessApplication | null {
  if (
    !isRecord(value) ||
    !isRecord(value["applicant"]) ||
    !isRecord(value["company"])
  ) {
    return null;
  }
  const status = value["status"];
  const applicant = value["applicant"];
  const company = value["company"];
  const account = value["account"];
  const review = value["review"];
  const allowedActions = value["allowedActions"];
  if (
    typeof value["id"] !== "string" ||
    !["submitted", "under_review", "needs_information"].includes(
      String(status),
    ) ||
    typeof value["version"] !== "string" ||
    typeof applicant["name"] !== "string" ||
    typeof applicant["email"] !== "string" ||
    typeof applicant["identityActive"] !== "boolean" ||
    !(applicant["phone"] === null || typeof applicant["phone"] === "string") ||
    !(
      applicant["emailVerifiedAt"] === null ||
      typeof applicant["emailVerifiedAt"] === "string"
    ) ||
    typeof company["name"] !== "string" ||
    typeof company["persona"] !== "string" ||
    !(company["website"] === null || typeof company["website"] === "string") ||
    !Array.isArray(company["serviceAreas"]) ||
    !company["serviceAreas"].every((item) => typeof item === "string") ||
    !Array.isArray(company["requestedNeeds"]) ||
    !company["requestedNeeds"].every((item) => typeof item === "string") ||
    !isRecord(review) ||
    !(review["note"] === null || typeof review["note"] === "string") ||
    !Array.isArray(allowedActions) ||
    !allowedActions.every((item) =>
      ["needs_information", "approve", "decline"].includes(String(item)),
    ) ||
    typeof value["submittedAt"] !== "string" ||
    !(
      value["decisionBlockedReason"] === null ||
      typeof value["decisionBlockedReason"] === "string"
    )
  ) {
    return null;
  }
  if (
    account !== null &&
    (!isRecord(account) ||
      !(account["name"] === null || typeof account["name"] === "string") ||
      !(account["status"] === null || typeof account["status"] === "string") ||
      typeof account["portalAccessEnabled"] !== "boolean")
  ) {
    return null;
  }
  return value as unknown as AccessApplication;
}

function formatDate(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? "Unknown time"
    : parsed.toLocaleString();
}

function label(value: string): string {
  return value.replaceAll("_", " ");
}

export async function PartnerAccessApplicationsQueue({
  principal,
  canDecide,
}: {
  principal: TeamRequestPrincipal;
  canDecide: boolean;
}): Promise<React.ReactElement> {
  let applications: AccessApplication[] = [];
  let loadError = "";
  try {
    const response = await callAdminApiAs(
      principal,
      "/api/admin/partners/access-applications?status=active&limit=25",
    );
    if (!response.ok) {
      loadError = `The access queue could not be loaded (HTTP ${response.status}).`;
    } else {
      const payload = (await response.json().catch(() => null)) as unknown;
      if (
        !isRecord(payload) ||
        payload["ok"] !== true ||
        !Array.isArray(payload["applications"])
      ) {
        loadError = "The access queue returned an incomplete response.";
      } else {
        const parsed = payload["applications"].map(parseApplication);
        if (parsed.some((item) => item === null)) {
          loadError = "The access queue returned an unreadable application.";
        } else {
          applications = parsed as AccessApplication[];
        }
      }
    }
  } catch {
    loadError = "The access queue could not be reached.";
  }

  return (
    <section
      className={TEAM_CARD_PADDED}
      aria-labelledby="partner-access-queue-title"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="partner-access-queue-title" className={TEAM_SECTION_TITLE}>
            Partner Portal access applications
          </h3>
          <p className={TEAM_SECTION_SUBTITLE}>
            Review new company workspaces. Approval grants an administrator role
            that requires MFA; pricing and instant confirmation remain separate.
          </p>
        </div>
        <span className="rounded-full bg-amber-50 px-3 py-1 text-xs font-semibold text-amber-800">
          {applications.length} awaiting action
        </span>
      </div>

      {loadError ? (
        <div
          role="alert"
          className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-900"
        >
          {loadError} This is a load failure, not an empty queue.
        </div>
      ) : applications.length === 0 ? (
        <div className={`${TEAM_EMPTY_STATE} mt-4`}>
          No active access applications.
        </div>
      ) : (
        <ul className="mt-4 grid gap-4 xl:grid-cols-2">
          {applications.map((application) => {
            const canRequestInformation =
              application.allowedActions.includes("needs_information");
            const canApprove =
              application.allowedActions.includes("approve") &&
              Boolean(application.applicant.emailVerifiedAt);
            const canDecline = application.allowedActions.includes("decline");
            return (
              <li
                key={application.id}
                className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4"
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h4 className="font-semibold text-[color:var(--team-text)]">
                      {application.company.name}
                    </h4>
                    <p className="mt-1 text-sm text-[color:var(--team-text-muted)]">
                      {application.applicant.name} ·{" "}
                      {application.applicant.email}
                    </p>
                  </div>
                  <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold capitalize text-slate-700">
                    {label(application.status)}
                  </span>
                </div>
                <dl className="mt-3 grid gap-2 text-xs text-[color:var(--team-text-muted)] sm:grid-cols-2">
                  <div>
                    <dt className="font-semibold text-[color:var(--team-text)]">
                      Persona
                    </dt>
                    <dd className="capitalize">
                      {label(application.company.persona)}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-[color:var(--team-text)]">
                      Submitted
                    </dt>
                    <dd>{formatDate(application.submittedAt)}</dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-[color:var(--team-text)]">
                      Email
                    </dt>
                    <dd>
                      {application.applicant.emailVerifiedAt
                        ? "Verified"
                        : "Not verified"}
                    </dd>
                  </div>
                  <div>
                    <dt className="font-semibold text-[color:var(--team-text)]">
                      Limited account
                    </dt>
                    <dd>
                      {application.account?.name ?? "Reconciliation required"}
                    </dd>
                  </div>
                </dl>
                {application.company.serviceAreas.length ? (
                  <p className="mt-3 text-xs text-[color:var(--team-text-muted)]">
                    <span className="font-semibold text-[color:var(--team-text)]">
                      Service areas:
                    </span>{" "}
                    {application.company.serviceAreas.join(", ")}
                  </p>
                ) : null}
                {application.company.requestedNeeds.length ? (
                  <p className="mt-2 text-xs text-[color:var(--team-text-muted)]">
                    <span className="font-semibold text-[color:var(--team-text)]">
                      Needs:
                    </span>{" "}
                    {application.company.requestedNeeds.join(", ")}
                  </p>
                ) : null}
                {application.review.note ? (
                  <div className="mt-3 rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
                    Previous request: {application.review.note}
                  </div>
                ) : null}
                {application.decisionBlockedReason ? (
                  <div
                    role="status"
                    className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"
                  >
                    {application.decisionBlockedReason}
                  </div>
                ) : null}

                {canDecide ? (
                  <div className="mt-4 grid gap-3">
                    {canRequestInformation ? (
                      <details className="rounded-xl border border-[color:var(--team-border)] p-3">
                        <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-[color:var(--team-text)]">
                          Request information
                        </summary>
                        <form
                          action={partnerAccessApplicationDecisionAction}
                          className="mt-2 space-y-3"
                        >
                          <input
                            type="hidden"
                            name="applicationId"
                            value={application.id}
                          />
                          <input
                            type="hidden"
                            name="decision"
                            value="needs_information"
                          />
                          <input
                            type="hidden"
                            name="confirmation"
                            value="REQUEST INFORMATION"
                          />
                          <input
                            type="hidden"
                            name="expectedVersion"
                            value={application.version}
                          />
                          <input
                            type="hidden"
                            name="idempotencyKey"
                            value={`partner-access-decision:${application.id}:${randomUUID()}`}
                          />
                          <label className="block text-xs font-semibold text-[color:var(--team-text-muted)]">
                            What must the applicant provide?
                            <textarea
                              name="note"
                              required
                              minLength={2}
                              maxLength={2000}
                              rows={3}
                              className={`${TEAM_INPUT_COMPACT} mt-1 w-full`}
                            />
                          </label>
                          <SubmitButton
                            className={teamButtonClass("secondary", "sm")}
                            pendingLabel="Saving…"
                          >
                            Send to follow-up
                          </SubmitButton>
                        </form>
                      </details>
                    ) : null}
                    {canApprove ? (
                      <details className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3">
                        <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-emerald-900">
                          Approve administrator access
                        </summary>
                        <p className="text-xs text-emerald-900">
                          This promotes the generated applicant membership to
                          Administrator and requires MFA. It does not create
                          rates or guarantee an available slot.
                        </p>
                        <form
                          action={partnerAccessApplicationDecisionAction}
                          className="mt-3 space-y-3"
                        >
                          <input
                            type="hidden"
                            name="applicationId"
                            value={application.id}
                          />
                          <input
                            type="hidden"
                            name="decision"
                            value="approve"
                          />
                          <input
                            type="hidden"
                            name="expectedVersion"
                            value={application.version}
                          />
                          <input
                            type="hidden"
                            name="idempotencyKey"
                            value={`partner-access-decision:${application.id}:${randomUUID()}`}
                          />
                          <label className="block text-xs font-semibold text-emerald-950">
                            Optional review note
                            <textarea
                              name="note"
                              maxLength={1000}
                              rows={2}
                              className={`${TEAM_INPUT_COMPACT} mt-1 w-full`}
                            />
                          </label>
                          <label className="block text-xs font-semibold text-emerald-950">
                            Type APPROVE
                            <input
                              name="confirmation"
                              required
                              autoComplete="off"
                              className={`${TEAM_INPUT_COMPACT} mt-1 w-full`}
                            />
                          </label>
                          <SubmitButton
                            className={teamButtonClass("primary", "sm")}
                            pendingLabel="Approving…"
                          >
                            Approve access
                          </SubmitButton>
                        </form>
                      </details>
                    ) : !application.applicant.emailVerifiedAt ? (
                      <p className="text-xs text-amber-800">
                        Approval is unavailable until the applicant verifies
                        their email.
                      </p>
                    ) : null}
                    {canDecline ? (
                      <details className="rounded-xl border border-rose-200 bg-rose-50/50 p-3">
                        <summary className="min-h-11 cursor-pointer py-2 text-sm font-semibold text-rose-900">
                          Decline and disable limited access
                        </summary>
                        <form
                          action={partnerAccessApplicationDecisionAction}
                          className="mt-3 space-y-3"
                        >
                          <input
                            type="hidden"
                            name="applicationId"
                            value={application.id}
                          />
                          <input
                            type="hidden"
                            name="decision"
                            value="decline"
                          />
                          <input
                            type="hidden"
                            name="expectedVersion"
                            value={application.version}
                          />
                          <input
                            type="hidden"
                            name="idempotencyKey"
                            value={`partner-access-decision:${application.id}:${randomUUID()}`}
                          />
                          <label className="block text-xs font-semibold text-rose-950">
                            Reason
                            <textarea
                              name="note"
                              required
                              minLength={2}
                              maxLength={2000}
                              rows={3}
                              className={`${TEAM_INPUT_COMPACT} mt-1 w-full`}
                            />
                          </label>
                          <label className="block text-xs font-semibold text-rose-950">
                            Type DECLINE
                            <input
                              name="confirmation"
                              required
                              autoComplete="off"
                              className={`${TEAM_INPUT_COMPACT} mt-1 w-full`}
                            />
                          </label>
                          <SubmitButton
                            className={teamButtonClass("danger", "sm")}
                            pendingLabel="Declining…"
                          >
                            Decline application
                          </SubmitButton>
                        </form>
                      </details>
                    ) : null}
                  </div>
                ) : (
                  <p className="mt-4 text-xs text-[color:var(--team-text-soft)]">
                    This queue is read-only. Partner Invite permission is
                    required to make a decision.
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
