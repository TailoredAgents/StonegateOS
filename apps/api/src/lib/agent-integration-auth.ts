import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { computeEffectivePermissions, permissionMatches } from "./permissions";

export type AgentIntegration = {
  id: string;
  name: string;
  owner_id: string;
  tools: string[];
  expires_at: Date;
  ownerPermissions: string[];
};
export function tokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function newIntegrationToken() {
  return `sg_agent_${randomBytes(32).toString("base64url")}`;
}
export async function authenticateIntegration(
  request: Request,
): Promise<AgentIntegration | null> {
  if (process.env["AGENT_INTEGRATIONS_DISABLED"] === "true") return null;
  const bearer = request.headers.get("authorization") ?? "";
  if (!/^Bearer sg_agent_[A-Za-z0-9_-]{43}$/i.test(bearer)) return null;
  const [row] = await getDb().execute(sql`
    select i.id,i.name,i.owner_id,i.tools,i.expires_at,r.permissions,m.permissions_grant,m.permissions_deny from agent_integrations i
    join team_members m on m.id=i.owner_id join team_roles r on r.id=m.role_id
    where i.token_hash=${tokenHash(bearer.slice(7))} and i.revoked_at is null
      and i.expires_at>now() and m.active=true and r.slug='owner'`);
  return row
    ? ({
        ...row,
        ownerPermissions: computeEffectivePermissions({
          rolePermissions: row["permissions"] as string[],
          grant: row["permissions_grant"] as string[],
          deny: row["permissions_deny"] as string[],
        }),
      } as unknown as AgentIntegration)
    : null;
}
export async function integrationStillActive(integration: AgentIntegration) {
  const [row] = await getDb().execute(sql`
    select i.id,r.permissions,m.permissions_grant,m.permissions_deny from agent_integrations i join team_members m on m.id=i.owner_id
    join team_roles r on r.id=m.role_id where i.id=${integration.id}::uuid
    and i.revoked_at is null and i.expires_at>now() and m.active=true and r.slug='owner'`);
  if (!row || process.env["AGENT_INTEGRATIONS_DISABLED"] === "true")
    throw new Error("Integration revoked or expired");
  integration.ownerPermissions = computeEffectivePermissions({
    rolePermissions: row["permissions"] as string[],
    grant: row["permissions_grant"] as string[],
    deny: row["permissions_deny"] as string[],
  });
}
export function requireOwnerPermissions(
  integration: AgentIntegration,
  permissions: string[],
) {
  if (
    !permissions.every((required) =>
      integration.ownerPermissions.some((granted) =>
        permissionMatches(granted, required),
      ),
    )
  )
    throw new Error("Owner no longer has the required permissions");
}
export async function accessEvent(
  integration: AgentIntegration,
  tool: string,
  outcome: string,
  operationId: string | null = null,
) {
  await getDb()
    .execute(sql`insert into agent_access_events(integration_id,tool,outcome,operation_id)
    values(${integration.id}::uuid,${tool},${outcome},${operationId}::uuid)`);
  await getDb().execute(
    sql`update agent_integrations set last_used_at=now() where id=${integration.id}::uuid`,
  );
}
export function requireTool(integration: AgentIntegration, tool: string) {
  if (!integration.tools.includes(tool))
    throw new Error("Tool is not granted to this integration");
}
