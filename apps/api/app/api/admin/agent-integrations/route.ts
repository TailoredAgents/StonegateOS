import { NextResponse, type NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getDb, auditLogs } from "@/db";
import { resolvePermissionContext, requirePermission } from "@/lib/permissions";
import { isAllowedTeamMutationOrigin } from "@/lib/team-mutation";
import { newIntegrationToken, tokenHash } from "@/lib/agent-integration-auth";
import { AGENT_CATALOG } from "@/lib/agent-tool-catalog";
import { getIntegrationContext } from "@/lib/agent-integration-context";
import { getAuditActorFromRequest } from "@/lib/audit";
export const dynamic = "force-dynamic";

export const ALL_AGENT_TOOLS = [
  ...AGENT_CATALOG.map((t) => t.name),
  "records",
  "match_contact",
  "coverage",
];
const Command = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      name: z.string().trim().min(2).max(80),
      days: z.number().int().min(1).max(90).default(30),
    })
    .strict(),
  z.object({ action: z.literal("revoke"), id: z.string().uuid() }).strict(),
  z
    .object({
      action: z.enum([
        "enable_individual_sms",
        "enable_owner_delegation",
        "require_action_approval",
      ]),
      id: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.enum(["approve", "reject"]),
      id: z.string().uuid(),
      payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);
async function owner(request: NextRequest) {
  if (getIntegrationContext(request)) return null;
  const context = await resolvePermissionContext(request);
  return context.authenticated &&
    context.source !== "service" &&
    context.role === "owner" &&
    context.principalId
    ? context.principalId
    : null;
}
export async function GET(request: NextRequest) {
  const denied = await requirePermission(request, "access.manage");
  if (denied) return denied;
  const ownerId = await owner(request);
  if (!ownerId)
    return NextResponse.json(
      { error: "Owner access required" },
      { status: 403 },
    );
  const db = getDb();
  const integrations = await db.execute(
    sql`select id,name,tools,approval_mode,expires_at,revoked_at,last_used_at,created_at from agent_integrations where owner_id=${ownerId}::uuid order by created_at desc limit 100`,
  );
  const operations = await db.execute(
    sql`select o.id,o.integration_id,i.name,o.tool,o.payload,o.payload_hash,o.status,o.expires_at,o.result,o.created_at from agent_operations o join agent_integrations i on i.id=o.integration_id where i.owner_id=${ownerId}::uuid order by (o.status='pending') desc,o.created_at desc limit 100`,
  );
  const activity = await db.execute(
    sql`select e.tool,e.outcome,e.operation_id,e.created_at,i.name from agent_access_events e join agent_integrations i on i.id=e.integration_id where i.owner_id=${ownerId}::uuid order by e.created_at desc limit 100`,
  );
  return NextResponse.json(
    { integrations, operations, activity, tools: ALL_AGENT_TOOLS },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
export async function POST(request: NextRequest) {
  const denied = await requirePermission(request, "access.manage");
  if (denied) return denied;
  const ownerId = await owner(request);
  if (!ownerId || !isAllowedTeamMutationOrigin(request))
    return NextResponse.json(
      { error: "Owner session and valid origin required" },
      { status: 403 },
    );
  const raw = await request.text();
  if (raw.length > 4096)
    return NextResponse.json({ error: "Request too large" }, { status: 413 });
  let command: z.infer<typeof Command>;
  try {
    command = Command.parse(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: "Invalid command" }, { status: 422 });
  }
  const db = getDb();
  if (command.action === "create") {
    const token = newIntegrationToken();
    const row = await db.transaction(async (tx) => {
      const [created] = await tx.execute(
        sql`insert into agent_integrations(name,owner_id,token_hash,tools,expires_at) values(${command.name},${ownerId}::uuid,${tokenHash(token)},${JSON.stringify(ALL_AGENT_TOOLS)}::jsonb,now()+make_interval(days=>${command.days})) returning id,expires_at`,
      );
      const actor = getAuditActorFromRequest(request);
      await tx.insert(auditLogs).values({
        actorType: "human",
        actorId: ownerId,
        actorLabel: actor.label,
        sessionId: actor.sessionId,
        authMethod: actor.authMethod,
        action: "agent.integration.created",
        entityType: "agent_integration",
        entityId: String(created!["id"]),
        outcome: "succeeded",
      });
      return created!;
    });
    return NextResponse.json(
      { id: row["id"], expiresAt: row["expires_at"], token },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  return db.transaction(async (tx) => {
    if (command.action === "revoke") {
      const rows = await tx.execute(
        sql`update agent_integrations set revoked_at=coalesce(revoked_at,now()) where id=${command.id}::uuid and owner_id=${ownerId}::uuid returning id`,
      );
      if (!rows.length)
        return NextResponse.json({ error: "Not found" }, { status: 404 });
    } else if (
      command.action === "enable_owner_delegation" ||
      command.action === "require_action_approval"
    ) {
      const mode =
        command.action === "enable_owner_delegation"
          ? "owner_delegated"
          : "per_action";
      const rows = await tx.execute(
        sql`update agent_integrations set approval_mode=${mode},tools=(select jsonb_agg(distinct capability) from jsonb_array_elements(tools || ${JSON.stringify(ALL_AGENT_TOOLS)}::jsonb) capability) where id=${command.id}::uuid and owner_id=${ownerId}::uuid and revoked_at is null and expires_at>now() returning id`,
      );
      if (!rows.length)
        return NextResponse.json(
          { error: "Active connection not found" },
          { status: 404 },
        );
    } else if (command.action === "enable_individual_sms") {
      const capabilities = AGENT_CATALOG.filter((t) =>
        t.name.startsWith("promotional_sms_"),
      ).map((t) => t.name);
      const rows = await tx.execute(
        sql`update agent_integrations set tools=(select jsonb_agg(distinct capability) from jsonb_array_elements(tools || ${JSON.stringify(capabilities)}::jsonb) capability) where id=${command.id}::uuid and owner_id=${ownerId}::uuid and revoked_at is null and expires_at>now() returning id`,
      );
      if (!rows.length)
        return NextResponse.json(
          { error: "Active connection not found" },
          { status: 404 },
        );
    } else if (command.action === "approve" || command.action === "reject") {
      const rows =
        await tx.execute(sql`update agent_operations o set status=${command.action === "approve" ? "approved" : "rejected"},approved_by=${ownerId}::uuid,approved_at=now(),updated_at=now()
      from agent_integrations i where o.integration_id=i.id and i.owner_id=${ownerId}::uuid and i.revoked_at is null and i.expires_at>now()
      and o.id=${command.id}::uuid and o.status='pending' and o.expires_at>now() and o.payload_hash=${command.payloadHash} returning o.id`);
      if (!rows.length)
        return NextResponse.json(
          {
            error:
              "Action changed, expired, revoked or already processed; refresh the review",
          },
          { status: 409 },
        );
    }
    const actor = getAuditActorFromRequest(request);
    await tx.insert(auditLogs).values({
      actorType: "human",
      actorId: ownerId,
      actorLabel: actor.label,
      sessionId: actor.sessionId,
      authMethod: actor.authMethod,
      action: `agent.integration.${command.action}`,
      entityType:
        command.action === "revoke" ||
        [
          "enable_individual_sms",
          "enable_owner_delegation",
          "require_action_approval",
        ].includes(command.action)
          ? "agent_integration"
          : "agent_operation",
      entityId: command.id,
      outcome: "succeeded",
    });
    return NextResponse.json(
      { ok: true },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}
