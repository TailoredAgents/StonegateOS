import { randomUUID } from "node:crypto";
import { SubmitButton } from "@/components/SubmitButton";
import type { TeamRequestPrincipal } from "@/lib/team-principal";
import { partnerAccountServiceAgreementAction } from "../actions/partner-administration";
import { callAdminApiAs } from "../lib/api";
import {
  TEAM_CARD_PADDED,
  TEAM_INPUT_COMPACT,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass,
} from "./team-ui";

type PricingState =
  | "contracted"
  | "estimate"
  | "quote_required"
  | "standard_rate";

type ServiceEntitlement = {
  serviceKey: string;
  pricingState: PricingState;
  inclusions: string[];
  exclusions: string[];
  quoteRule: string | null;
};

type Agreement = {
  label: string;
  currency: string;
  active: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  inclusions: string[];
  exclusions: string[];
  quoteRules: string | null;
  services: ServiceEntitlement[];
  document: { id: string; filename: string } | null;
  revision: number;
};

type AgreementPayload = {
  agreement: Agreement | null;
  serviceOptions: Array<{ key: string; label: string }>;
  servicesTruncated: boolean;
  etag: string;
};

const SERVICE_KEY_PATTERN = /^[a-z][a-z0-9_-]{1,79}$/u;
const CURRENCY_PATTERN = /^[A-Z]{3}$/u;
const PRICING_STATES = new Set<PricingState>([
  "contracted",
  "estimate",
  "quote_required",
  "standard_rate",
]);

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function boundedList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 40) return null;
  const items = value.filter(
    (item): item is string =>
      typeof item === "string" &&
      item.length >= 1 &&
      item.length <= 500 &&
      item === item.trim(),
  );
  return items.length === value.length ? items : null;
}

function parseEntitlement(value: unknown): ServiceEntitlement | null {
  const item = record(value);
  const serviceKey = item?.["serviceKey"];
  const pricingState = item?.["pricingState"];
  const inclusions = boundedList(item?.["inclusions"]);
  const exclusions = boundedList(item?.["exclusions"]);
  const quoteRule = item?.["quoteRule"];
  if (
    !item ||
    typeof serviceKey !== "string" ||
    !SERVICE_KEY_PATTERN.test(serviceKey) ||
    typeof pricingState !== "string" ||
    !PRICING_STATES.has(pricingState as PricingState) ||
    !inclusions ||
    !exclusions ||
    (quoteRule !== null &&
      (typeof quoteRule !== "string" || quoteRule.length > 1_000))
  ) {
    return null;
  }
  return {
    serviceKey,
    pricingState: pricingState as PricingState,
    inclusions,
    exclusions,
    quoteRule,
  };
}

function parseAgreement(value: unknown): Agreement | null | undefined {
  if (value === null) return null;
  const item = record(value);
  if (!item || !Array.isArray(item["services"])) return undefined;
  const services = item["services"].map(parseEntitlement);
  const inclusions = boundedList(item["inclusions"]);
  const exclusions = boundedList(item["exclusions"]);
  const document = record(item["document"]);
  const effectiveTo = item["effectiveTo"];
  const quoteRules = item["quoteRules"];
  if (
    services.some((service) => !service) ||
    !inclusions ||
    !exclusions ||
    typeof item["label"] !== "string" ||
    item["label"].length < 1 ||
    item["label"].length > 160 ||
    typeof item["currency"] !== "string" ||
    !CURRENCY_PATTERN.test(item["currency"]) ||
    typeof item["active"] !== "boolean" ||
    typeof item["effectiveFrom"] !== "string" ||
    (effectiveTo !== null && typeof effectiveTo !== "string") ||
    (quoteRules !== null &&
      (typeof quoteRules !== "string" || quoteRules.length > 2_000)) ||
    !Number.isSafeInteger(item["revision"]) ||
    Number(item["revision"]) < 1 ||
    (item["document"] !== null &&
      (!document ||
        typeof document["id"] !== "string" ||
        typeof document["filename"] !== "string"))
  ) {
    return undefined;
  }
  return {
    label: item["label"],
    currency: item["currency"],
    active: item["active"],
    effectiveFrom: item["effectiveFrom"],
    effectiveTo,
    inclusions,
    exclusions,
    quoteRules,
    services: services as ServiceEntitlement[],
    document:
      document &&
      typeof document["id"] === "string" &&
      typeof document["filename"] === "string"
        ? { id: document["id"], filename: document["filename"] }
        : null,
    revision: Number(item["revision"]),
  };
}

