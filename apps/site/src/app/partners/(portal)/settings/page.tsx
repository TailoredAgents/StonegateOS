import type { Metadata, Route } from "next";
import Link from "next/link";
import {
  KeyRound,
  Mail,
  ShieldCheck,
  UserRound,
  UsersRound,
} from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import { PartnerAccountProfileManager } from "@/app/partners/components/PartnerAccountProfileManager";
import { PartnerAccountSecurityManager } from "@/app/partners/components/PartnerAccountSecurityManager";
import {
  PartnerErrorState,
  PartnerNotice,
  PartnerPageHeader,
  PartnerPanel,
  partnerErrorMessage,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";
import { PartnerPasswordForm } from "@/app/partners/components/PartnerPasswordForm";
import { PartnerEmailChangeForm } from "@/app/partners/components/PartnerEmailChangeForm";
import { PartnerPersonalProfileManager } from "@/app/partners/components/PartnerPersonalProfileManager";
import { PartnerProofDefaultsManager } from "@/app/partners/components/PartnerProofDefaultsManager";
import { getPartnerPortalContext } from "../../lib/portal-context";
import {
  loadPartnerPortalResource,
  portalLoadErrorMessage,
} from "../../lib/portal-load";
import {
  parsePortalSettings,
  parsePortalSessions,
  parsePortalPreferences,
  parsePortalProofDefaults,
  parsePortalAccountProfile,
  parsePortalPersonalProfile,
  parsePortalSmsEndpoints,
} from "../../lib/portal-settings-load";

export const metadata: Metadata = { title: "Settings" };

export default async function PartnerSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ saved?: string; error?: string; view?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const companyView = params.view === "company";
  const saved = params.saved === "1";
  const error =
    typeof params.error === "string" && params.error.trim().length
      ? params.error.trim()
      : null;
  const errorMessage = partnerErrorMessage(
    error,
    "We couldn’t save that password. Try again.",
  );

  const context = await getPartnerPortalContext();
  if (context.status !== "authenticated") return null;
  const canReadCompany = context.availability.reads && companyView;
  const [
    meResult,
    sessionsResult,
    preferencesResult,
    smsResult,
    proofResult,
    accountResult,
    personalResult,
  ] = await Promise.all([
    loadPartnerPortalResource(
      () => callPartnerApi("/api/portal/v2/me"),
      parsePortalSettings,
    ),
    !companyView
      ? loadPartnerPortalResource(
          () => callPartnerApi("/api/portal/v2/sessions"),
          parsePortalSessions,
        )
      : null,
    !companyView
      ? loadPartnerPortalResource(
          () => callPartnerApi("/api/portal/v2/notification-preferences"),
          parsePortalPreferences,
        )
      : null,
    !companyView
      ? loadPartnerPortalResource(
          () => callPartnerApi("/api/portal/v2/notification-endpoints"),
          parsePortalSmsEndpoints,
        )
      : null,
    canReadCompany
      ? loadPartnerPortalResource(
          () => callPartnerApi("/api/portal/v2/proof-requirements"),
          parsePortalProofDefaults,
        )
      : null,
    canReadCompany
      ? loadPartnerPortalResource(
          () => callPartnerApi("/api/portal/v2/account-profile"),
          parsePortalAccountProfile,
        )
      : null,
    !companyView && context.availability.reads
      ? loadPartnerPortalResource(
          () => callPartnerApi("/api/portal/v2/personal-profile"),
          parsePortalPersonalProfile,
        )
      : null,
  ]);
  if (meResult.status === "error")
    return (
      <PartnerErrorState
        title="We couldn’t load account settings"
        description={portalLoadErrorMessage(
          meResult,
          "Try again to view your settings.",
        )}
        retryHref="/partners/settings"
      />
    );
  const payload = meResult.value;
  const sessionsPayload =
    sessionsResult?.status === "ok" ? sessionsResult.value : null;
  const preferencesPayload =
    preferencesResult?.status === "ok" ? preferencesResult.value : null;
  const proofDefaultsPayload =
    proofResult?.status === "ok" ? proofResult.value : null;
  const accountProfilePayload =
    accountResult?.status === "ok" ? accountResult.value : null;
  const personalProfilePayload =
    personalResult?.status === "ok" ? personalResult.value : null;
  const smsEndpoints = smsResult?.status === "ok" ? smsResult.value : null;
  const sectionErrors = [
    ["Devices", sessionsResult],
    ["Update preferences", preferencesResult],
    ["Text message settings", smsResult],
    ["Photo preferences", proofResult],
    ["Company profile", accountResult],
    ["Personal profile", personalResult],
  ] as const;
  const passwordSet = Boolean(payload.partnerUser.passwordSet);
  const userName = payload.partnerUser.name?.trim() || "Partner user";
  const userEmail = payload.partnerUser.email?.trim() || "Email unavailable";
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  const canReadMembers = payload.membership.capabilities?.includes(
    "account.members.read",
  );
  const canManageSmsEndpoints = payload.membership.capabilities?.includes(
    "portal.session.read",
  );
  const canManageProofDefaults =
    context.availability.writes &&
    payload.membership.capabilities?.includes("account.update");

  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        title={companyView ? "Company settings" : "Personal settings"}
        description={
          companyView
            ? "Company details, teammates, and photo preferences."
            : "Your details, password, devices, and updates."
        }
        breadcrumbs={[
          { label: "Home", href: "/partners/overview" },
          { label: "Settings", href: "/partners/settings" },
        ]}
        actions={
          companyView && context.availability.reads && canReadMembers ? (
            <Link
              href={"/partners/settings/team" as Route}
              className={partnerSecondaryButtonClass}
            >
              <UsersRound className="h-4 w-4" aria-hidden="true" />
              Manage team access
            </Link>
          ) : undefined
        }
      >
        {saved ? (
          <PartnerNotice tone="success">
            Password saved successfully.
          </PartnerNotice>
        ) : null}
        {errorMessage ? (
          <PartnerNotice tone="error" className={saved ? "mt-3" : undefined}>
            {errorMessage}
          </PartnerNotice>
        ) : null}
      </PartnerPageHeader>

      <nav
        aria-label="Settings"
        className="flex flex-wrap gap-3 border-b border-slate-200 pb-3"
      >
        <Link
          href="/partners/settings"
          aria-current={!companyView ? "page" : undefined}
          className={partnerSecondaryButtonClass}
        >
          Personal settings
        </Link>
        <Link
          href={"/partners/settings?view=company" as Route}
          aria-current={companyView ? "page" : undefined}
          className={partnerSecondaryButtonClass}
        >
          Company settings
        </Link>
      </nav>
      {payload.membership.capabilities?.includes("bookings.create") ? (
        <Link
          href={"/partners/tools" as Route}
          className="inline-flex min-h-11 items-center text-sm font-semibold text-primary-800 underline"
        >
          Saved templates, recurring service & import history
        </Link>
      ) : null}

      {sectionErrors.map(([label, result]) =>
        result?.status === "error" ? (
          <PartnerErrorState
            key={label}
            title={`${label} could not be loaded`}
            description={portalLoadErrorMessage(
              result,
              "Try again to see these settings.",
            )}
            retryHref={
              companyView
                ? "/partners/settings?view=company"
                : "/partners/settings"
            }
          />
        ) : null,
      )}
      {companyView && !context.availability.reads ? (
        <PartnerNotice tone="info">
          Company settings are temporarily unavailable. Your sign-in and device
          settings are still available under Personal settings.
        </PartnerNotice>
      ) : null}
      {!companyView ? (
        <>
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
            <PartnerPanel>
              <div className="flex items-center gap-3">
                <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
                  <UserRound className="h-6 w-6" aria-hidden="true" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-lg font-semibold text-slate-950 [overflow-wrap:anywhere]">
                    {userName}
                  </h2>
                  <p className="mt-0.5 text-sm text-slate-600 [overflow-wrap:anywhere]">
                    {payload.membership.roleKey.replaceAll("_", " ")} ·{" "}
                    {payload.account.name}
                  </p>
                </div>
              </div>
              <dl className="mt-6 space-y-4 border-t border-slate-200 pt-5">
                <div>
                  <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                    <Mail className="h-4 w-4" aria-hidden="true" />
                    Sign-in email
                  </dt>
                  <dd className="mt-1 break-all text-sm font-medium text-slate-900">
                    {userEmail}
                  </dd>
                </div>
                <div>
                  <dt className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.12em] text-slate-500">
                    <ShieldCheck className="h-4 w-4" aria-hidden="true" />
                    Portal access
                  </dt>
                  <dd className="mt-1 text-sm font-medium text-emerald-800">
                    Active
                  </dd>
                </div>
              </dl>
            </PartnerPanel>

            <PartnerPanel>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <KeyRound
                      className="h-5 w-5 text-primary-700"
                      aria-hidden="true"
                    />
                    <h2 className="text-lg font-semibold text-slate-950">
                      Sign-in password
                    </h2>
                  </div>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-slate-600">
                    {passwordSet
                      ? "Change your password here. Saving signs out every other portal session; this device stays signed in."
                      : "Create your password here. If your security check is no longer recent, you’ll be asked to verify again. Saving signs out every other device."}
                  </p>
                </div>
                <span
                  className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset ${
                    passwordSet
                      ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
                      : "bg-slate-100 text-slate-700 ring-slate-200"
                  }`}
                >
                  {passwordSet ? "Password set" : "Not set"}
                </span>
              </div>
              <PartnerPasswordForm passwordSet={passwordSet} />
            </PartnerPanel>
          </div>

          {personalProfilePayload ? (
            <fieldset disabled={!context.availability.writes}>
              <PartnerPersonalProfileManager
                initialProfile={personalProfilePayload.profile}
                initialEtag={
                  personalResult?.status === "ok"
                    ? personalResult.response.headers.get("etag")
                    : null
                }
              />
            </fieldset>
          ) : null}

          <PartnerEmailChangeForm
            currentEmail={userEmail}
            passwordSet={passwordSet}
          />

          <PartnerAccountSecurityManager
            accounts={accounts}
            sessions={sessionsPayload?.sessions ?? null}
            sessionsEtag={
              sessionsResult?.status === "ok"
                ? sessionsResult.response.headers.get("etag")
                : null
            }
            preferences={preferencesPayload?.preferences ?? null}
            smsEndpoints={smsEndpoints}
            canManageSmsEndpoints={Boolean(canManageSmsEndpoints)}
          />
        </>
      ) : (
        <>
          {accountProfilePayload ? (
            <PartnerAccountProfileManager
              initialProfile={{
                ...accountProfilePayload.profile,
                permissions: {
                  ...accountProfilePayload.profile.permissions,
                  canEditOrganization:
                    context.availability.writes &&
                    accountProfilePayload.profile.permissions
                      .canEditOrganization,
                  canEditBilling:
                    context.availability.writes &&
                    accountProfilePayload.profile.permissions.canEditBilling,
                },
              }}
              initialEtag={
                accountResult?.status === "ok"
                  ? accountResult.response.headers.get("etag")
                  : null
              }
            />
          ) : null}

          {proofDefaultsPayload?.ok ? (
            <PartnerProofDefaultsManager
              requirements={proofDefaultsPayload.requirements}
              etag={
                proofResult?.status === "ok"
                  ? (proofResult.response.headers.get("etag") ?? "")
                  : ""
              }
              canEdit={Boolean(canManageProofDefaults)}
            />
          ) : null}
        </>
      )}
    </div>
  );
}
