import { randomUUID } from "node:crypto";
import { SubmitButton } from "@/components/SubmitButton";
import Link from "next/link";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  parsePartnerPortalUsersResponse,
  parsePartnerRatesResponse,
  parsePartnersResponse,
  type PartnerPortalUserRow,
  type PartnerRateItem,
  type PartnerRow,
  type PartnersResponse,
} from "../partner-page";
import { teamSurfaceHref } from "../surface-registry";
import {
  outboundSubviewHrefFromReturn,
  parseOutboundReturnHref,
} from "../outbound-navigation";
import {
  openContactThreadAction,
  partnerLogReferralAction,
  partnerLogTouchAction,
  partnerPortalInviteUserAction,
  partnerPortalSaveRatesAction,
  partnerPortalSetUserActiveAction,
  partnerScheduleCheckinAction,
  startContactCallAction,
} from "../actions";
import {
  TEAM_CARD_PADDED,
  TEAM_EMPTY_STATE,
  TEAM_INPUT_COMPACT,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass,
} from "./team-ui";
import { PartnerRatesEditor } from "./PartnerRatesEditor";

type TeamMember = { id: string; name: string; active?: boolean };

type PartnerFilters = {
  status?: string;
  ownerId?: string;
  type?: string;
  q?: string;
  cursor?: string;
  selectedId?: string;
  outboundReturn?: string;
};

function normalizeFilter(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function formatDateTime(value: string | null): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString();
}

function formatDueBadge(nextTouchAt: string | null): {
  label: string;
  tone: string;
} {
  if (!nextTouchAt)
    return { label: "Not scheduled", tone: "bg-slate-100 text-slate-600" };
  const due = new Date(nextTouchAt);
  if (Number.isNaN(due.getTime()))
    return { label: "Scheduled", tone: "bg-slate-100 text-slate-600" };
  const minutes = Math.round((due.getTime() - Date.now()) / 60_000);
  if (minutes < -10)
    return { label: "Overdue", tone: "bg-rose-100 text-rose-700" };
  if (minutes <= 0)
    return { label: "Due now", tone: "bg-amber-100 text-amber-700" };
  if (minutes < 60)
    return { label: `Due in ${minutes}m`, tone: "bg-amber-50 text-amber-700" };
  return { label: "Scheduled", tone: "bg-slate-100 text-slate-600" };
}

function buildPartnersHref(args: {
  filters: PartnerFilters;
  patch?: Partial<PartnerFilters>;
}) {
  const merged: PartnerFilters = { ...args.filters, ...(args.patch ?? {}) };
  const qs = new URLSearchParams();

  const setIf = (key: string, value: string | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    if (!trimmed) return;
    qs.set(key, trimmed);
  };

  setIf("p_status", merged.status);
  setIf("p_owner", merged.ownerId);
  setIf("p_type", merged.type);
  setIf("p_q", merged.q);
  setIf("p_cursor", merged.cursor);
  setIf("p_selected", merged.selectedId);
  const outboundReturn = parseOutboundReturnHref(merged.outboundReturn);
  if (outboundReturn) {
    setIf(
      "out_return",
      String(
        outboundSubviewHrefFromReturn(
          merged.outboundReturn,
          outboundReturn.view,
        ),
      ),
    );
  }
  return teamSurfaceHref("partners", { query: qs });
}

