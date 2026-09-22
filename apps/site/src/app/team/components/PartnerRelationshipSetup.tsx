"use client";

import * as React from "react";
import { PartnerServiceRatesEditor } from "./PartnerServiceRatesEditor";
import {
  loadPartnerRelationshipContext,
  savePartnerRelationship,
  searchPartnerRelationshipCompanies,
  type RelationshipChoice,
  type RelationshipContext,
  type RelationshipFeedback,
} from "../actions/partner-relationships";

const FIELD =
  "mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base text-slate-900";
const BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-primary-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";
const ROLES = [
  {
    key: "administrator",
    label: "Administrator",
    help: "All company access, team administration, service and billing.",
  },
  {
    key: "operations",
    label: "Operations",
    help: "Request and manage service without financial administration.",
  },
  {
    key: "billing_approver",
    label: "Billing / Approver",
    help: "Billing and approvals; cannot schedule or change locations.",
  },
  {
    key: "viewer",
    label: "Viewer",
    help: "Read-only job access, without financial information.",
  },
] as const;
const TOOLS = [
  { key: "templates", label: "Saved service templates" },
  { key: "recurring", label: "Recurring service" },
  { key: "bulk", label: "Bulk requests" },
  { key: "reports", label: "Reports" },
  { key: "portfolio", label: "Portfolio tools" },
  { key: "approvals", label: "Approval rules" },
] as const;
function key() {
  return "partner-relationship:" + crypto.randomUUID();
}

