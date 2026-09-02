import type { Metadata, Route } from "next";
import Link from "next/link";
import { ArrowLeft, ShieldCheck, UsersRound } from "lucide-react";
import { callPartnerApi } from "@/app/partners/lib/api";
import {
  PartnerTeamManager,
  type PartnerTeamMember,
  type PartnerTeamRole,
} from "@/app/partners/components/PartnerTeamManager";
import {
  PartnerInvitationManager,
  type PartnerInvitation,
} from "@/app/partners/components/PartnerInvitationManager";
import {
  PartnerJoinRequestManager,
  type PartnerAdminJoinRequest,
} from "@/app/partners/components/PartnerJoinRequestManager";
import {
  PartnerErrorState,
  PartnerPageHeader,
  PartnerPanel,
  partnerSecondaryButtonClass,
} from "@/app/partners/components/PartnerPortalUi";

export const metadata: Metadata = { title: "Team access" };

type TeamPayload = {
  ok: true;
  members: PartnerTeamMember[];
  roles: PartnerTeamRole[];
  invitation: { available: boolean; reason: string | null };
  page: { limit: number; nextCursor: string | null; hasMore: boolean };
};

export default async function PartnerTeamSettingsPage() {
  const [response, invitationResponse, joinResponse] = await Promise.all([
    callPartnerApi("/api/portal/v2/members?status=all&limit=100").catch(() => null),
    callPartnerApi("/api/portal/v2/invitations?limit=100").catch(() => null),
    callPartnerApi("/api/portal/v2/join-requests?limit=100").catch(() => null),
  ]);
  const payload = response?.ok
    ? ((await response.json().catch(() => null)) as TeamPayload | null)
    : null;
  const invitationPayload = invitationResponse?.ok
    ? ((await invitationResponse.json().catch(() => null)) as { ok: true; invitations: PartnerInvitation[] } | null)
    : null;
  const joinPayload = joinResponse?.ok
    ? ((await joinResponse.json().catch(() => null)) as { ok: true; joinRequests: PartnerAdminJoinRequest[] } | null)
    : null;

  if (!payload?.ok) {
    const forbidden = response?.status === 403;
    return (
      <PartnerErrorState
        title={
          forbidden
            ? "Team access is not part of your role"
            : "We couldn’t load team access"
        }
        description={
          forbidden
            ? "Ask an account administrator to review team membership and roles. Your own portal access is unchanged."
            : "No membership settings were changed. Try again, or contact Stonegate if the problem continues."
        }
        retryHref={forbidden ? "/partners/settings" : "/partners/settings/team"}
      />
    );
  }

  const canManage =
    payload.roles.length > 0 ||
    payload.members.some((member) => member.allowedActions.length > 0);

  return (
    <div className="space-y-5 sm:space-y-6">
      <PartnerPageHeader
        eyebrow="Account administration"
        title="Team access"
        description="Review who can use this account, assign roles within your own authority, and suspend or restore account access."
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
                You can review account members. An account administrator must
                make role or access changes.
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
                Protected administration
              </h2>
              <p className="mt-1 text-sm leading-6 text-slate-600">
                Role and access changes require a verified MFA session. The
                final account administrator cannot be demoted or suspended, and
                you cannot suspend your own current membership.
              </p>
            </div>
          </div>
        </PartnerPanel>
      )}

      {canManage && payload.invitation.available ? (
        <PartnerInvitationManager
          initialInvitations={invitationPayload?.invitations ?? []}
          roles={payload.roles}
        />
      ) : null}

      {canManage ? (
        <PartnerJoinRequestManager
          initialRequests={joinPayload?.joinRequests ?? []}
          roles={payload.roles}
        />
      ) : null}

      <PartnerTeamManager initial={payload} />
    </div>
  );
}