export async function PartnersSection({
  filters,
}: {
  filters?: PartnerFilters;
}): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const canPlaceCalls = hasTeamPermission(principal, "calls.place");
  const canImportOutbound = hasTeamPermission(principal, "outbound.import");
  const canWritePartners = hasTeamPermission(principal, "partners.write");
  const canInvitePartners = hasTeamPermission(principal, "partners.invite");
  const canManagePartnerRates = hasTeamPermission(principal, "partners.rates");
  const resolvedFilters: PartnerFilters = filters ?? {};

  let members: TeamMember[] = [];
  let directoryUnavailable = false;
  try {
    const membersRes = await callAdminApiAs(
      principal,
      "/api/admin/team/directory",
    );
    if (membersRes.ok) {
      const payload = (await membersRes.json()) as { members?: TeamMember[] };
      members = (payload.members ?? []).filter((m) => m.active !== false);
    } else {
      directoryUnavailable = true;
    }
  } catch {
    members = [];
    directoryUnavailable = true;
  }

  const status = normalizeFilter(resolvedFilters.status) || "partner";
  const ownerId = normalizeFilter(resolvedFilters.ownerId);
  const type = normalizeFilter(resolvedFilters.type);
  const q = normalizeFilter(resolvedFilters.q);
  const cursor = normalizeFilter(resolvedFilters.cursor);
  const selectedId = normalizeFilter(resolvedFilters.selectedId);
  const outboundReturnLocation = parseOutboundReturnHref(
    resolvedFilters.outboundReturn,
  );
  const outboundQueueHref = outboundSubviewHrefFromReturn(
    resolvedFilters.outboundReturn,
    "queue",
  );
  const outboundImportHref = outboundSubviewHrefFromReturn(
    resolvedFilters.outboundReturn,
    "import",
  );

  const apiQs = new URLSearchParams({ limit: "50", status });
  if (ownerId) apiQs.set("ownerId", ownerId);
  if (type) apiQs.set("type", type);
  if (q) apiQs.set("q", q);
  if (cursor) apiQs.set("cursor", cursor);

  let payload: PartnersResponse | null = null;
  let partnersError = "";
  let partnerSnapshotChanged = false;
  try {
    const res = await callAdminApiAs(
      principal,
      `/api/admin/partners?${apiQs.toString()}`,
    );
    if (res.ok) {
      const candidate = parsePartnersResponse(await res.json(), {
        limit: 50,
        status,
        ownerId: ownerId || null,
        type: type || null,
      });
      if (candidate) {
        payload = candidate;
      } else {
        partnersError = "The partner list returned an incomplete response.";
      }
    } else {
      partnerSnapshotChanged = res.status === 409;
      partnersError = `The partner list could not be loaded (HTTP ${res.status}).`;
    }
  } catch {
    payload = null;
    partnersError = "The partner list could not be reached.";
  }

  const partners = payload?.partners ?? [];
  const total = payload?.total ?? 0;
  const previousCursor = payload?.page.previousCursor ?? null;
  const nextCursor = payload?.page.nextCursor ?? null;
  const snapshotAt = payload?.page.asOf ?? null;

  let portalUsers: PartnerPortalUserRow[] = [];
  let portalOrganizationStatus: PartnerRow["partnerStatus"] | null = null;
  let portalOrganizationVersion: string | null = null;
  let rateItems: PartnerRateItem[] = [];
  let rateCurrency = "USD";
  let rateVersion = "none";
  let portalUsersError = "";
  let partnerRatesError = "";

  if (selectedId) {
    try {
      const [usersRes, ratesRes] = await Promise.all([
        callAdminApiAs(
          principal,
          `/api/admin/partners/users?orgContactId=${encodeURIComponent(selectedId)}`,
        ),
        callAdminApiAs(
          principal,
          `/api/admin/partners/rates?orgContactId=${encodeURIComponent(selectedId)}`,
        ),
      ]);

      if (usersRes.ok) {
        const usersPayload = parsePartnerPortalUsersResponse(
          await usersRes.json().catch(() => null),
          selectedId,
        );
        if (usersPayload) {
          portalUsers = usersPayload.users;
          portalOrganizationStatus = usersPayload.organization.partnerStatus;
          portalOrganizationVersion = usersPayload.organization.version;
        } else {
          portalUsersError = "Portal users returned an incomplete response.";
        }
      } else {
        portalUsersError = `Portal users could not be loaded (HTTP ${usersRes.status}).`;
      }

      if (ratesRes.ok) {
        const ratesPayload = parsePartnerRatesResponse(
          await ratesRes.json().catch(() => null),
          selectedId,
        );
        if (ratesPayload) {
          rateCurrency = ratesPayload.currency;
          rateVersion = ratesPayload.version;
          rateItems = ratesPayload.items;
        } else {
          partnerRatesError = "Partner rates returned an incomplete response.";
        }
      } else {
        partnerRatesError = `Partner rates could not be loaded (HTTP ${ratesRes.status}).`;
      }
    } catch {
      portalUsersError =
        portalUsersError || "Portal users could not be reached.";
      partnerRatesError =
        partnerRatesError || "Partner rates could not be reached.";
    }
  }
  const portalInviteReady =
    canInvitePartners &&
    !portalUsersError &&
    portalOrganizationStatus === "partner";

  return (
    <section className="space-y-6">
      <nav
        aria-label="Outbound views"
        className="flex flex-wrap gap-2 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-2"
      >
        <Link
          href={outboundQueueHref}
          className="inline-flex min-h-[44px] items-center rounded-xl px-4 py-2 text-sm font-semibold text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)] hover:text-[color:var(--team-text)]"
        >
          Queue
        </Link>
        {canImportOutbound ? (
          <Link
            href={outboundImportHref}
            className="inline-flex min-h-[44px] items-center rounded-xl px-4 py-2 text-sm font-semibold text-[color:var(--team-text-muted)] hover:bg-[color:var(--team-surface-muted)] hover:text-[color:var(--team-text)]"
          >
            Import
          </Link>
        ) : null}
        <Link
          href={buildPartnersHref({ filters: resolvedFilters })}
          aria-current="page"
          className="inline-flex min-h-[44px] items-center rounded-xl bg-primary-50 px-4 py-2 text-sm font-semibold text-primary-800"
        >
          Partners
        </Link>
      </nav>
      <header className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className={TEAM_SECTION_TITLE}>Partners</h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              Manage recurring referral relationships. Partners have a
              lightweight check-in cadence so they don&apos;t get lost in the
              day-to-day inbound lead flow.
            </p>
          </div>
          <div className="text-right text-xs text-[color:var(--team-text-soft)]">
            {total > 0 ? (
              <span>
                Showing {partners.length} from a {total}-partner snapshot
                {snapshotAt ? ` · ${formatDateTime(snapshotAt)}` : ""}
              </span>
            ) : (
              <span>No partners found</span>
            )}
          </div>
        </div>
      </header>

      {directoryUnavailable ? (
        <div
          role="status"
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"
        >
          Team owners are temporarily unavailable. Partner records are still
          shown, but owner names and owner filtering may be limited.
        </div>
      ) : null}

      {partnersError ? (
        <div
          role="alert"
          className="rounded-2xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-900"
        >
          <h3 className="font-semibold">
            Partners are temporarily unavailable
          </h3>
          <p className="mt-1">{partnersError}</p>
          <p className="mt-1">
            This is a load failure, not an empty partner list.
          </p>
          <Link
            className={`${teamButtonClass("secondary", "sm")} mt-4`}
            href={buildPartnersHref({
              filters: resolvedFilters,
              patch: { cursor: "" },
            })}
          >
            {partnerSnapshotChanged ? "Return to first page" : "Retry partners"}
          </Link>
        </div>
      ) : null}

      {selectedId ? (
        <div className={`${TEAM_CARD_PADDED} space-y-6`}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-base font-semibold text-slate-900">
                Partner Portal Access
              </h3>
              <p className="mt-1 text-xs text-slate-500">
                Invite portal users and configure negotiated rates for this
                partner.
              </p>
            </div>
            <Link
              className={teamButtonClass("secondary", "sm")}
              href={buildPartnersHref({
                filters: resolvedFilters,
                patch: { selectedId: "" },
              })}
            >
              Close
            </Link>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4">
              <h4 className="text-sm font-semibold text-[color:var(--team-text)]">
                Invite new user
              </h4>
              <p className="mt-1 text-xs text-[color:var(--team-text-soft)]">
                Requests a magic link by email and optional SMS. Provider
                acceptance does not guarantee final delivery.
              </p>
              {!portalUsersError && portalOrganizationStatus ? (
                <p className="mt-2 text-xs text-[color:var(--team-text-soft)]">
                  Organization status: {portalOrganizationStatus}. Data version:{" "}
                  {portalOrganizationVersion
                    ? formatDateTime(portalOrganizationVersion)
                    : "unknown"}
                  .
                </p>
              ) : null}
              {portalInviteReady ? (
                <form
                  action={partnerPortalInviteUserAction}
                  className="mt-3 space-y-3"
                >
                  <input type="hidden" name="orgContactId" value={selectedId} />
                  <input type="hidden" name="expectedVersion" value="new" />
                  <input
                    type="hidden"
                    name="idempotencyKey"
                    value={`partner-invite:${selectedId}:${randomUUID()}`}
                  />
                  <label className="block">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                      Name
                    </div>
                    <input
                      name="name"
                      required
                      maxLength={200}
                      autoComplete="name"
                      className={TEAM_INPUT_COMPACT}
                      placeholder="Jane Doe"
                    />
                  </label>
                  <label className="block">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                      Email
                    </div>
                    <input
                      name="email"
                      type="email"
                      required
                      maxLength={320}
                      autoComplete="email"
                      className={TEAM_INPUT_COMPACT}
                      placeholder="jane@example.com"
                    />
                  </label>
                  <label className="block">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                      Phone (optional)
                    </div>
                    <input
                      name="phone"
                      type="tel"
                      maxLength={64}
                      autoComplete="tel"
                      className={TEAM_INPUT_COMPACT}
                      placeholder="+1 404-555-1234"
                    />
                  </label>
                  <SubmitButton
                    className={teamButtonClass("primary", "sm")}
                    pendingLabel="Sending..."
                  >
                    Send invite
                  </SubmitButton>
                </form>
              ) : canInvitePartners ? (
                <p className="mt-3 text-xs text-amber-700" role="status">
                  Invites are disabled until this organization is active as a
                  partner and its portal-user state loads successfully.
                </p>
              ) : (
                <p className="mt-3 text-xs text-[color:var(--team-text-soft)]">
                  You can review portal users, but inviting a user requires the
                  Partner Invite permission.
                </p>
              )}

              <div className="mt-4 border-t border-[color:var(--team-border)] pt-4">
                <h5 className="text-xs font-semibold text-[color:var(--team-text-muted)]">
                  Existing users
                </h5>
                {portalUsersError ? (
                  <div
                    role="alert"
                    className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900"
                  >
                    {portalUsersError} Retry this partner workspace before
                    inviting or reviewing users.
                  </div>
                ) : portalUsers.length === 0 ? (
                  <div className="mt-2 text-xs text-[color:var(--team-text-soft)]">
                    No portal users yet.
                  </div>
                ) : (
                  <ul className="mt-2 space-y-2 text-xs text-[color:var(--team-text-muted)]">
                    {portalUsers.map((user) => (
                      <li
                        key={user.id}
                        className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] px-3 py-2"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <div className="font-semibold text-[color:var(--team-text)]">
                            {user.name}
                          </div>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
                              user.active
                                ? "bg-emerald-50 text-emerald-700"
                                : "bg-slate-100 text-slate-600"
                            }`}
                          >
                            {user.active ? "active" : "inactive"}
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] text-[color:var(--team-text-soft)]">
                          {user.email}
                        </div>
                        {user.phoneE164 || user.phone ? (
                          <div className="mt-1 text-[11px] text-[color:var(--team-text-soft)]">
                            {user.phoneE164 ?? user.phone}
                          </div>
                        ) : null}
                        <div className="mt-1 text-[11px] text-[color:var(--team-text-soft)]">
                          Password:{" "}
                          {user.passwordSetAt
                            ? `set (${formatDateTime(user.passwordSetAt)})`
                            : "not set"}
                        </div>
                        {canInvitePartners &&
                        portalOrganizationStatus === "partner" &&
                        user.active ? (
                          <form
                            action={partnerPortalInviteUserAction}
                            className="mt-3"
                          >
                            <input
                              type="hidden"
                              name="orgContactId"
                              value={selectedId}
                            />
                            <input
                              type="hidden"
                              name="name"
                              value={user.name}
                            />
                            <input
                              type="hidden"
                              name="email"
                              value={user.email}
                            />
                            <input
                              type="hidden"
                              name="phone"
                              value={user.phoneE164 ?? user.phone ?? ""}
                            />
                            <input
                              type="hidden"
                              name="expectedVersion"
                              value={user.updatedAt}
                            />
                            <input
                              type="hidden"
                              name="idempotencyKey"
                              value={`partner-invite:${user.id}:${randomUUID()}`}
                            />
                            <SubmitButton
                              className={teamButtonClass("secondary", "sm")}
                              pendingLabel="Sending..."
                            >
                              Send fresh login link
                            </SubmitButton>
                          </form>
                        ) : null}
                        {canInvitePartners &&
                        portalOrganizationStatus === "partner" ? (
                          user.active ? (
                            <details className="mt-3 rounded-xl border border-rose-200 bg-rose-50/70 p-3">
                              <summary className="min-h-[44px] cursor-pointer py-2 text-[11px] font-semibold text-rose-800">
                                Disable portal access
                              </summary>
                              <p className="mt-1 text-[11px] text-rose-800">
                                This immediately revokes active sessions and
                                unused login links. It does not delete the user.
                              </p>
                              <form
                                action={partnerPortalSetUserActiveAction}
                                className="mt-3 space-y-2"
                              >
                                <input
                                  type="hidden"
                                  name="orgContactId"
                                  value={selectedId}
                                />
                                <input
                                  type="hidden"
                                  name="userId"
                                  value={user.id}
                                />
                                <input
                                  type="hidden"
                                  name="active"
                                  value="false"
                                />
                                <input
                                  type="hidden"
                                  name="expectedVersion"
                                  value={user.updatedAt}
                                />
                                <input
                                  type="hidden"
                                  name="idempotencyKey"
                                  value={`partner-user-access:${user.id}:${randomUUID()}`}
                                />
                                <label className="block text-[11px] text-rose-900">
                                  <span className="font-semibold">
                                    Type DEACTIVATE
                                  </span>
                                  <input
                                    name="confirmation"
                                    required
                                    autoComplete="off"
                                    className="mt-1 min-h-[44px] w-full rounded-xl border border-rose-200 bg-white px-3 py-2 text-xs text-slate-800"
                                  />
                                </label>
                                <SubmitButton
                                  className="min-h-[44px] rounded-xl bg-rose-600 px-4 py-2 text-xs font-semibold text-white hover:bg-rose-700"
                                  pendingLabel="Disabling..."
                                >
                                  Disable access
                                </SubmitButton>
                              </form>
                            </details>
                          ) : (
                            <form
                              action={partnerPortalSetUserActiveAction}
                              className="mt-3 rounded-xl border border-emerald-200 bg-emerald-50/70 p-3"
                            >
                              <input
                                type="hidden"
                                name="orgContactId"
                                value={selectedId}
                              />
                              <input
                                type="hidden"
                                name="userId"
                                value={user.id}
                              />
                              <input type="hidden" name="active" value="true" />
                              <input
                                type="hidden"
                                name="confirmation"
                                value="ACTIVATE"
                              />
                              <input
                                type="hidden"
                                name="expectedVersion"
                                value={user.updatedAt}
                              />
                              <input
                                type="hidden"
                                name="idempotencyKey"
                                value={`partner-user-access:${user.id}:${randomUUID()}`}
                              />
                              <p className="text-[11px] text-emerald-900">
                                Activating allows an existing password to work
                                again. Old sessions and links stay revoked.
                              </p>
                              <SubmitButton
                                className="mt-2 min-h-[44px] rounded-xl bg-emerald-700 px-4 py-2 text-xs font-semibold text-white hover:bg-emerald-800"
                                pendingLabel="Activating..."
                              >
                                Activate portal user
                              </SubmitButton>
                            </form>
                          )
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-4">
              <h4 className="text-sm font-semibold text-slate-900">
                Partner rates
              </h4>
              <p className="mt-1 text-xs text-slate-500">
                Explicit dollar tiers per service (currency: {rateCurrency}).
                Exact service and tier matches win. A missing tier has no quoted
                amount. Saving replaces the complete negotiated rate card.
              </p>

              {partnerRatesError ? (
                <div
                  role="alert"
                  className="mt-3 rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900"
                >
                  {partnerRatesError} Existing negotiated prices are unknown;
                  saving is disabled until they reload.
                </div>
              ) : rateItems.length ? (
                <div className="mt-3 rounded-xl border border-slate-100 bg-slate-50 px-3 py-2 text-xs text-slate-700">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Current
                  </div>
                  <ul className="mt-2 space-y-1">
                    {rateItems.map((item) => (
                      <li key={item.id}>
                        <span className="font-semibold">{item.serviceKey}</span>{" "}
                        / {item.tierKey}
                        {" - "}
                        {item.label ? `${item.label} - ` : ""}$
                        {(item.amountCents / 100).toFixed(2)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : (
                <div className="mt-3 text-xs text-slate-500">
                  No negotiated rates set yet.
                </div>
              )}

              {canManagePartnerRates ? (
                <form
                  action={partnerPortalSaveRatesAction}
                  className="mt-3 space-y-3"
                >
                  <input type="hidden" name="orgContactId" value={selectedId} />
                  <input
                    type="hidden"
                    name="expectedVersion"
                    value={rateVersion}
                  />
                  <input
                    type="hidden"
                    name="idempotencyKey"
                    value={`partner-rates:${selectedId}:${randomUUID()}`}
                  />
                  <PartnerRatesEditor
                    currency={rateCurrency}
                    initialItems={rateItems}
                  />
                  <SubmitButton
                    className={teamButtonClass("primary", "sm")}
                    pendingLabel="Saving..."
                    disabled={Boolean(partnerRatesError)}
                  >
                    Save rates
                  </SubmitButton>
                </form>
              ) : (
                <p className="mt-3 text-xs text-slate-500">
                  Rates are view-only. Editing requires the Partner Rates
                  permission.
                </p>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className={TEAM_CARD_PADDED}>
        <form
          method="get"
          action="/team/sales/outbound/partners"
          className="grid gap-3 rounded-2xl border border-slate-200 bg-white p-4"
        >
          {outboundReturnLocation ? (
            <input
              type="hidden"
              name="out_return"
              value={String(
                outboundSubviewHrefFromReturn(
                  resolvedFilters.outboundReturn,
                  outboundReturnLocation.view,
                ),
              )}
            />
          ) : null}
          {selectedId ? (
            <input type="hidden" name="p_selected" value={selectedId} />
          ) : null}

          <div className="grid gap-3 md:grid-cols-4">
            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                Status
              </span>
              <select
                name="p_status"
                defaultValue={status}
                className={TEAM_INPUT_COMPACT}
              >
                <option value="partner">Partner</option>
                <option value="prospect">Prospect</option>
                <option value="contacted">Contacted</option>
                <option value="inactive">Inactive</option>
                <option value="none">None</option>
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                Owner
              </span>
              <select
                name="p_owner"
                defaultValue={ownerId}
                className={TEAM_INPUT_COMPACT}
              >
                <option value="">Any owner</option>
                {members.map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                Type
              </span>
              <input
                name="p_type"
                defaultValue={type}
                className={TEAM_INPUT_COMPACT}
                placeholder="property_manager"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs text-slate-600">
              <span className="font-semibold uppercase tracking-[0.18em] text-slate-500">
                Search
              </span>
              <input
                name="p_q"
                defaultValue={q}
                className={TEAM_INPUT_COMPACT}
                placeholder="Company, name, phone..."
              />
            </label>
          </div>

          <div className="flex flex-wrap gap-2">
            <SubmitButton
              className={teamButtonClass("primary", "sm")}
              pendingLabel="Loading..."
            >
              Apply filters
            </SubmitButton>
            <Link
              className={teamButtonClass("secondary", "sm")}
              href={buildPartnersHref({
                filters: {
                  outboundReturn: resolvedFilters.outboundReturn,
                },
              })}
            >
              Reset
            </Link>
          </div>
        </form>

        {partnersError ? null : partners.length === 0 ? (
          <div className={TEAM_EMPTY_STATE}>
            No partners match these filters yet.
          </div>
        ) : (
          <>
            <div className="mt-4 space-y-3 lg:hidden">
              {partners.map((partner) => {
                const dueBadge = formatDueBadge(partner.partnerNextTouchAt);
                const ownerLabel = partner.partnerOwnerName ?? "Unassigned";
                const companyLine = partner.company
                  ? `${partner.company} • `
                  : "";
                const contactLine = `${companyLine}${partner.name}`;
                const detailBits = [partner.phone, partner.email]
                  .filter(Boolean)
                  .join(" • ");
                return (
                  <article
                    key={partner.id}
                    className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold ${dueBadge.tone}`}
                      >
                        {dueBadge.label}
                      </span>
                      <span className="rounded-full bg-slate-100 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                        {partner.partnerStatus}
                      </span>
                      {partner.partnerType ? (
                        <span className="rounded-full bg-primary-50 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-primary-700">
                          {partner.partnerType}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-3 text-sm font-semibold text-slate-900">
                      {contactLine}
                    </div>
                    {detailBits ? (
                      <div className="mt-1 text-xs text-slate-600">
                        {detailBits}
                      </div>
                    ) : null}
                    <div className="mt-3 grid grid-cols-2 gap-3 text-xs text-slate-600">
                      <div>
                        <div className="font-semibold uppercase tracking-wide text-slate-500">
                          Owner
                        </div>
                        <div className="mt-1 text-sm text-slate-900">
                          {ownerLabel}
                        </div>
                      </div>
                      <div>
                        <div className="font-semibold uppercase tracking-wide text-slate-500">
                          Referrals
                        </div>
                        <div className="mt-1 text-sm text-slate-900">
                          {partner.partnerReferralCount ?? 0}
                        </div>
                      </div>
                    </div>
                    {partner.partnerNextTouchAt ? (
                      <div className="mt-3 text-xs text-slate-500">
                        Next touch {formatDateTime(partner.partnerNextTouchAt)}
                      </div>
                    ) : null}
                    {partner.partnerLastTouchAt ? (
                      <div className="mt-1 text-xs text-slate-500">
                        Last touch {formatDateTime(partner.partnerLastTouchAt)}
                      </div>
                    ) : null}
                    {partner.partnerLastReferralAt ? (
                      <div className="mt-1 text-xs text-slate-500">
                        Last referral{" "}
                        {formatDateTime(partner.partnerLastReferralAt)}
                      </div>
                    ) : null}
                    <div className="mt-4 flex flex-wrap gap-2">
                      <Link
                        className={teamButtonClass("secondary", "sm")}
                        href={buildPartnersHref({
                          filters: resolvedFilters,
                          patch: { selectedId: partner.id },
                        })}
                      >
                        Portal
                      </Link>
                      {canPlaceCalls ? (
                        <form action={startContactCallAction}>
                          <input
                            type="hidden"
                            name="contactId"
                            value={partner.id}
                          />
                          <input
                            type="hidden"
                            name="idempotencyKey"
                            value={`team-call:${randomUUID()}`}
                          />
                          <input
                            type="hidden"
                            name="explicitNewAttempt"
                            value="START NEW CALL"
                          />
                          <SubmitButton
                            className={teamButtonClass("primary", "sm")}
                            pendingLabel="Calling..."
                          >
                            Call
                          </SubmitButton>
                        </form>
                      ) : null}
                      <form action={openContactThreadAction}>
                        <input
                          type="hidden"
                          name="contactId"
                          value={partner.id}
                        />
                        <input
                          type="hidden"
                          name="channel"
                          value={partner.email ? "email" : "sms"}
                        />
                        <SubmitButton
                          className={teamButtonClass("secondary", "sm")}
                          pendingLabel="Opening..."
                        >
                          Message
                        </SubmitButton>
                      </form>
                      {canWritePartners ? (
                        <>
                          <form action={partnerLogReferralAction}>
                            <input
                              type="hidden"
                              name="contactId"
                              value={partner.id}
                            />
                            <input
                              type="hidden"
                              name="expectedVersion"
                              value={partner.version}
                            />
                            <input
                              type="hidden"
                              name="idempotencyKey"
                              value={`partner-referral:${randomUUID()}`}
                            />
                            <SubmitButton
                              className={teamButtonClass("secondary", "sm")}
                              pendingLabel="Saving..."
                            >
                              + Referral
                            </SubmitButton>
                          </form>
                          <form action={partnerLogTouchAction}>
                            <input
                              type="hidden"
                              name="contactId"
                              value={partner.id}
                            />
                            <input
                              type="hidden"
                              name="expectedVersion"
                              value={partner.version}
                            />
                            <input
                              type="hidden"
                              name="idempotencyKey"
                              value={`partner-touch:${randomUUID()}`}
                            />
                            <input
                              type="hidden"
                              name="nextTouchDays"
                              value="30"
                            />
                            <SubmitButton
                              className={teamButtonClass("secondary", "sm")}
                              pendingLabel="Saving..."
                            >
                              Log touch
                            </SubmitButton>
                          </form>
                          <form action={partnerScheduleCheckinAction}>
                            <input
                              type="hidden"
                              name="contactId"
                              value={partner.id}
                            />
                            <input
                              type="hidden"
                              name="expectedVersion"
                              value={partner.version}
                            />
                            <input
                              type="hidden"
                              name="idempotencyKey"
                              value={`partner-checkin:${randomUUID()}`}
                            />
                            <input type="hidden" name="daysFromNow" value="7" />
                            <SubmitButton
                              className={teamButtonClass("secondary", "sm")}
                              pendingLabel="Scheduling..."
                            >
                              Check-in 7d
                            </SubmitButton>
                          </form>
                        </>
                      ) : null}
                      <Link
                        className={teamButtonClass("secondary", "sm")}
                        href={teamSurfaceHref("contacts", {
                          query: { contactId: partner.id },
                        })}
                      >
                        Open
                      </Link>
                    </div>
                  </article>
                );
              })}
            </div>

            <div className="mt-4 hidden overflow-x-auto rounded-2xl border border-slate-200 bg-white lg:block">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-50 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500">
                  <tr>
                    <th className="px-4 py-3 text-left">Next</th>
                    <th className="px-4 py-3 text-left">Partner</th>
                    <th className="px-4 py-3 text-left">Owner</th>
                    <th className="px-4 py-3 text-left">Referrals</th>
                    <th className="px-4 py-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {partners.map((partner) => {
                    const dueBadge = formatDueBadge(partner.partnerNextTouchAt);
                    const ownerLabel = partner.partnerOwnerName ?? "Unassigned";
                    const companyLine = partner.company
                      ? `${partner.company} • `
                      : "";
                    const contactLine = `${companyLine}${partner.name}`;
                    const detailBits = [partner.phone, partner.email]
                      .filter(Boolean)
                      .join(" • ");
                    return (
                      <tr key={partner.id} className="hover:bg-slate-50">
                        <td className="px-4 py-4 align-top">
                          <span
                            className={`inline-flex items-center rounded-full px-3 py-1 text-[11px] font-semibold ${dueBadge.tone}`}
                          >
                            {dueBadge.label}
                          </span>
                          {partner.partnerNextTouchAt ? (
                            <div className="mt-2 text-xs text-slate-500">
                              {formatDateTime(partner.partnerNextTouchAt)}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-4 py-4 align-top">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-semibold text-slate-900">
                              {contactLine}
                            </span>
                            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                              {partner.partnerStatus}
                            </span>
                            {partner.partnerType ? (
                              <span className="rounded-full bg-primary-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary-700">
                                {partner.partnerType}
                              </span>
                            ) : null}
                          </div>
                          {detailBits ? (
                            <div className="mt-2 text-xs text-slate-600">
                              {detailBits}
                            </div>
                          ) : null}
                          {partner.partnerLastTouchAt ? (
                            <div className="mt-1 text-[11px] text-slate-500">
                              Last touch:{" "}
                              {formatDateTime(partner.partnerLastTouchAt)}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-4 py-4 align-top text-xs text-slate-700">
                          <div className="font-semibold text-slate-900">
                            {ownerLabel}
                          </div>
                          {partner.partnerSince ? (
                            <div className="mt-1 text-[11px] text-slate-500">
                              Partner since{" "}
                              {formatDateTime(partner.partnerSince)}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-4 py-4 align-top text-xs text-slate-700">
                          <div className="text-sm font-semibold text-slate-900">
                            {partner.partnerReferralCount ?? 0}
                          </div>
                          {partner.partnerLastReferralAt ? (
                            <div className="mt-1 text-[11px] text-slate-500">
                              Last referral{" "}
                              {formatDateTime(partner.partnerLastReferralAt)}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-4 py-4 align-top text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            <Link
                              className={teamButtonClass("secondary", "sm")}
                              href={buildPartnersHref({
                                filters: resolvedFilters,
                                patch: { selectedId: partner.id },
                              })}
                            >
                              Portal
                            </Link>
                            {canPlaceCalls ? (
                              <form action={startContactCallAction}>
                                <input
                                  type="hidden"
                                  name="contactId"
                                  value={partner.id}
                                />
                                <input
                                  type="hidden"
                                  name="idempotencyKey"
                                  value={`team-call:${randomUUID()}`}
                                />
                                <input
                                  type="hidden"
                                  name="explicitNewAttempt"
                                  value="START NEW CALL"
                                />
                                <SubmitButton
                                  className={teamButtonClass("primary", "sm")}
                                  pendingLabel="Calling..."
                                >
                                  Call
                                </SubmitButton>
                              </form>
                            ) : null}
                            <form action={openContactThreadAction}>
                              <input
                                type="hidden"
                                name="contactId"
                                value={partner.id}
                              />
                              <input
                                type="hidden"
                                name="channel"
                                value={partner.email ? "email" : "sms"}
                              />
                              <SubmitButton
                                className={teamButtonClass("secondary", "sm")}
                                pendingLabel="Opening..."
                              >
                                Message
                              </SubmitButton>
                            </form>
                            {canWritePartners ? (
                              <>
                                <form action={partnerLogReferralAction}>
                                  <input
                                    type="hidden"
                                    name="contactId"
                                    value={partner.id}
                                  />
                                  <input
                                    type="hidden"
                                    name="expectedVersion"
                                    value={partner.version}
                                  />
                                  <input
                                    type="hidden"
                                    name="idempotencyKey"
                                    value={`partner-referral:${randomUUID()}`}
                                  />
                                  <SubmitButton
                                    className={teamButtonClass(
                                      "secondary",
                                      "sm",
                                    )}
                                    pendingLabel="Saving..."
                                  >
                                    + Referral
                                  </SubmitButton>
                                </form>
                                <form action={partnerLogTouchAction}>
                                  <input
                                    type="hidden"
                                    name="contactId"
                                    value={partner.id}
                                  />
                                  <input
                                    type="hidden"
                                    name="expectedVersion"
                                    value={partner.version}
                                  />
                                  <input
                                    type="hidden"
                                    name="idempotencyKey"
                                    value={`partner-touch:${randomUUID()}`}
                                  />
                                  <input
                                    type="hidden"
                                    name="nextTouchDays"
                                    value="30"
                                  />
                                  <SubmitButton
                                    className={teamButtonClass(
                                      "secondary",
                                      "sm",
                                    )}
                                    pendingLabel="Saving..."
                                  >
                                    Log touch
                                  </SubmitButton>
                                </form>
                                <form action={partnerScheduleCheckinAction}>
                                  <input
                                    type="hidden"
                                    name="contactId"
                                    value={partner.id}
                                  />
                                  <input
                                    type="hidden"
                                    name="expectedVersion"
                                    value={partner.version}
                                  />
                                  <input
                                    type="hidden"
                                    name="idempotencyKey"
                                    value={`partner-checkin:${randomUUID()}`}
                                  />
                                  <input
                                    type="hidden"
                                    name="daysFromNow"
                                    value="7"
                                  />
                                  <SubmitButton
                                    className={teamButtonClass(
                                      "secondary",
                                      "sm",
                                    )}
                                    pendingLabel="Scheduling..."
                                  >
                                    Check-in 7d
                                  </SubmitButton>
                                </form>
                              </>
                            ) : null}
                            <Link
                              className={teamButtonClass("secondary", "sm")}
                              href={teamSurfaceHref("contacts", {
                                query: { contactId: partner.id },
                              })}
                            >
                              Open
                            </Link>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="mt-4 flex items-center justify-between text-xs text-slate-600">
          <div className="flex items-center gap-2">
            {previousCursor ? (
              <Link
                className={teamButtonClass("secondary", "sm")}
                href={buildPartnersHref({
                  filters: resolvedFilters,
                  patch: { cursor: previousCursor },
                })}
              >
                Previous
              </Link>
            ) : (
              <span className="inline-flex min-h-[44px] items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-2 font-semibold text-slate-400">
                Previous
              </span>
            )}
            {nextCursor ? (
              <Link
                className={teamButtonClass("secondary", "sm")}
                href={buildPartnersHref({
                  filters: resolvedFilters,
                  patch: { cursor: nextCursor },
                })}
              >
                Next
              </Link>
            ) : (
              <span className="inline-flex min-h-[44px] items-center rounded-full border border-slate-200 bg-slate-50 px-3 py-2 font-semibold text-slate-400">
                Next
              </span>
            )}
          </div>
          <span className="text-[11px] text-slate-500">
            Tip: use &quot;Log touch&quot; after a call/email so the check-in
            cadence stays accurate.
          </span>
        </div>
      </div>
    </section>
  );
}
