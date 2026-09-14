import type { Metadata, Route } from "next";
import Link from "next/link";
import { ArrowLeft, ShieldCheck, UsersRound } from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import { getPartnerPortalContext } from "../../../lib/portal-context";
import {
  loadPartnerPortalResource,
  portalLoadErrorMessage,
} from "../../../lib/portal-load";
import {
  parsePortalTeam,
  parsePortalInvitations,
} from "../../../lib/portal-settings-load";
import { PartnerTeamManager } from "@/app/partners/components/PartnerTeamManager";
import { PartnerInvitationManager } from "@/app/partners/components/PartnerInvitationManager";
import {
  PartnerErrorState,
  PartnerPageHeader,
  PartnerPanel,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";

export const metadata: Metadata = { title: "Team access" };

export default async function PartnerTeamSettingsPage() {
  const context = await getPartnerPortalContext();
  if (context.status !== "authenticated") return null;
  if (!context.availability.reads)
    return (
      <PartnerErrorState
        title="Company settings are temporarily unavailable"
        description="Personal sign-in and device settings are still available."
        retryHref="/partners/settings"
      />
    );
  const teamResult = await loadPartnerPortalResource(
    () => callPartnerApi("/api/portal/v2/members?status=all&limit=100"),
    parsePortalTeam,
  );
  if (teamResult.status === "error")
    return (
      <PartnerErrorState
        title="We couldn’t load team access"
        description={portalLoadErrorMessage(
          teamResult,
          "Try again to see your team’s access.",
        )}
        retryHref="/partners/settings/team"
      />
    );
  const payload = teamResult.value;
  const canManage =
    context.availability.writes &&
    (payload.roles.length > 0 ||
      payload.members.some((member) => member.allowedActions.length > 0));
  const invitationResult =
    canManage && payload.invitation.available
      ? await loadPartnerPortalResource(
          () => callPartnerApi("/api/portal/v2/invitations?limit=100"),
          parsePortalInvitations,
        )
      : null;
  const invitationPayload =
    invitationResult?.status === "ok" ? invitationResult.value : null;

  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        eyebrow="Clear access for every teammate"
        title="Team access"
        description="Invite teammates, give each person the right role, and update access without sharing sign-ins."
        breadcrumbs={[
          { label: "Overview", href: "/partners/overview" },
          { label: "Account & security", href: "/partners/settings" },
          { label: "Team access", href: "/partners/settings/team" },
        ]}
        actions={
          <Link
            href={"/partners/settings" as Route}
            className={partnerSecondaryButtonClass}
          >
            <ArrowLeft className="h-4 w-4" aria-hidden="true" />
            Account & security
          </Link>
        }
      />

      {!canManage ? (
        <PartnerPanel>
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-slate-100 text-slate-700 ring-1 ring-slate-200">
              <UsersRound className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2 className="font-semibold text-slate-950">Read-only access</h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                You can see who has account access. An account administrator
                must invite people or change their role or access.
              </p>
            </div>
          </div>
        </PartnerPanel>
      ) : (
        <PartnerPanel>
          <div className="flex items-start gap-3">
            <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200">
              <ShieldCheck className="h-5 w-5" aria-hidden="true" />
            </div>
            <div>
              <h2 className="font-semibold text-slate-950">
                Team changes follow account roles
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Only account administrators can change access. The final account
                administrator cannot be demoted or suspended, and you cannot
                suspend your own access.
              </p>
            </div>
          </div>
        </PartnerPanel>
      )}

      {canManage && payload.invitation.available ? (
        invitationPayload?.ok &&
        Array.isArray(invitationPayload.invitations) &&
        invitationPayload.scopeOptions ? (
          <PartnerInvitationManager
            initialInvitations={invitationPayload.invitations}
            roles={payload.roles}
            initialScopeOptions={invitationPayload.scopeOptions}
            initialNextCursor={invitationPayload.page?.nextCursor ?? null}
          />
        ) : (
          <PartnerErrorState
            title="We couldn’t load invitations"
            description={
              invitationResult?.status === "error"
                ? portalLoadErrorMessage(
                    invitationResult,
                    "Try again to see invitation status.",
                  )
                : "Invitations could not be loaded. Try again."
            }
            retryHref="/partners/settings/team"
          />
        )
      ) : null}

      <PartnerTeamManager
        initial={payload}
        readOnly={!context.availability.writes}
      />
    </div>
  );
}
