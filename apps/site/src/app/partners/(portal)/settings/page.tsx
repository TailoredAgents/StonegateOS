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
import {
  PartnerAccountProfileManager,
  type PartnerAccountProfile,
} from "@/app/partners/components/PartnerAccountProfileManager";
import {
  PartnerAccountSecurityManager,
  type PartnerSettingsAccount,
  type PartnerSettingsPreference,
  type PartnerSettingsSession,
} from "@/app/partners/components/PartnerAccountSecurityManager";
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
import {
  PartnerPersonalProfileManager,
  type PartnerPersonalProfile,
} from "@/app/partners/components/PartnerPersonalProfileManager";
import {
  PartnerProofDefaultsManager,
  type PartnerProofDefault,
} from "@/app/partners/components/PartnerProofDefaultsManager";
import { parsePartnerSmsEndpoints } from "@/app/partners/lib/notification-endpoints";

export const metadata: Metadata = { title: "Account, updates & security" };

type MePayload = {
  ok: true;
  partnerUser: {
    email: string;
    name: string;
    passwordSet?: boolean;
  };
  account: { id: string; name: string; status: string };
  membership: {
    id: string;
    roleKey: string;
    accessLevel: string;
    capabilities?: string[];
  };
  accounts: PartnerSettingsAccount[];
};

async function readJson<T>(response: Response | null): Promise<T | null> {
  if (!response?.ok) return null;
  return (await response.json().catch(() => null)) as T | null;
}

export default async function PartnerSettingsPage({
  searchParams,
}: {
  searchParams?: Promise<{ saved?: string; error?: string }>;
}) {
  const params = (await searchParams) ?? {};
  const saved = params.saved === "1";
  const error =
    typeof params.error === "string" && params.error.trim().length
      ? params.error.trim()
      : null;
  const errorMessage = partnerErrorMessage(
    error,
    "We couldn’t save that password. Try again.",
  );

  const [
    meResponse,
    sessionsResponse,
    preferencesResponse,
    smsEndpointsResponse,
    proofDefaultsResponse,
    accountProfileResponse,
    personalProfileResponse,
  ] = await Promise.all([
    callPartnerApi("/api/portal/v2/me").catch(() => null),
    callPartnerApi("/api/portal/v2/sessions").catch(() => null),
    callPartnerApi("/api/portal/v2/notification-preferences").catch(() => null),
    callPartnerApi("/api/portal/v2/notification-endpoints").catch(() => null),
    callPartnerApi("/api/portal/v2/proof-requirements").catch(() => null),
    callPartnerApi("/api/portal/v2/account-profile").catch(() => null),
    callPartnerApi("/api/portal/v2/personal-profile").catch(() => null),
  ]);

  const [
    payload,
    sessionsPayload,
    preferencesPayload,
    smsEndpointsPayload,
    proofDefaultsPayload,
    accountProfilePayload,
    personalProfilePayload,
  ] = await Promise.all([
    readJson<MePayload>(meResponse),
    readJson<{ ok: true; sessions: PartnerSettingsSession[] }>(
      sessionsResponse,
    ),
    readJson<{ ok: true; preferences: PartnerSettingsPreference[] }>(
      preferencesResponse,
    ),
    readJson<{ ok: true; endpoints: unknown }>(smsEndpointsResponse),
    readJson<{ ok: true; requirements: PartnerProofDefault[] }>(
      proofDefaultsResponse,
    ),
    readJson<{ ok: true; profile: PartnerAccountProfile }>(
      accountProfileResponse,
    ),
    readJson<{ ok: true; profile: PartnerPersonalProfile }>(
      personalProfileResponse,
    ),
  ]);
  const smsEndpoints = smsEndpointsPayload?.ok
    ? parsePartnerSmsEndpoints(smsEndpointsPayload.endpoints)
    : null;

  if (!payload?.ok) {
    return (
      <PartnerErrorState
        title="We couldn’t load account settings"
        description="Your security settings are unchanged. Try again in a moment."
        retryHref="/partners/settings"
      />
    );
  }

  const passwordSet = Boolean(payload.partnerUser.passwordSet);
  const userName = payload.partnerUser.name?.trim() || "Partner user";
  const userEmail = payload.partnerUser.email?.trim() || "Email unavailable";
  const accounts = Array.isArray(payload.accounts) ? payload.accounts : [];
  const canReadMembers = payload.membership.capabilities?.includes(
    "account.members.read",
  );
  const canManageSmsEndpoints = payload.membership.capabilities?.includes(
    "account.security.manage",
  );
  const canManageProofDefaults =
    payload.membership.capabilities?.includes("account.update");

  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        eyebrow="Your portal setup"
        title="Account, updates & security"
        description="Set your account defaults once, choose how Stonegate sends updates, and keep every sign-in protected."
        breadcrumbs={[
          { label: "Overview", href: "/partners/overview" },
          { label: "Account & security", href: "/partners/settings" },
        ]}
        actions={
          canReadMembers ? (
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

      <div className="grid gap-5 xl:grid-cols-[0.8fr_1.2fr]">
        <PartnerPanel>
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
              <UserRound className="h-6 w-6" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h2 className="truncate text-lg font-semibold text-slate-950">
                {userName}
              </h2>
              <p className="mt-0.5 truncate text-sm text-slate-600">
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

      <PartnerPersonalProfileManager
        initialProfile={personalProfilePayload?.profile ?? null}
        initialEtag={personalProfileResponse?.headers.get("etag") ?? null}
      />

      <PartnerEmailChangeForm
        currentEmail={userEmail}
        passwordSet={passwordSet}
      />

      <PartnerAccountProfileManager
        initialProfile={accountProfilePayload?.profile ?? null}
        initialEtag={accountProfileResponse?.headers.get("etag") ?? null}
      />

      <PartnerAccountSecurityManager
        accounts={accounts}
        sessions={sessionsPayload?.sessions ?? null}
        sessionsEtag={sessionsResponse?.headers.get("etag") ?? null}
        preferences={preferencesPayload?.preferences ?? null}
        smsEndpoints={smsEndpoints}
        canManageSmsEndpoints={Boolean(canManageSmsEndpoints)}
      />

      {proofDefaultsPayload?.ok ? (
        <PartnerProofDefaultsManager
          requirements={proofDefaultsPayload.requirements}
          etag={proofDefaultsResponse?.headers.get("etag") ?? ""}
          canEdit={Boolean(canManageProofDefaults)}
        />
      ) : null}
    </div>
  );
}