function parsePayload(
  payload: unknown,
  etag: string | null,
): AgreementPayload | null {
  const root = record(payload);
  const agreement = parseAgreement(root?.["agreement"]);
  const rawOptions = root?.["serviceOptions"];
  if (
    root?.["ok"] !== true ||
    agreement === undefined ||
    !Array.isArray(rawOptions) ||
    typeof root["servicesTruncated"] !== "boolean" ||
    !etag ||
    !/^"(?:0|[1-9][0-9]{0,9})"$/u.test(etag)
  ) {
    return null;
  }
  const serviceOptions = rawOptions.map((value) => {
    const option = record(value);
    return option &&
      typeof option["key"] === "string" &&
      SERVICE_KEY_PATTERN.test(option["key"]) &&
      typeof option["label"] === "string" &&
      option["label"].trim().length > 0 &&
      option["label"].length <= 160
      ? { key: option["key"], label: option["label"].trim() }
      : null;
  });
  if (serviceOptions.some((option) => !option)) return null;
  return {
    agreement,
    serviceOptions: serviceOptions as Array<{ key: string; label: string }>,
    servicesTruncated: root["servicesTruncated"],
    etag,
  };
}

function dateInput(value: string | null): string {
  return value && /^\d{4}-\d{2}-\d{2}/u.test(value) ? value.slice(0, 10) : "";
}

