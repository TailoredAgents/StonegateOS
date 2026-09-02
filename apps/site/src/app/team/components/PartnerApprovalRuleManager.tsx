import { randomUUID } from "node:crypto";
import { SubmitButton } from "@/components/SubmitButton";
import {
  partnerApprovalRuleCreateAction,
  partnerApprovalRuleUpdateAction,
} from "../actions/partner-approval-rules";
import {
  TEAM_CARD_PADDED,
  TEAM_INPUT_COMPACT,
  teamButtonClass,
} from "./team-ui";

export type PartnerApprovalRuleAdminItem = {
  id: string;
  partnerAccountId: string;
  name: string;
  conditions: {
    serviceKeys?: string[];
    locationIds?: string[];
    minimumAmountMinor?: number;
    maximumAmountMinor?: number;
    requesterRoleKeys?: string[];
    poNumberState?: "present" | "missing";
    costCenterState?: "present" | "missing";
  };
  requiredApproverCapabilities: ["approvals.decide"];
  requiredDecisionCount: number;
  active: boolean;
  revision: number;
  creator: { type: "partner_membership" | "team_member"; id: string };
  updatedByTeamMemberId: string | null;
  createdAt: string;
  updatedAt: string;
  etag: string;
};

export type PartnerApprovalRuleAdminOptions = {
  services: Array<{ key: string; label: string }>;
  locations: Array<{ id: string; label: string; address: string }>;
  servicesTruncated: boolean;
  locationsTruncated: boolean;
};

function amount(value: number | undefined): string {
  return value === undefined ? "" : (value / 100).toFixed(2);
}

