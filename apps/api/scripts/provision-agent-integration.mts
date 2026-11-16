import { z } from "zod";
import { sql } from "drizzle-orm";
import { getDb, closeDbForWorkerShutdown } from "../src/db/index";
import { AGENT_CATALOG } from "../src/lib/agent-tool-catalog";

// Operator-only bootstrap for a specifically requested owner connection.
// The private bearer token is generated on the owner's computer. Only its
// SHA-256 hash enters the provider job command or database.
const [ownerEmail, ownerName, integrationId, hash] = process.argv.slice(2);
z.string().email().parse(ownerEmail);
z.string().min(2).parse(ownerName);
z.string().uuid().parse(integrationId);
z.string()
  .regex(/^[a-f0-9]{64}$/)
  .parse(hash);
const tools = [
  ...AGENT_CATALOG.map((t) => t.name),
  "records",
  "match_contact",
  "coverage",
];
try {
  const db = getDb();
  const result = await db.transaction(async (tx) => {
    const owners = await tx.execute(
      sql`select m.id,m.name,m.email from team_members m join team_roles r on r.id=m.role_id where m.active=true and r.slug='owner'`,
    );
    let matches = owners.filter(
      (o) =>
        (typeof o["email"] === "string" ? o["email"] : "").toLowerCase() === ownerEmail!.toLowerCase(),
    );
    if (matches.length === 0)
      matches = owners.filter(
        (o) =>
          String(o["name"]).trim().split(/\s+/)[0]?.toLowerCase() ===
          ownerName!.toLowerCase(),
      );
    if (matches.length !== 1)
      throw new Error(
        "Owner identity is ambiguous or missing; no integration created",
      );
    const owner = matches[0]!;
    const [existing] = await tx.execute(
      sql`select id,owner_id,token_hash from agent_integrations where id=${integrationId}::uuid`,
    );
    if (existing) {
      if (
        existing["owner_id"] !== owner["id"] ||
        existing["token_hash"] !== hash
      )
        throw new Error("Existing integration differs; refusing overwrite");
      return { id: integrationId, owner: owner["name"], existing: true };
    }
    await tx.execute(
      sql`insert into agent_integrations(id,name,owner_id,token_hash,tools,expires_at) values(${integrationId}::uuid,'Facebook Outreach',${String(owner["id"])}::uuid,${hash},${JSON.stringify(tools)}::jsonb,now()+interval '30 days')`,
    );
    await tx.execute(sql`insert into audit_logs(actor_type,actor_label,auth_method,action,entity_type,entity_id,outcome,meta)
      values('system','Owner-requested agent installation','service','agent.integration.provisioned','agent_integration',${integrationId},'succeeded',${JSON.stringify({ ownerId: owner["id"], source: "authorized operator bootstrap", tools: tools.length })}::jsonb)`);
    return {
      id: integrationId,
      owner: owner["name"],
      tools: tools.length,
      expiresInDays: 30,
    };
  });
  console.log(JSON.stringify(result));
} finally {
  await closeDbForWorkerShutdown();
}