export async function PartnerServiceAgreementManager({
  principal,
  accountId,
  accountName,
  canManage,
}: {
  principal: TeamRequestPrincipal;
  accountId: string;
  accountName: string;
  canManage: boolean;
}): Promise<React.ReactElement> {
  let payload: AgreementPayload | null = null;
  let loadError = "";
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/accounts/${encodeURIComponent(accountId)}/service-agreement`,
      { timeoutMs: 10_000 },
    );
    if (response.ok) {
      payload = parsePayload(
        await response.json().catch(() => null),
        response.headers.get("etag"),
      );
      if (!payload) {
        loadError =
          "The agreement service returned incomplete data. No update is available.";
      }
    } else {
      loadError = `The agreement service could not be loaded (HTTP ${response.status}). No update is available.`;
    }
  } catch {
    loadError =
      "The agreement service could not be reached. No update is available.";
  }

  const agreement = payload?.agreement ?? null;
  const entitlementByKey = new Map(
    agreement?.services.map((service) => [service.serviceKey, service]) ?? [],
  );
  const defaultStart = new Date().toISOString().slice(0, 10);
  return (
    <section
      className={TEAM_CARD_PADDED}
      aria-labelledby="service-agreement-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="service-agreement-heading" className={TEAM_SECTION_TITLE}>
            Service agreement
          </h3>
          <p className={TEAM_SECTION_SUBTITLE}>
            Control which services {accountName} may request, the single account
            currency, effective period, inclusions, exclusions, and when a quote
            is required. This policy can remove booking paths; it cannot create
            Stonegate capacity or bypass scheduling review.
          </p>
        </div>
        <span className="rounded-full bg-[color:var(--team-surface-muted)] px-3 py-1 text-xs font-semibold text-[color:var(--team-text-muted)]">
          {agreement?.active
            ? "Active"
            : agreement
              ? "Inactive"
              : "Not configured"}
        </span>
      </div>

      {loadError ? (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-950"
        >
          {loadError}
        </div>
      ) : payload?.servicesTruncated ? (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
        >
          More than 100 active services exist. Narrow the canonical catalog
          before editing this agreement so an unseen entitlement cannot be
          removed.
        </div>
      ) : !canManage ? (
        <div className="mt-4 rounded-xl border border-sky-200 bg-sky-50 p-4 text-sm text-sky-950">
          This agreement is read-only for your Team role.
        </div>
      ) : payload && payload.serviceOptions.length > 0 ? (
        <form
          action={partnerAccountServiceAgreementAction}
          className="mt-5 space-y-5"
        >
          <input type="hidden" name="accountId" value={accountId} />
          <input
            type="hidden"
            name="expectedVersion"
            value={payload.etag.slice(1, -1)}
          />
          <input
            type="hidden"
            name="idempotencyKey"
            value={`partner-service-agreement:${accountId}:${randomUUID()}`}
          />

          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <label className="md:col-span-2">
              <span className="text-sm font-medium text-[color:var(--team-text)]">
                Agreement label
              </span>
              <input
                className={`${TEAM_INPUT_COMPACT} mt-1 w-full`}
                name="agreementLabel"
                required
                maxLength={160}
                defaultValue={
                  agreement?.label ?? `${accountName} service agreement`
                }
              />
            </label>
            <label>
              <span className="text-sm font-medium text-[color:var(--team-text)]">
                Currency
              </span>
              <input
                className={`${TEAM_INPUT_COMPACT} mt-1 w-full uppercase`}
                name="currency"
                required
                minLength={3}
                maxLength={3}
                pattern="[A-Za-z]{3}"
                defaultValue={agreement?.currency ?? "USD"}
              />
            </label>
            <label className="flex min-h-11 items-center gap-2 self-end rounded-xl border border-[color:var(--team-border)] px-3 py-2 text-sm font-medium text-[color:var(--team-text)]">
              <input
                type="checkbox"
                name="active"
                value="true"
                defaultChecked={agreement?.active ?? false}
              />
              Active for booking
            </label>
            <label>
              <span className="text-sm font-medium text-[color:var(--team-text)]">
                Effective from (UTC date)
              </span>
              <input
                className={`${TEAM_INPUT_COMPACT} mt-1 w-full`}
                type="date"
                name="effectiveFrom"
                required
                defaultValue={dateInput(
                  agreement?.effectiveFrom ?? defaultStart,
                )}
              />
            </label>
            <label>
              <span className="text-sm font-medium text-[color:var(--team-text)]">
                Effective until (optional, exclusive)
              </span>
              <input
                className={`${TEAM_INPUT_COMPACT} mt-1 w-full`}
                type="date"
                name="effectiveTo"
                defaultValue={dateInput(agreement?.effectiveTo ?? null)}
              />
            </label>
            <label className="md:col-span-2">
              <span className="text-sm font-medium text-[color:var(--team-text)]">
                Agreement document ID (optional)
              </span>
              <input
                className={`${TEAM_INPUT_COMPACT} mt-1 w-full font-mono`}
                name="agreementDocumentId"
                maxLength={36}
                defaultValue={agreement?.document?.id ?? ""}
                aria-describedby="agreement-document-help"
              />
              <span
                id="agreement-document-help"
                className="mt-1 block text-xs text-[color:var(--team-text-muted)]"
              >
                Must be an existing document owned by this account.
              </span>
            </label>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <AgreementTextarea
              name="inclusions"
              label="Account-wide inclusions"
              value={agreement?.inclusions ?? []}
            />
            <AgreementTextarea
              name="exclusions"
              label="Account-wide exclusions"
              value={agreement?.exclusions ?? []}
            />
            <label className="lg:col-span-2">
              <span className="text-sm font-medium text-[color:var(--team-text)]">
                Quote and discrepancy rules
              </span>
              <textarea
                className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 w-full`}
                name="quoteRules"
                maxLength={2_000}
                defaultValue={
                  agreement?.quoteRules ??
                  "Contact Stonegate before relying on a price if the requested scope differs from this agreement."
                }
              />
            </label>
          </div>

          <fieldset className="space-y-3">
            <legend className="text-sm font-semibold text-[color:var(--team-text)]">
              Service entitlements
            </legend>
            <p className="text-xs text-[color:var(--team-text-muted)]">
              Only checked services enter Partner booking. Contracted is the
              only price state eligible for instant confirmation; every other
              state is disclosed and routed through its required review path.
            </p>
            <div className="grid gap-3 xl:grid-cols-2">
              {payload.serviceOptions.map((option) => {
                const current = entitlementByKey.get(option.key);
                return (
                  <div
                    key={option.key}
                    className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4"
                  >
                    <label className="flex min-h-11 items-center gap-2 font-semibold text-[color:var(--team-text)]">
                      <input
                        type="checkbox"
                        name="serviceKey"
                        value={option.key}
                        defaultChecked={Boolean(current)}
                      />
                      {option.label}
                    </label>
                    <label className="mt-3 block">
                      <span className="text-xs font-medium text-[color:var(--team-text-muted)]">
                        Pricing treatment
                      </span>
                      <select
                        className={`${TEAM_INPUT_COMPACT} mt-1 w-full`}
                        name={`pricingState:${option.key}`}
                        defaultValue={current?.pricingState ?? "quote_required"}
                      >
                        <option value="contracted">
                          Contracted final rate
                        </option>
                        <option value="estimate">
                          Estimate; review required
                        </option>
                        <option value="quote_required">Quote required</option>
                        <option value="standard_rate">
                          Standard rate; review required
                        </option>
                      </select>
                    </label>
                    <div className="mt-3 grid gap-3 sm:grid-cols-2">
                      <AgreementTextarea
                        compact
                        name={`serviceInclusions:${option.key}`}
                        label="Service inclusions"
                        value={current?.inclusions ?? []}
                      />
                      <AgreementTextarea
                        compact
                        name={`serviceExclusions:${option.key}`}
                        label="Service exclusions"
                        value={current?.exclusions ?? []}
                      />
                    </div>
                    <label className="mt-3 block">
                      <span className="text-xs font-medium text-[color:var(--team-text-muted)]">
                        Service quote rule
                      </span>
                      <textarea
                        className={`${TEAM_INPUT_COMPACT} mt-1 min-h-20 w-full`}
                        name={`serviceQuoteRule:${option.key}`}
                        maxLength={1_000}
                        defaultValue={current?.quoteRule ?? ""}
                      />
                    </label>
                  </div>
                );
              })}
            </div>
          </fieldset>

          <div className="grid gap-4 lg:grid-cols-2">
            <label>
              <span className="text-sm font-medium text-[color:var(--team-text)]">
                Reason for change
              </span>
              <textarea
                className={`${TEAM_INPUT_COMPACT} mt-1 min-h-24 w-full`}
                name="reason"
                required
                minLength={12}
                maxLength={1_000}
                aria-describedby="agreement-reason-help"
              />
              <span
                id="agreement-reason-help"
                className="mt-1 block text-xs text-[color:var(--team-text-muted)]"
              >
                Stored with the immutable Staff audit receipt.
              </span>
            </label>
            <label>
              <span className="text-sm font-medium text-[color:var(--team-text)]">
                Type UPDATE SERVICE AGREEMENT
              </span>
              <input
                className={`${TEAM_INPUT_COMPACT} mt-1 w-full`}
                name="confirmation"
                required
                autoComplete="off"
                maxLength={24}
              />
            </label>
          </div>
          <SubmitButton
            className={teamButtonClass("primary", "sm")}
            pendingLabel="Saving agreement…"
          >
            Save service agreement
          </SubmitButton>
        </form>
      ) : (
        <div
          role="alert"
          className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
        >
          No active canonical services are available. Configure the service
          catalog before creating an account entitlement.
        </div>
      )}
    </section>
  );
}

function AgreementTextarea({
  name,
  label,
  value,
  compact = false,
}: {
  name: string;
  label: string;
  value: string[];
  compact?: boolean;
}): React.ReactElement {
  return (
    <label>
      <span
        className={
          compact
            ? "text-xs font-medium text-[color:var(--team-text-muted)]"
            : "text-sm font-medium text-[color:var(--team-text)]"
        }
      >
        {label}
      </span>
      <textarea
        className={`${TEAM_INPUT_COMPACT} mt-1 ${compact ? "min-h-20" : "min-h-24"} w-full`}
        name={name}
        maxLength={20_039}
        defaultValue={value.join("\n")}
        aria-describedby={`${name.replace(/[^a-z0-9_-]/giu, "-")}-help`}
      />
      <span
        id={`${name.replace(/[^a-z0-9_-]/giu, "-")}-help`}
        className="mt-1 block text-xs text-[color:var(--team-text-muted)]"
      >
        One item per line; up to 40.
      </span>
    </label>
  );
}