/** No partner session impersonation: every action reauthorizes the signed-in staff member. */
export function PartnerRelationshipSetup({
  canCreate,
  canInvite,
  canConfigure,
  canConfigureBilling = false,
  canViewRates = false,
  canConfigureRates = false,
  canCompleteSetup = false,
  openCreate = false,
  initialAccountId,
  openExisting = false,
}: {
  canCreate: boolean;
  canInvite: boolean;
  canConfigure: boolean;
  canConfigureBilling?: boolean;
  canViewRates?: boolean;
  canConfigureRates?: boolean;
  canCompleteSetup?: boolean;
  openCreate?: boolean;
  initialAccountId?: string;
  openExisting?: boolean;
}) {
  const [companies, setCompanies] = React.useState<RelationshipChoice[]>([]);
  const [nextCursor, setNextCursor] = React.useState<string | null>(null);
  const [search, setSearch] = React.useState("");
  const [selectedAccount, setSelectedAccount] = React.useState("");
  const [context, setContext] = React.useState<RelationshipContext | null>(
    null,
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [feedback, setFeedback] = React.useState<RelationshipFeedback | null>(
    null,
  );
  const [ratesDirty, setRatesDirty] = React.useState(false);
  const [ratesReady, setRatesReady] = React.useState(false);
  const [role, setRole] = React.useState("");
  const [scoped, setScoped] = React.useState(false);
  const [locationIds, setLocationIds] = React.useState<string[]>([]);
  const [costCenterIds, setCostCenterIds] = React.useState<string[]>([]);
  const contextGeneration = React.useRef(0);
  const operation = React.useRef<{ key: string; payload: string } | null>(null);
  const feedbackRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (feedback) feedbackRef.current?.focus();
  }, [feedback]);

  async function findCompanies(append = false) {
    setBusy("lookup");
    setFeedback(null);
    const result = await searchPartnerRelationshipCompanies(
      search,
      append ? nextCursor : null,
    ).catch(() => null);
    setBusy(null);
    if (!result?.ok) {
      setFeedback({
        ok: false,
        message: result?.message ?? "Companies could not be loaded.",
      });
      return;
    }
    setCompanies((current) =>
      append
        ? [
            ...new Map(
              [...current, ...result.choices].map((choice) => [
                choice.id,
                choice,
              ]),
            ).values(),
          ]
        : result.choices,
    );
    setNextCursor(result.nextCursor);
  }
  React.useEffect(() => {
    if (initialAccountId) void chooseCompany(initialAccountId);
    else void findCompanies();
    return () => {
      contextGeneration.current += 1;
    };
  }, [initialAccountId]);
  async function chooseCompany(id: string) {
    if (
      ratesDirty &&
      id !== selectedAccount &&
      !window.confirm("Leave these unsaved rate changes?")
    )
      return;
    setRatesDirty(false);
    const generation = ++contextGeneration.current;
    setSelectedAccount(id);
    setRatesReady(false);
    setContext(null);
    setRole("");
    setScoped(false);
    setLocationIds([]);
    setCostCenterIds([]);
    setFeedback(null);
    if (!id) return;
    setBusy("context");
    const result = await loadPartnerRelationshipContext(id).catch(() => null);
    if (generation !== contextGeneration.current) return;
    setBusy(null);
    if (!result?.ok) {
      setFeedback({
        ok: false,
        message: result?.message ?? "Company settings could not be loaded.",
      });
      return;
    }
    setContext(result.context);
  }
  async function save(
    kind: "create" | "invite" | "workflow" | "enable",
    body: unknown,
  ) {
    const payload = JSON.stringify({
      kind,
      body,
      selectedAccount,
      version: context?.version,
    });
    if (operation.current?.payload !== payload)
      operation.current = { payload, key: key() };
    setBusy(kind);
    setFeedback(null);
    const result = await savePartnerRelationship(
      kind,
      body,
      operation.current.key,
      kind === "workflow" || kind === "enable" ? selectedAccount : undefined,
      kind === "workflow" || kind === "enable" ? context?.version : undefined,
    ).catch(() => ({
      ok: false,
      message:
        "The change could not be confirmed. Try again with the same form.",
    }));
    setBusy(null);
    setFeedback(result);
    if (result.ok) {
      operation.current = null;
      if (
        (kind === "workflow" || kind === "enable") &&
        "version" in result &&
        result.version
      )
        setContext((current) =>
          current
            ? {
                ...current,
                version: result.version!,
                account: {
                  ...current.account,
                  enabled: kind === "enable" ? true : current.account.enabled,
                  setupStatus:
                    kind === "enable"
                      ? "complete"
                      : current.account.setupStatus,
                },
              }
            : current,
        );
    }
    return result;
  }
  function toggle(values: string[], value: string) {
    return values.includes(value)
      ? values.filter((entry) => entry !== value)
      : [...values, value];
  }
  if (!canCreate && !canInvite && !canConfigure) return null;
  return (
    <section
      className="space-y-5 rounded-2xl border border-slate-200 bg-white p-5 sm:p-6"
      aria-labelledby="partner-relationship-setup-heading"
    >
      <h2
        id="partner-relationship-setup-heading"
        className="text-xl font-semibold text-slate-900"
      >
        {initialAccountId
          ? canConfigure
            ? "Company settings"
            : "Invite a coworker"
          : "Set up partner service"}
      </h2>
      <p className="text-sm leading-6 text-slate-600">
        For companies Stonegate already works with. New companies start simple;
        turn on extra tools only when needed.
      </p>
      <noscript>
        <p>
          Company setup needs JavaScript. No form will submit personal
          information in a URL. Contact sales@stonegatejunkremoval.com or call
          404-777-2631 for help.
        </p>
      </noscript>
      {feedback ? (
        <div
          ref={feedbackRef}
          tabIndex={-1}
          role={feedback.ok ? "status" : "alert"}
          className={
            "rounded-lg border p-4 text-sm leading-6 " +
            (feedback.ok
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : "border-rose-200 bg-rose-50 text-rose-900")
          }
        >
          {feedback.message}
        </div>
      ) : null}
      {canCreate ? (
        <details
          open={openCreate || undefined}
          className="border-t border-slate-200 pt-3"
        >
          <summary className="min-h-11 cursor-pointer content-center py-2 font-semibold text-slate-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2">
            Company details
          </summary>
          <form
            method="post"
            className="mt-3 grid gap-4 sm:grid-cols-2"
            onSubmit={(event) => {
              event.preventDefault();
              const form = event.currentTarget;
              if (busy || !form.reportValidity()) return;
              const data = new FormData(form);
              void save("create", {
                companyName: data.get("companyName"),
                contactName: data.get("contactName"),
                contactEmail: data.get("contactEmail"),
                persona: data.get("persona"),
                reason: data.get("reason"),
              }).then((result) => {
                if (
                  result.ok &&
                  "accountId" in result &&
                  typeof result.accountId === "string"
                ) {
                  form.reset();
                  void chooseCompany(result.accountId);
                }
              });
            }}
          >
            <label className="text-sm font-semibold">
              Company name
              <input
                name="companyName"
                required
                minLength={2}
                maxLength={160}
                className={FIELD}
              />
            </label>
            <label className="text-sm font-semibold">
              Administrator name
              <input
                name="contactName"
                required
                minLength={2}
                maxLength={120}
                className={FIELD}
              />
            </label>
            <label className="text-sm font-semibold">
              Administrator email
              <input
                name="contactEmail"
                type="email"
                required
                maxLength={254}
                autoComplete="email"
                className={FIELD}
              />
            </label>
            <label className="text-sm font-semibold">
              Company type
              <select name="persona" defaultValue="other" className={FIELD}>
                <option value="contractor">Contractor</option>
                <option value="real_estate_agent">Real estate team</option>
                <option value="property_manager">Property manager</option>
                <option value="commercial_client">Commercial client</option>
                <option value="other">Other established relationship</option>
              </select>
            </label>
            <label className="text-sm font-semibold sm:col-span-2">
              Relationship confirmation
              <textarea
                name="reason"
                required
                minLength={10}
                maxLength={1000}
                className={FIELD}
                placeholder="Who approved access and how we work with this company"
              />
            </label>
            <p className="text-sm leading-6 text-slate-600 sm:col-span-2">
              Save the company details, choose agreed rates or Quote required
              for each service, then activate access and send the Administrator
              invitation. No email is sent in this first step.
            </p>
            <button type="submit" disabled={busy !== null} className={BUTTON}>
              {busy === "create" ? "Creating…" : "Create company and continue"}
            </button>
          </form>
        </details>
      ) : null}
      {!openCreate || context ? (
        <details
          open={
            Boolean(initialAccountId) ||
            openExisting ||
            context?.account.setupStatus === "rates_required" ||
            undefined
          }
          className="border-t border-slate-200 pt-3"
        >
          <summary className="flex min-h-11 cursor-pointer items-center font-semibold text-slate-900">
            {initialAccountId
              ? context?.account.name || "Selected company"
              : "Invite coworkers or configure an existing company"}
          </summary>
          {!initialAccountId && !openCreate ? (
            <>
              <form
                method="post"
                className="mt-3 flex flex-wrap items-end gap-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!busy) void findCompanies();
                }}
              >
                <label className="min-w-0 flex-1 text-sm font-semibold">
                  Find company
                  <input
                    type="search"
                    value={search}
                    onChange={(event) => setSearch(event.target.value)}
                    maxLength={160}
                    className={FIELD}
                  />
                </label>
                <button
                  type="submit"
                  disabled={busy !== null}
                  className={BUTTON}
                >
                  Search
                </button>
              </form>
              <label className="mt-4 block text-sm font-semibold">
                Company
                <select
                  value={selectedAccount}
                  disabled={busy !== null}
                  onChange={(event) => void chooseCompany(event.target.value)}
                  className={FIELD}
                >
                  <option value="">Choose a company</option>
                  {companies.map((company) => (
                    <option key={company.id} value={company.id}>
                      {company.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          {nextCursor ? (
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void findCompanies(true)}
              className="mt-2 min-h-11 text-sm font-semibold text-primary-900 underline"
            >
              Load more companies
            </button>
          ) : null}
          {busy === "context" ? (
            <p role="status" className="mt-4 text-sm text-slate-600">
              Loading company settings…
            </p>
          ) : null}
          {selectedAccount && !context && busy !== "context" ? (
            <button
              type="button"
              onClick={() => void chooseCompany(selectedAccount)}
              className="mt-3 min-h-11 text-sm font-semibold text-primary-900 underline"
            >
              Retry company settings
            </button>
          ) : null}
          {context &&
          canViewRates &&
          (canConfigure || context.account.setupStatus === "rates_required") ? (
            <div className="mt-5 border-t border-slate-200 pt-5">
              {context.account.setupStatus === "rates_required" ? (
                <ol
                  aria-label="Partner setup progress"
                  className="mb-4 flex flex-wrap gap-x-5 gap-y-2 text-sm"
                >
                  <li>1. Company details saved</li>
                  <li aria-current="step" className="font-semibold">
                    2. Service rates
                  </li>
                  <li>3. Activate and invite</li>
                </ol>
              ) : null}
              <PartnerServiceRatesEditor
                key={context.account.id}
                accountId={context.account.id}
                canManage={canConfigureRates}
                onDirtyChange={setRatesDirty}
                onPublished={setRatesReady}
              />
            </div>
          ) : null}
          {context?.account.setupStatus === "rates_required" ? (
            <div className="mt-5 space-y-3 border-t border-slate-200 pt-5">
              <h3 className="font-semibold">Activate and invite</h3>
              <p className="text-sm text-slate-600">
                The company is not active yet. Publish agreed rates or Quote
                required for each service before sending the invitation.
              </p>
              <p className="break-words text-sm">
                Administrator: {context.account.contactName} ·{" "}
                {context.account.contactEmail}
              </p>
              {canCompleteSetup ? (
                <button
                  type="button"
                  className={BUTTON}
                  disabled={busy !== null || !ratesReady || ratesDirty}
                  onClick={() =>
                    void save("enable", {
                      reason:
                        "Company details and service pricing choices reviewed for activation.",
                    })
                  }
                >
                  {busy === "enable"
                    ? "Activating…"
                    : "Activate portal & invite Administrator"}
                </button>
              ) : (
                <p className="text-sm text-slate-600">
                  A staff member with company, rate and invitation permissions
                  must complete activation.
                </p>
              )}
            </div>
          ) : null}
          {context &&
          context.account.setupStatus !== "rates_required" &&
          (!context.account.enabled ||
            context.account.lifecycle !== "active") ? (
            <p className="mt-4 text-sm leading-6 text-amber-900">
              This company is not active for the portal. Review its lifecycle
              before inviting people or changing tools.
            </p>
          ) : null}
          {context &&
          context.account.setupStatus !== "rates_required" &&
          !context.account.enabled &&
          context.account.lifecycle === "active" &&
          canConfigure ? (
            <form
              method="post"
              className="mt-4 space-y-3 rounded-lg border border-slate-200 p-4"
              onSubmit={(event) => {
                event.preventDefault();
                if (busy || !event.currentTarget.reportValidity()) return;
                const data = new FormData(event.currentTarget);
                void save("enable", { reason: data.get("reason") });
              }}
            >
              <h3 className="font-semibold">
                Approve this existing relationship for partner service
              </h3>
              <p className="text-sm text-slate-600">
                This enables the company only. No person receives access until a
                specific coworker is invited and completes password setup.
              </p>
              <label className="block text-sm font-semibold">
                Relationship confirmation
                <textarea
                  name="reason"
                  required
                  minLength={10}
                  maxLength={1000}
                  className={FIELD}
                />
              </label>
              <button type="submit" disabled={busy !== null} className={BUTTON}>
                Approve company access
              </button>
            </form>
          ) : null}
          {context?.account.enabled &&
          context.account.lifecycle === "active" &&
          canInvite ? (
            <form
              method="post"
              className="mt-6 grid gap-4 border-t border-slate-200 pt-5 sm:grid-cols-2"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                if (busy || !role || !form.reportValidity()) return;
                const data = new FormData(form);
                void save("invite", {
                  accountId: selectedAccount,
                  invitation: {
                    name: data.get("name"),
                    email: data.get("email"),
                    roleKey: role,
                    persona: "other",
                    accessLevel: scoped ? "scoped" : "account",
                    locationIds,
                    costCenterIds,
                  },
                });
              }}
            >
              <h3 className="font-semibold sm:col-span-2">
                Invite a coworker to {context.account.name}
              </h3>
              <label className="text-sm font-semibold">
                Name
                <input
                  name="name"
                  required
                  minLength={2}
                  maxLength={120}
                  className={FIELD}
                />
              </label>
              <label className="text-sm font-semibold">
                Email
                <input
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                  className={FIELD}
                />
              </label>
              <label className="text-sm font-semibold">
                Role
                <select
                  required
                  value={role}
                  onChange={(event) => {
                    setRole(event.target.value);
                    if (event.target.value === "administrator") {
                      setScoped(false);
                      setLocationIds([]);
                      setCostCenterIds([]);
                    }
                  }}
                  className={FIELD}
                >
                  <option value="" disabled>
                    Choose a role
                  </option>
                  {ROLES.map((item) => (
                    <option key={item.key} value={item.key}>
                      {item.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="self-end text-sm leading-6 text-slate-600">
                {ROLES.find((item) => item.key === role)?.help}
              </p>
              {role && role !== "administrator" ? (
                <label className="flex min-h-11 items-center gap-3 text-sm sm:col-span-2">
                  <input
                    type="checkbox"
                    checked={scoped}
                    disabled={
                      !context.locations.length && !context.costCenters.length
                    }
                    onChange={(event) => {
                      setScoped(event.target.checked);
                      if (!event.target.checked) {
                        setLocationIds([]);
                        setCostCenterIds([]);
                      }
                    }}
                    className="h-5 w-5"
                  />
                  Limit access to selected locations or cost centers
                </label>
              ) : null}
              {scoped ? (
                <fieldset className="space-y-2 sm:col-span-2">
                  <legend className="text-sm font-semibold">
                    Choose at least one permitted location or cost center
                  </legend>
                  {context.locations.map((item) => (
                    <label
                      key={item.id}
                      className="flex min-h-11 items-center gap-3 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={locationIds.includes(item.id)}
                        onChange={() =>
                          setLocationIds((values) => toggle(values, item.id))
                        }
                        className="h-5 w-5"
                      />
                      Location: {item.label}
                    </label>
                  ))}
                  {context.costCenters.map((item) => (
                    <label
                      key={item.id}
                      className="flex min-h-11 items-center gap-3 text-sm"
                    >
                      <input
                        type="checkbox"
                        checked={costCenterIds.includes(item.id)}
                        onChange={() =>
                          setCostCenterIds((values) => toggle(values, item.id))
                        }
                        className="h-5 w-5"
                      />
                      Cost center: {item.label}
                    </label>
                  ))}
                </fieldset>
              ) : null}
              <button
                type="submit"
                disabled={
                  busy !== null ||
                  !role ||
                  (scoped && !locationIds.length && !costCenterIds.length)
                }
                className={BUTTON}
              >
                {busy === "invite" ? "Queuing…" : "Send seven-day invitation"}
              </button>
            </form>
          ) : null}
          {context?.account.enabled &&
          context.account.lifecycle === "active" &&
          canConfigure ? (
            <form
              method="post"
              className="mt-6 space-y-4 border-t border-slate-200 pt-5"
              onSubmit={(event) => {
                event.preventDefault();
                if (!busy && context)
                  void save("workflow", {
                    ...context.config,
                    confirmPauseRecurring:
                      new FormData(event.currentTarget).get(
                        "confirmPauseRecurring",
                      ) === "on",
                  });
              }}
            >
              <h3 className="font-semibold">Optional company tools</h3>
              <p className="text-sm leading-6 text-slate-600">
                These controls make tools available. They never add role
                permissions or promise availability.
              </p>
              <div className="grid gap-2 sm:grid-cols-2">
                {TOOLS.map((tool) => (
                  <label
                    key={tool.key}
                    className="flex min-h-11 items-center gap-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={context.config.tools[tool.key]}
                      onChange={(event) =>
                        setContext((current) =>
                          current
                            ? {
                                ...current,
                                config: {
                                  ...current.config,
                                  tools: {
                                    ...current.config.tools,
                                    [tool.key]: event.target.checked,
                                  },
                                },
                              }
                            : current,
                        )
                      }
                      className="h-5 w-5"
                    />
                    {tool.label}
                  </label>
                ))}
              </div>
              <fieldset>
                <legend className="text-sm font-semibold">
                  Services this company may request without a contracted rate
                </legend>
                <p className="mt-1 text-sm leading-6 text-slate-600">
                  These requests go to review unless all confirmation
                  requirements are satisfied.
                </p>
                {context.services.map((service) => (
                  <label
                    key={service.key}
                    className="flex min-h-11 items-center gap-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={context.config.requestableServiceKeys.includes(
                        service.key,
                      )}
                      onChange={() =>
                        setContext((current) =>
                          current
                            ? {
                                ...current,
                                config: {
                                  ...current.config,
                                  requestableServiceKeys: toggle(
                                    current.config.requestableServiceKeys,
                                    service.key,
                                  ),
                                  disabledServiceKeys:
                                    current.config.disabledServiceKeys.filter(
                                      (entry) => entry !== service.key,
                                    ),
                                },
                              }
                            : current,
                        )
                      }
                      className="h-5 w-5"
                    />
                    {service.label}
                  </label>
                ))}
              </fieldset>
              <fieldset>
                <legend className="text-sm font-semibold">
                  Disable services for this company
                </legend>
                {context.services.map((service) => (
                  <label
                    key={service.key}
                    className="flex min-h-11 items-center gap-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      checked={context.config.disabledServiceKeys.includes(
                        service.key,
                      )}
                      onChange={() =>
                        setContext((current) =>
                          current
                            ? {
                                ...current,
                                config: {
                                  ...current.config,
                                  disabledServiceKeys: toggle(
                                    current.config.disabledServiceKeys,
                                    service.key,
                                  ),
                                  requestableServiceKeys:
                                    current.config.requestableServiceKeys.filter(
                                      (entry) => entry !== service.key,
                                    ),
                                },
                              }
                            : current,
                        )
                      }
                      className="h-5 w-5"
                    />
                    {service.label}
                  </label>
                ))}
              </fieldset>
              <label className="flex min-h-11 items-center gap-3 text-sm">
                <input
                  type="checkbox"
                  disabled={!canConfigureBilling}
                  checked={context.config.partialPayments}
                  onChange={(event) =>
                    setContext((current) =>
                      current
                        ? {
                            ...current,
                            config: {
                              ...current.config,
                              partialPayments: event.target.checked,
                            },
                          }
                        : current,
                    )
                  }
                  className="h-5 w-5"
                />
                Allow partner-selected partial invoice payments (commercial
                permission required)
              </label>
              {!context.config.tools.recurring ? (
                <label className="flex min-h-11 items-start gap-3 text-sm leading-6">
                  <input
                    type="checkbox"
                    name="confirmPauseRecurring"
                    className="mt-1 h-5 w-5"
                  />
                  If recurring service was enabled, I confirm that turning it
                  off pauses future tentative work. Already confirmed jobs
                  remain unchanged.
                </label>
              ) : null}
              <button type="submit" disabled={busy !== null} className={BUTTON}>
                {busy === "workflow" ? "Saving…" : "Save company tools"}
              </button>
            </form>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}
