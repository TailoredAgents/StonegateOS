import { SubmitButton } from "@/components/SubmitButton";
import {
  reconcileManualCallAction,
  reconcileSalesEscalationCallAction,
} from "../actions";
import { buildCallReconciliationScope } from "../lib/call-reconciliation-idempotency";
import {
  TEAM_CARD_PADDED,
  TEAM_INPUT_COMPACT,
  teamButtonClass,
} from "./team-ui";

type CallReconciliationCommon = {
  id: string;
  contactId: string;
  contactName: string | null;
  agentMemberId: string;
  actorLabel: string | null;
  state: "reconciliation_required";
  version: number;
  provider: "twilio";
  providerOperationId: string | null;
  providerStatus: number | null;
  failureCode: string | null;
  failureDetail: string | null;
  requestedAt: string;
  dispatchedAt: string | null;
  reconciliationRequiredAt: string;
  providerEvidenceStatus: "unverified_operator_review_required";
  providerOutcomePreserved: true;
};

export type ManualCallReconciliationItem = CallReconciliationCommon & {
  operationKind: "manual";
};

export type SalesEscalationCallReconciliationItem = CallReconciliationCommon & {
  operationKind: "sales_escalation";
  taskId: string;
  providerCustomerOperationId: string | null;
  deliveryCertainty: "uncertain" | "accepted";
  providerAcceptedAt: string | null;
  callbackDeadlineAt: string | null;
  callbackEvidence: {
    count: number;
    lastReceivedAt: string | null;
    hasAppliedEvidence: boolean;
    hasAnomaly: boolean;
  };
};

export type CallReconciliationItem =
  | ManualCallReconciliationItem
  | SalesEscalationCallReconciliationItem;