function RuleFields({
  id,
  rule,
  options,
}: {
  id: string;
  rule?: PartnerApprovalRuleAdminItem;
  options: PartnerApprovalRuleAdminOptions;
}) {
  const conditions = rule?.conditions ?? {};
  const knownServices = new Set(options.services.map((item) => item.key));
  const unavailableServices = (conditions.serviceKeys ?? []).filter(
    (key) => !knownServices.has(key),
  );
  const knownLocations = new Set(options.locations.map((item) => item.id));
  const unavailableLocations = (conditions.locationIds ?? []).filter(
    (locationId) => !knownLocations.has(locationId),
  );
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <label className="text-xs font-semibold text-[color:var(--team-text-muted)] lg:col-span-2">
        Rule name
        <input
          className={TEAM_INPUT_COMPACT + " mt-1"}
          name="name"
          defaultValue={rule?.name ?? ""}
          minLength={1}
          maxLength={160}
          required
        />
      </label>

      <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
        Services
        <select
          className={TEAM_INPUT_COMPACT + " mt-1 min-h-32"}
          name="serviceKeys"
          defaultValue={conditions.serviceKeys ?? []}
          multiple
          aria-describedby={id + "-services-help"}
        >
          {options.services.map((service) => (
            <option key={service.key} value={service.key}>
              {service.label} ({service.key})
            </option>
          ))}
          {unavailableServices.map((key) => (
            <option key={key} value={key}>
              Unavailable service ({key})
            </option>
          ))}
        </select>
        <span
          id={id + "-services-help"}
          className="mt-1 block font-normal leading-5"
        >
          Leave empty for every service. Use Ctrl/Cmd to select more than one.
        </span>
      </label>

      <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
        Locations
        <select
          className={TEAM_INPUT_COMPACT + " mt-1 min-h-32"}
          name="locationIds"
          defaultValue={conditions.locationIds ?? []}
          multiple
          aria-describedby={id + "-locations-help"}
        >
          {options.locations.map((location) => (
            <option key={location.id} value={location.id}>
              {location.label} — {location.address}
            </option>
          ))}
          {unavailableLocations.map((locationId) => (
            <option key={locationId} value={locationId}>
              Unavailable location ({locationId})
            </option>
          ))}
        </select>
        <span
          id={id + "-locations-help"}
          className="mt-1 block font-normal leading-5"
        >
          Leave empty for every location. Only this company’s locations pass
          server validation.
        </span>
      </label>

      <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
        Minimum amount (USD)
        <input
          className={TEAM_INPUT_COMPACT + " mt-1"}
          name="minimumAmount"
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          defaultValue={amount(conditions.minimumAmountMinor)}
          placeholder="No minimum"
        />
      </label>
      <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
        Maximum amount (USD)
        <input
          className={TEAM_INPUT_COMPACT + " mt-1"}
          name="maximumAmount"
          type="number"
          inputMode="decimal"
          min="0"
          step="0.01"
          defaultValue={amount(conditions.maximumAmountMinor)}
          placeholder="No maximum"
        />
      </label>

      <fieldset className="rounded-xl border border-[color:var(--team-border)] p-3 lg:col-span-2">
        <legend className="px-1 text-xs font-semibold text-[color:var(--team-text-muted)]">
          Requester roles
        </legend>
        <p className="mb-2 text-xs text-[color:var(--team-text-muted)]">
          Leave every role clear to match all requesters.
        </p>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {(
            [
              ["administrator", "Administrator"],
              ["operations", "Operations"],
              ["billing_approver", "Billing / Approver"],
              ["viewer", "Viewer"],
            ] as const
          ).map(([value, label]) => (
            <label
              key={value}
              className="flex min-h-[44px] items-center gap-2 text-sm"
            >
              <input
                type="checkbox"
                name="requesterRoleKeys"
                value={value}
                defaultChecked={conditions.requesterRoleKeys?.includes(value)}
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
        PO number condition
        <select
          className={TEAM_INPUT_COMPACT + " mt-1"}
          name="poNumberState"
          defaultValue={conditions.poNumberState ?? ""}
        >
          <option value="">Any PO state</option>
          <option value="present">PO must be present</option>
          <option value="missing">PO must be missing</option>
        </select>
      </label>
      <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
        Cost-center condition
        <select
          className={TEAM_INPUT_COMPACT + " mt-1"}
          name="costCenterState"
          defaultValue={conditions.costCenterState ?? ""}
        >
          <option value="">Any cost-center state</option>
          <option value="present">Cost center must be present</option>
          <option value="missing">Cost center must be missing</option>
        </select>
      </label>

      <label className="text-xs font-semibold text-[color:var(--team-text-muted)]">
        Required independent decisions
        <input
          className={TEAM_INPUT_COMPACT + " mt-1"}
          name="requiredDecisionCount"
          type="number"
          min={1}
          max={20}
          step={1}
          defaultValue={rule?.requiredDecisionCount ?? 1}
          required
        />
      </label>
      <label className="flex min-h-[44px] items-center gap-2 self-end text-sm font-semibold text-[color:var(--team-text)]">
        <input
          type="checkbox"
          name="active"
          value="true"
          defaultChecked={rule?.active ?? true}
        />
        Active for new matching requests
      </label>
    </div>
  );
}

function ruleSummary(rule: PartnerApprovalRuleAdminItem): string {
  return [
    rule.conditions.serviceKeys?.length
      ? String(rule.conditions.serviceKeys.length) + " service condition(s)"
      : "all services",
    rule.conditions.locationIds?.length
      ? String(rule.conditions.locationIds.length) + " location condition(s)"
      : "all locations",
    String(rule.requiredDecisionCount) +
      " decision" +
      (rule.requiredDecisionCount === 1 ? "" : "s"),
  ].join(" · ");
}

export function PartnerApprovalRuleManager({
  accountId,
  accountName,
  rules,
  options,
  canManage,
  hasMore,
  loadError,
}: {
  accountId: string;
  accountName: string;
  rules: PartnerApprovalRuleAdminItem[];
  options: PartnerApprovalRuleAdminOptions;
  canManage: boolean;
  hasMore: boolean;
  loadError: string;
}) {
  const chooserTruncated =
    options.servicesTruncated || options.locationsTruncated;
  return (
    <section
      className={TEAM_CARD_PADDED + " space-y-5"}
      aria-labelledby="partner-approval-rules-title"
    >
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[color:var(--team-text-soft)]">
          Commercial controls · {accountName}
        </p>
        <h2
          id="partner-approval-rules-title"
          className="mt-1 text-xl font-semibold text-[color:var(--team-text)]"
        >
          Approval rules
        </h2>
        <p className="mt-2 max-w-4xl text-sm leading-6 text-[color:var(--team-text-muted)]">
          Every matching active rule applies. Approvers must hold the stable{" "}
          <code>approvals.decide</code> capability, and requesters can never
          approve their own work. Rule changes affect only future requests;
          existing requests retain their captured version.
        </p>
      </div>

      {loadError ? (
        <div
          role="alert"
          className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-950"
        >
          <strong>Approval rules are unavailable.</strong> {loadError}
        </div>
      ) : (
        <>
          {chooserTruncated ? (
            <div
              role="status"
              className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950"
            >
              The service or location chooser is truncated. Existing rules
              remain visible, but creating or activating a rule is blocked until
              the account options can be fully enumerated.
            </div>
          ) : null}

          {canManage ? (
            <details className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4">
              <summary className="flex min-h-[44px] cursor-pointer items-center font-semibold text-[color:var(--team-text)]">
                Create approval rule
              </summary>
              <form
                action={partnerApprovalRuleCreateAction}
                className="mt-4 space-y-4"
              >
                <input type="hidden" name="accountId" value={accountId} />
                <input
                  type="hidden"
                  name="idempotencyKey"
                  value={
                    "partner-approval-rule-create:" +
                    accountId +
                    ":" +
                    randomUUID()
                  }
                />
                <RuleFields id="new-partner-approval-rule" options={options} />
                <label className="block text-xs font-semibold text-[color:var(--team-text-muted)]">
                  Operational reason
                  <textarea
                    className={TEAM_INPUT_COMPACT + " mt-1 min-h-24 resize-y"}
                    name="reason"
                    minLength={12}
                    maxLength={1_000}
                    required
                  />
                </label>
                <label className="block text-xs font-semibold text-[color:var(--team-text-muted)]">
                  Type CREATE APPROVAL RULE
                  <input
                    className={TEAM_INPUT_COMPACT + " mt-1"}
                    name="confirmation"
                    autoComplete="off"
                    spellCheck={false}
                    required
                  />
                </label>
                <SubmitButton
                  className={teamButtonClass("primary", "sm")}
                  pendingLabel="Creating rule…"
                  disabled={chooserTruncated}
                >
                  Create approval rule
                </SubmitButton>
              </form>
            </details>
          ) : (
            <p className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4 text-sm text-[color:var(--team-text-muted)]">
              Commercial management permission is required to create or change
              approval rules.
            </p>
          )}

          <div className="space-y-3">
            {rules.length === 0 ? (
              <p className="rounded-xl border border-dashed border-[color:var(--team-border)] p-5 text-sm text-[color:var(--team-text-muted)]">
                No approval rules are configured. Requests will not enter
                account approval unless another review condition applies.
              </p>
            ) : (
              rules.map((rule) => (
                <details
                  key={rule.id}
                  className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4"
                >
                  <summary className="flex min-h-[44px] cursor-pointer flex-wrap items-center justify-between gap-3">
                    <span>
                      <span className="font-semibold text-[color:var(--team-text)]">
                        {rule.name}
                      </span>
                      <span className="mt-1 block text-xs text-[color:var(--team-text-muted)]">
                        {ruleSummary(rule)}
                      </span>
                    </span>
                    <span
                      className={
                        "rounded-full px-2.5 py-1 text-xs font-semibold " +
                        (rule.active
                          ? "bg-emerald-50 text-emerald-800"
                          : "bg-slate-100 text-slate-700")
                      }
                    >
                      {rule.active ? "Active" : "Inactive"} · revision{" "}
                      {rule.revision}
                    </span>
                  </summary>
                  {canManage ? (
                    <form
                      action={partnerApprovalRuleUpdateAction}
                      className="mt-4 space-y-4"
                    >
                      <input type="hidden" name="accountId" value={accountId} />
                      <input type="hidden" name="ruleId" value={rule.id} />
                      <input
                        type="hidden"
                        name="expectedVersion"
                        value={rule.revision}
                      />
                      <input
                        type="hidden"
                        name="idempotencyKey"
                        value={
                          "partner-approval-rule-update:" +
                          rule.id +
                          ":" +
                          String(rule.revision) +
                          ":" +
                          randomUUID()
                        }
                      />
                      <RuleFields
                        id={"partner-approval-rule-" + rule.id}
                        rule={rule}
                        options={options}
                      />
                      <label className="block text-xs font-semibold text-[color:var(--team-text-muted)]">
                        Change reason
                        <textarea
                          className={
                            TEAM_INPUT_COMPACT + " mt-1 min-h-24 resize-y"
                          }
                          name="reason"
                          minLength={12}
                          maxLength={1_000}
                          required
                        />
                      </label>
                      <label className="block text-xs font-semibold text-[color:var(--team-text-muted)]">
                        Type UPDATE APPROVAL RULE
                        <input
                          className={TEAM_INPUT_COMPACT + " mt-1"}
                          name="confirmation"
                          autoComplete="off"
                          spellCheck={false}
                          required
                        />
                      </label>
                      <p className="text-xs leading-5 text-[color:var(--team-text-muted)]">
                        Clear Active to deactivate without deleting history. No
                        current approval request will be rewritten.
                      </p>
                      <SubmitButton
                        className={teamButtonClass("primary", "sm")}
                        pendingLabel="Saving rule…"
                        disabled={chooserTruncated && !rule.active}
                      >
                        Save approval rule
                      </SubmitButton>
                    </form>
                  ) : (
                    <p className="mt-3 text-sm text-[color:var(--team-text-muted)]">
                      This rule is read-only for your Team role.
                    </p>
                  )}
                </details>
              ))
            )}
          </div>
          {hasMore ? (
            <p role="status" className="text-sm text-amber-900">
              More inactive rule history exists beyond this bounded page. Use
              the API cursor before relying on the list as complete.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
