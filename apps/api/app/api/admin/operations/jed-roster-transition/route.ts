import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, isNull, ne } from "drizzle-orm";
import {
  auditLogs,
  commissionCrewSplitRules,
  getDb,
  teamLoginTokens,
  teamMembers,
  teamRoles,
  teamSessions,
} from "@/db";
import { hashPassword, normalizeEmail } from "@/lib/team-auth";
import { isAdminRequest } from "../../../web/admin";

const DEVON_MEMBER_ID = "b45988bb-7417-48c5-af6d-fcdf71088282";
const JED_EMAIL = "sales@stonegatejunkremoval.com";
const JED_JOB_RATE_BPS = 1_000;
const EMPLOYEE_ROLE_SLUG = "employee";
const EMPLOYEE_PERMISSIONS = [
  "appointment_media.capture",
  "appointments.read",
  "appointments.update",
  "messages.read",
  "messages.send",
  "messages.upload",
  "messages.write",
  "payments.collect",
  "payments.read",
] as const;

function enabled(): boolean {
  return process.env["ROSTER_TRANSITION_ENABLED"] === "true";
}

function authorized(request: NextRequest): Response | null {
  if (!enabled()) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export async function GET(request: NextRequest): Promise<Response> {
  const error = authorized(request);
  if (error) return error;

  const db = getDb();
  const [devon] = await db
    .select({
      id: teamMembers.id,
      name: teamMembers.name,
      email: teamMembers.email,
      active: teamMembers.active,
    })
    .from(teamMembers)
    .where(eq(teamMembers.id, DEVON_MEMBER_ID))
    .limit(1);
  const [emailOwner] = await db
    .select({
      id: teamMembers.id,
      name: teamMembers.name,
      email: teamMembers.email,
      active: teamMembers.active,
      roleId: teamMembers.roleId,
      fixedCrewJobRateBps: teamMembers.fixedCrewJobRateBps,
    })
    .from(teamMembers)
    .where(eq(teamMembers.emailNormalized, JED_EMAIL))
    .limit(1);
  const [role] = await db
    .select({
      id: teamRoles.id,
      name: teamRoles.name,
      permissions: teamRoles.permissions,
    })
    .from(teamRoles)
    .where(eq(teamRoles.slug, EMPLOYEE_ROLE_SLUG))
    .limit(1);

  return NextResponse.json({
    devon: devon ?? null,
    emailOwner: emailOwner ?? null,
    employeeRole: role ?? null,
    intended: {
      name: "Jed",
      email: JED_EMAIL,
      fixedCrewJobRateBps: JED_JOB_RATE_BPS,
      permissions: EMPLOYEE_PERMISSIONS,
    },
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const error = authorized(request);
  if (error) return error;

  const payload = (await request.json().catch(() => null)) as {
    confirm?: unknown;
    password?: unknown;
  } | null;
  const password =
    typeof payload?.password === "string" ? payload.password : "";
  if (payload?.confirm !== "replace-devon-with-jed" || password.length < 10) {
    return NextResponse.json(
      { error: "invalid_transition_request" },
      { status: 400 },
    );
  }

  const email = normalizeEmail(JED_EMAIL);
  if (!email) {
    return NextResponse.json({ error: "invalid_email" }, { status: 500 });
  }

  const db = getDb();
  const now = new Date();
  try {
    const result = await db.transaction(async (tx) => {
      const [devon] = await tx
        .select({ id: teamMembers.id, active: teamMembers.active })
        .from(teamMembers)
        .where(eq(teamMembers.id, DEVON_MEMBER_ID))
        .for("update")
        .limit(1);
      if (!devon) throw new Error("devon_not_found");

      const [existingEmailOwner] = await tx
        .select({ id: teamMembers.id, name: teamMembers.name })
        .from(teamMembers)
        .where(eq(teamMembers.emailNormalized, email))
        .for("update")
        .limit(1);
      if (
        existingEmailOwner &&
        existingEmailOwner.name.trim().toLowerCase() !== "jed"
      ) {
        throw new Error(`email_in_use:${existingEmailOwner.id}`);
      }

      let [employeeRole] = await tx
        .select({
          id: teamRoles.id,
          permissions: teamRoles.permissions,
        })
        .from(teamRoles)
        .where(eq(teamRoles.slug, EMPLOYEE_ROLE_SLUG))
        .for("update")
        .limit(1);
      if (employeeRole) {
        const otherMembers = await tx
          .select({ id: teamMembers.id })
          .from(teamMembers)
          .where(
            and(
              eq(teamMembers.roleId, employeeRole.id),
              existingEmailOwner
                ? ne(teamMembers.id, existingEmailOwner.id)
                : eq(teamMembers.active, true),
            ),
          )
          .limit(1);
        const samePermissions =
          [...employeeRole.permissions].sort().join("|") ===
          [...EMPLOYEE_PERMISSIONS].sort().join("|");
        if (otherMembers.length > 0 && !samePermissions) {
          throw new Error("employee_role_in_use");
        }
        [employeeRole] = await tx
          .update(teamRoles)
          .set({
            name: "Employee",
            permissions: [...EMPLOYEE_PERMISSIONS],
            updatedAt: now,
          })
          .where(eq(teamRoles.id, employeeRole.id))
          .returning({
            id: teamRoles.id,
            permissions: teamRoles.permissions,
          });
      } else {
        [employeeRole] = await tx
          .insert(teamRoles)
          .values({
            name: "Employee",
            slug: EMPLOYEE_ROLE_SLUG,
            permissions: [...EMPLOYEE_PERMISSIONS],
            createdAt: now,
            updatedAt: now,
          })
          .returning({
            id: teamRoles.id,
            permissions: teamRoles.permissions,
          });
      }
      if (!employeeRole) throw new Error("employee_role_unavailable");

      let jedId = existingEmailOwner?.id ?? null;
      if (jedId) {
        await tx
          .update(teamMembers)
          .set({
            name: "Jed",
            email,
            emailNormalized: email,
            emailIdentityStatus: "ready",
            roleId: employeeRole.id,
            permissionsGrant: [],
            permissionsDeny: [],
            active: true,
            fixedCrewJobRateBps: JED_JOB_RATE_BPS,
            passwordHash: hashPassword(password),
            passwordSetAt: now,
            updatedAt: now,
          })
          .where(eq(teamMembers.id, jedId));
      } else {
        const [created] = await tx
          .insert(teamMembers)
          .values({
            name: "Jed",
            email,
            emailNormalized: email,
            emailIdentityStatus: "ready",
            roleId: employeeRole.id,
            permissionsGrant: [],
            permissionsDeny: [],
            active: true,
            fixedCrewJobRateBps: JED_JOB_RATE_BPS,
            passwordHash: hashPassword(password),
            passwordSetAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: teamMembers.id });
        jedId = created?.id ?? null;
      }
      if (!jedId) throw new Error("jed_not_created");

      const revokedJedSessions = await tx
        .update(teamSessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(teamSessions.teamMemberId, jedId),
            isNull(teamSessions.revokedAt),
          ),
        )
        .returning({ id: teamSessions.id });
      await tx
        .delete(teamLoginTokens)
        .where(eq(teamLoginTokens.teamMemberId, jedId));

      const [deactivatedDevon] = await tx
        .update(teamMembers)
        .set({ active: false, updatedAt: now })
        .where(eq(teamMembers.id, DEVON_MEMBER_ID))
        .returning({ id: teamMembers.id });
      const revokedDevonSessions = await tx
        .update(teamSessions)
        .set({ revokedAt: now })
        .where(
          and(
            eq(teamSessions.teamMemberId, DEVON_MEMBER_ID),
            isNull(teamSessions.revokedAt),
          ),
        )
        .returning({ id: teamSessions.id });
      await tx
        .delete(teamLoginTokens)
        .where(eq(teamLoginTokens.teamMemberId, DEVON_MEMBER_ID));
      const disabledRules = await tx
        .update(commissionCrewSplitRules)
        .set({ enabled: false, updatedAt: now })
        .where(eq(commissionCrewSplitRules.memberId, DEVON_MEMBER_ID))
        .returning({ id: commissionCrewSplitRules.id });

      await tx.insert(auditLogs).values({
        actorType: "worker",
        actorLabel: "jed-roster-transition",
        action: "team.roster.devon_replaced_with_jed",
        entityType: "team_member",
        entityId: jedId,
        outcome: "succeeded",
        meta: {
          devonMemberId: DEVON_MEMBER_ID,
          devonDeactivated: Boolean(deactivatedDevon),
          employeeRoleId: employeeRole.id,
          fixedCrewJobRateBps: JED_JOB_RATE_BPS,
          disabledCrewRuleCount: disabledRules.length,
          revokedDevonSessionCount: revokedDevonSessions.length,
          revokedJedSessionCount: revokedJedSessions.length,
        },
        createdAt: now,
      });

      return {
        jedMemberId: jedId,
        employeeRoleId: employeeRole.id,
        devonDeactivated: Boolean(deactivatedDevon),
        disabledCrewRuleCount: disabledRules.length,
        revokedDevonSessionCount: revokedDevonSessions.length,
        revokedJedSessionCount: revokedJedSessions.length,
      };
    });
    return NextResponse.json({ ok: true, ...result });
  } catch (transitionError) {
    const message =
      transitionError instanceof Error ? transitionError.message : "failed";
    const conflict =
      message.startsWith("email_in_use:") || message === "employee_role_in_use";
    return NextResponse.json(
      { error: conflict ? message : "transition_failed" },
      { status: conflict ? 409 : 500 },
    );
  }
}