export type CallReconciliationPayload = {
  ok: true;
  generatedAt: string;
  truncated: boolean;
  items: CallReconciliationItem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isCommonItem(value: Record<string, unknown>): boolean {
  return (
    typeof value["id"] === "string" &&
    typeof value["contactId"] === "string" &&
    isNullableString(value["contactName"]) &&
    typeof value["agentMemberId"] === "string" &&
    isNullableString(value["actorLabel"]) &&
    value["state"] === "reconciliation_required" &&
    Number.isInteger(value["version"]) &&
    Number(value["version"]) > 0 &&
    value["provider"] === "twilio" &&
    isNullableString(value["providerOperationId"]) &&
    (value["providerStatus"] === null ||
      Number.isInteger(value["providerStatus"])) &&
    isNullableString(value["failureCode"]) &&
    isNullableString(value["failureDetail"]) &&
    typeof value["requestedAt"] === "string" &&
    isNullableString(value["dispatchedAt"]) &&
    typeof value["reconciliationRequiredAt"] === "string" &&
    value["providerEvidenceStatus"] === "unverified_operator_review_required" &&
    value["providerOutcomePreserved"] === true
  );
}

function isCallReconciliationItem(
  value: unknown,
): value is CallReconciliationItem {
  if (!isRecord(value) || !isCommonItem(value)) return false;
  if (value["operationKind"] === "manual") return true;
  if (value["operationKind"] !== "sales_escalation") return false;
  const callbackEvidence = value["callbackEvidence"];
  return (
    typeof value["taskId"] === "string" &&
    isNullableString(value["providerCustomerOperationId"]) &&
    ["uncertain", "accepted"].includes(String(value["deliveryCertainty"])) &&
    isNullableString(value["providerAcceptedAt"]) &&
    isNullableString(value["callbackDeadlineAt"]) &&
    isRecord(callbackEvidence) &&
    Number.isInteger(callbackEvidence["count"]) &&
    Number(callbackEvidence["count"]) >= 0 &&
    isNullableString(callbackEvidence["lastReceivedAt"]) &&
    typeof callbackEvidence["hasAppliedEvidence"] === "boolean" &&
    typeof callbackEvidence["hasAnomaly"] === "boolean"
  );
}

export function isCallReconciliationPayload(
  value: unknown,
): value is CallReconciliationPayload {
  return (
    isRecord(value) &&
    value["ok"] === true &&
    typeof value["generatedAt"] === "string" &&
    typeof value["truncated"] === "boolean" &&
    Array.isArray(value["items"]) &&
    value["items"].every(isCallReconciliationItem)
  );
}

function when(value: string | null): string {
  if (!value) return "Time unavailable";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(parsed);
}

function ManualReviewFields(): React.ReactElement {
  return (
    <>
      <label className="grid gap-1 text-sm font-medium text-slate-800">
        Review result
        <select
          name="outcome"
          className={TEAM_INPUT_COMPACT}
          required
          defaultValue="still_uncertain"
        >
          <option value="still_uncertain">
            Still uncertain — keep blocked
          </option>
          <option value="confirmed_active">
            Twilio confirms still active — keep blocked
          </option>
          <option value="confirmed_connected">
            Twilio confirms terminal customer bridge
          </option>
          <option value="confirmed_not_connected">
            Twilio confirms terminal no connection
          </option>
          <option value="confirmed_not_dispatched">
            Twilio confirms no call was dispatched
          </option>
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-800">
        Evidence checked
        <select
          name="evidenceType"
          className={TEAM_INPUT_COMPACT}
          required
          defaultValue="operator_investigation"
        >
          <option value="operator_investigation">
            Investigation incomplete
          </option>
          <option value="provider_call_record">Twilio call record</option>
          <option value="provider_no_matching_call">
            Twilio shows no matching call
          </option>
          <option value="provider_support_response">
            Twilio support response
          </option>
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-800">
        Twilio call SID (required unless not dispatched)
        <input
          name="providerOperationId"
          className={TEAM_INPUT_COMPACT}
          inputMode="text"
          pattern="CA[0-9A-Fa-f]{32}"
          placeholder="CA…"
          autoComplete="off"
        />
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-800">
        Provider HTTP status (optional)
        <input
          name="providerStatus"
          className={TEAM_INPUT_COMPACT}
          inputMode="numeric"
          type="number"
          min={100}
          max={599}
        />
      </label>
    </>
  );
}

const TWILIO_STATUS_OPTIONS = [
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

function SalesEscalationReviewFields(): React.ReactElement {
  return (
    <>
      <label className="grid gap-1 text-sm font-medium text-slate-800">
        Review result
        <select
          name="outcome"
          className={TEAM_INPUT_COMPACT}
          required
          defaultValue="confirmed_dispatched"
        >
          <option value="confirmed_dispatched">
            Call dispatched — customer outcome unresolved
          </option>
          <option value="confirmed_connected">
            Parent and customer records prove connection
          </option>
          <option value="confirmed_not_dispatched">
            Provider proves no call was dispatched
          </option>
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-800">
        Evidence checked
        <select
          name="evidenceType"
          className={TEAM_INPUT_COMPACT}
          required
          defaultValue="provider_call_record"
        >
          <option value="provider_call_record">Twilio call record</option>
          <option value="provider_no_matching_call">
            Twilio shows no matching call
          </option>
          <option value="provider_support_response">
            Twilio support response
          </option>
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-800">
        Parent call SID
        <input
          name="providerOperationId"
          className={TEAM_INPUT_COMPACT}
          inputMode="text"
          pattern="CA[0-9A-Fa-f]{32}"
          placeholder="CA…"
          autoComplete="off"
        />
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-800">
        Parent status
        <select
          name="providerCallStatus"
          className={TEAM_INPUT_COMPACT}
          defaultValue=""
        >
          <option value="">No parent record</option>
          {TWILIO_STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-800">
        Customer-leg call SID (connected only)
        <input
          name="providerCustomerOperationId"
          className={TEAM_INPUT_COMPACT}
          inputMode="text"
          pattern="CA[0-9A-Fa-f]{32}"
          placeholder="CA…"
          autoComplete="off"
        />
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-800">
        Customer-leg status (connected only)
        <select
          name="providerCustomerStatus"
          className={TEAM_INPUT_COMPACT}
          defaultValue=""
        >
          <option value="">No customer record</option>
          {TWILIO_STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium text-slate-800 lg:col-span-2">
        Connected customer duration in seconds (connected only)
        <input
          name="connectedDurationSec"
          className={TEAM_INPUT_COMPACT}
          type="number"
          inputMode="numeric"
          min={1}
          max={86_400}
        />
      </label>
    </>
  );
}

function ReconciliationCard({
  item,
}: {
  item: CallReconciliationItem;
}): React.ReactElement {
  const isEscalation = item.operationKind === "sales_escalation";
  return (
    <article className="rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-slate-950">
              {item.contactName ?? "Deleted or unavailable contact"}
            </h3>
            <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-700">
              {isEscalation ? "Worker sales escalation" : "Manual Team call"}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-600">
            Quarantined {when(item.reconciliationRequiredAt)} · Version{" "}
            {item.version}
          </p>
        </div>
        <span className="inline-flex min-h-7 items-center self-start rounded-full bg-amber-100 px-3 text-xs font-semibold text-amber-900">
          New calls blocked
        </span>
      </div>
      <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-medium text-slate-700">Stored outcome</dt>
          <dd className="mt-0.5 text-slate-600">
            Reconciliation required ·{" "}
            {item.failureCode ?? "Unknown failure code"}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-slate-700">
            Stored provider evidence
          </dt>
          <dd className="mt-0.5 text-slate-600">
            {item.providerOperationId ?? "No Twilio SID was stored"}
            {item.providerStatus ? ` · HTTP ${item.providerStatus}` : ""}
          </dd>
        </div>
        {isEscalation ? (
          <>
            <div>
              <dt className="font-medium text-slate-700">
                Original delivery certainty
              </dt>
              <dd className="mt-0.5 text-slate-600">
                {item.deliveryCertainty} · Customer SID{" "}
                {item.providerCustomerOperationId ?? "not stored"}
              </dd>
            </div>
            <div>
              <dt className="font-medium text-slate-700">
                Signed callback evidence
              </dt>
              <dd className="mt-0.5 text-slate-600">
                {item.callbackEvidence.count} event
                {item.callbackEvidence.count === 1 ? "" : "s"}
                {item.callbackEvidence.lastReceivedAt
                  ? ` · Last ${when(item.callbackEvidence.lastReceivedAt)}`
                  : " · None received"}
                {item.callbackEvidence.hasAnomaly ? " · Anomaly present" : ""}
              </dd>
            </div>
          </>
        ) : null}
      </dl>

      <form
        action={
          isEscalation
            ? reconcileSalesEscalationCallAction
            : reconcileManualCallAction
        }
        className="mt-4 grid gap-3 lg:grid-cols-2"
      >
        <input type="hidden" name="callOperationId" value={item.id} />
        <input type="hidden" name="expectedVersion" value={item.version} />
        <input
          type="hidden"
          name="idempotencyKey"
          value={buildCallReconciliationScope(
            isEscalation ? "sales_escalation" : "manual",
            item.id,
            item.version,
          )}
        />
        {isEscalation ? (
          <SalesEscalationReviewFields />
        ) : (
          <ManualReviewFields />
        )}
        <label className="grid gap-1 text-sm font-medium text-slate-800 lg:col-span-2">
          Evidence and reason
          <textarea
            name="reason"
            minLength={20}
            maxLength={1000}
            required
            rows={3}
            className={TEAM_INPUT_COMPACT}
            placeholder="Describe exactly what was checked in Twilio and what it showed."
          />
          <span className="text-xs font-normal text-slate-600">
            Do not paste phone numbers, message contents, payment data,
            credentials, or provider secrets. Saving this review never sends or
            retries a Twilio call.
          </span>
        </label>
        <label className="grid gap-1 text-sm font-medium text-slate-800 lg:col-span-2">
          Type RECONCILE CALL
          <input
            name="confirmation"
            className={TEAM_INPUT_COMPACT}
            required
            pattern="RECONCILE CALL"
            autoComplete="off"
          />
        </label>
        <div className="lg:col-span-2">
          <SubmitButton
            className={`${teamButtonClass("danger", "sm")} min-h-11`}
            pendingLabel="Saving evidence…"
          >
            Save append-only review
          </SubmitButton>
        </div>
      </form>
    </article>
  );
}

export function CallReconciliationPanel({
  data,
  error,
}: {
  data: CallReconciliationPayload | null;
  error: string | null;
}): React.ReactElement {
  return (
    <section
      id="sales-hq-call-reconciliation"
      className={`${TEAM_CARD_PADDED} border-amber-300 bg-amber-50/60`}
      aria-labelledby="call-reconciliation-title"
    >
      <h2
        id="call-reconciliation-title"
        className="text-lg font-semibold text-slate-950"
      >
        Call reconciliation
      </h2>
      <p className="mt-1 max-w-4xl text-sm leading-6 text-slate-700">
        These calls crossed the Twilio dispatch boundary without a complete CRM
        receipt. Check Twilio first. The original provider outcome stays
        unchanged; this workflow only appends your review evidence.
      </p>

      {error || !data ? (
        <p
          className="mt-4 rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-800"
          role="alert"
        >
          {error ??
            "Call reconciliation is unavailable. This is not an empty queue."}
        </p>
      ) : data.items.length === 0 ? (
        <p
          className="mt-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800"
          role="status"
        >
          No unresolved call attempts.
        </p>
      ) : (
        <div className="mt-4 space-y-4">
          {data.items.map((item) => (
            <ReconciliationCard
              key={`${item.operationKind}:${item.id}`}
              item={item}
            />
          ))}
          {data.truncated ? (
            <p className="text-xs font-medium text-amber-900">
              Showing the 100 most recent unresolved records. Resolve or
              annotate these before loading more.
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
