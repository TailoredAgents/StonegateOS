import { createHash } from "node:crypto";
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { getDb } from "@/db";
import { bindIntegrationContext } from "./agent-integration-context";
import {
  accessEvent,
  integrationStillActive,
  requireTool,
  requireOwnerPermissions,
  type AgentIntegration,
} from "./agent-integration-auth";
import {
  catalogTool,
  invokeCatalogHandler,
  needsActionApproval,
  ToolInputSchema,
  type CatalogTool,
  type ToolInput,
} from "./agent-tool-catalog";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export function payloadHash(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
export function sanitizeAgentResult(value: unknown): unknown {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizeAgentResult);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        ([key]) =>
          !/(token|password|secret|authorization|api.?key|recording.?url|session.?hash|capability.?url)/i.test(
            key,
          ),
      )
      .map(([key, v]) => [key, sanitizeAgentResult(v)]),
  );
}
async function invoke(
  integration: AgentIntegration,
  tool: CatalogTool,
  input: ToolInput,
  operationId?: string,
) {
  await integrationStillActive(integration);
  requireOwnerPermissions(integration, tool.permissions);
  let path = tool.path;
  for (const match of tool.path.matchAll(/\[([^\]]+)\]/g)) {
    const key = match[1]!;
    const value = input.params[key];
    if (!value) throw new Error(`Missing path parameter: ${key}`);
    path = path.replace(`[${key}]`, encodeURIComponent(value));
  }
  const url = new URL(path, "https://stonegate-internal.invalid");
  for (const [key, value] of Object.entries(input.query))
    url.searchParams.set(key, String(value));
  const headers = new Headers({
    "x-api-key": process.env["ADMIN_API_KEY"] ?? "",
    "content-type": "application/json",
  });
  if (operationId) headers.set("idempotency-key", `agent:${operationId}`);
  if (input.expectedVersion) headers.set("if-match", input.expectedVersion);
  const request = new NextRequest(url, {
    method: tool.method,
    headers,
    ...(tool.method !== "GET" ? { body: JSON.stringify(input.body) } : {}),
  });
  bindIntegrationContext(request, {
    integrationId: integration.id,
    ownerId: integration.owner_id,
    label: integration.name,
    permissions: tool.permissions,
    mutationAllowed: !!operationId,
    ownerDelegated: integration.approval_mode === "owner_delegated",
  });
  const response = await invokeCatalogHandler(tool, request, input.params);
  const raw = await response.text();
  if (raw.length > 2_000_000)
    throw new Error("Result exceeds limit; narrow the query or page size");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = { error: "Non-JSON response", status: response.status };
  }
  return { status: response.status, body: sanitizeAgentResult(body) };
}
export async function runCatalogTool(
  integration: AgentIntegration,
  name: string,
  input: ToolInput,
) {
  await integrationStillActive(integration);
  requireTool(integration, name);
  const tool = catalogTool(name);
  if (tool.method === "GET") {
    await accessEvent(integration, name, "attempted");
    const result = await invoke(integration, tool, input);
    await accessEvent(
      integration,
      name,
      result.status < 400 ? "succeeded" : "failed",
    );
    return result;
  }
  if (!input.requestKey)
    throw new Error(
      "Writes require a stable requestKey (16-200 characters); reuse it after a timeout",
    );
  if (
    Buffer.byteLength(JSON.stringify(input)) >
    (name === "promotional_sms_import" ? 1_048_576 : 32_768)
  )
    throw new Error("Action is too large");
  const approval = needsActionApproval(tool, input, integration.approval_mode);
  const hash = payloadHash(input);
  const rows = await getDb()
    .execute(sql`insert into agent_operations(integration_id,request_key,tool,payload,payload_hash,status,expires_at)
    values(${integration.id}::uuid,${input.requestKey},${name},${JSON.stringify(input)}::jsonb,${hash},${approval ? "pending" : "approved"},now()+interval '1 hour')
    on conflict(integration_id,request_key) do nothing returning id`);
  const [operation] = await getDb()
    .execute(sql`select id,tool,payload_hash,status,result,expires_at from agent_operations
    where integration_id=${integration.id}::uuid and request_key=${input.requestKey}`);
  if (
    !operation ||
    operation["payload_hash"] !== hash ||
    operation["tool"] !== name
  )
    throw new Error("requestKey already belongs to a different action");
  if (rows.length)
    await accessEvent(
      integration,
      name,
      approval
        ? "approval_requested"
        : integration.approval_mode === "owner_delegated"
          ? "owner_delegated"
          : "prepared",
      String(operation["id"]),
    );
  if (operation["status"] === "approved")
    return executeAgentOperation(integration, String(operation["id"]));
  let delivery: unknown;
  if (
    name === "promotional_sms_release" &&
    ["succeeded", "executing", "uncertain"].includes(
      String(operation["status"]),
    )
  ) {
    const { DraftSelectionSchema, individualSmsStatus } = await import(
      "./individual-promotional-sms"
    );
    const selected = DraftSelectionSchema.parse({
      contactId: input.body["contactId"],
      draftId: input.body["draftId"],
      version: input.body["version"],
    });
    delivery = await individualSmsStatus(getDb(), selected);
  }
  return {
    operationId: operation["id"],
    status: operation["status"],
    result: operation["result"],
    expiresAt: operation["expires_at"],
    approvalUrl: "https://stonegatejunkremoval.com/team/tools/integrations",
    ...(delivery ? { delivery } : {}),
  };
}
export async function executeAgentOperation(
  integration: AgentIntegration,
  operationId: string,
) {
  await integrationStillActive(integration);
  const db = getDb();
  const claim = await db.transaction(async (tx) => {
    // Revoke and claim use the same integration lock. Already claimed external
    // provider work cannot be recalled; subsequent claims fail after revocation.
    const [active] = await tx.execute(
      sql`select id,tools,approval_mode from agent_integrations where id=${integration.id}::uuid and revoked_at is null and expires_at>now() for update`,
    );
    if (!active) throw new Error("Integration revoked or expired");
    integration.tools = active["tools"] as string[];
    integration.approval_mode = active[
      "approval_mode"
    ] as AgentIntegration["approval_mode"];
    const [row] = await tx.execute(
      sql`select * from agent_operations where id=${operationId}::uuid and integration_id=${integration.id}::uuid for update`,
    );
    if (!row) throw new Error("Operation not found");
    requireTool(integration, String(row["tool"]));
    if (row["status"] !== "approved") return { claimed: false, row };
    if (new Date(String(row["expires_at"])) <= new Date())
      throw new Error(
        "Action authorization expired; prepare a new reviewed action",
      );
    const input = ToolInputSchema.parse(row["payload"]);
    if (payloadHash(input) !== row["payload_hash"])
      throw new Error("Action changed after review");
    if (
      needsActionApproval(
        catalogTool(String(row["tool"])),
        input,
        integration.approval_mode,
      ) &&
      !row["approved_by"]
    )
      throw new Error("Owner approval is required");
    await tx.execute(
      sql`update agent_operations set status='executing',updated_at=now() where id=${operationId}::uuid`,
    );
    await tx.execute(
      sql`insert into agent_access_events(integration_id,tool,operation_id,outcome) values(${integration.id}::uuid,${String(row["tool"])},${operationId}::uuid,'executing')`,
    );
    return { claimed: true, row };
  });
  if (!claim.claimed)
    return {
      operationId,
      status: claim.row["status"],
      result: claim.row["result"],
      guidance:
        "Pending needs owner approval. Executing/uncertain must be reconciled, never retried under a new key.",
    };
  try {
    const result = await invoke(
      integration,
      catalogTool(String(claim.row["tool"])),
      ToolInputSchema.parse(claim.row["payload"]),
      operationId,
    );
    const status =
      result.status < 400
        ? "succeeded"
        : result.status < 500
          ? "failed"
          : "uncertain";
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`update agent_operations set status=${status},result=${JSON.stringify(result)}::jsonb,updated_at=now() where id=${operationId}::uuid`,
      );
      await tx.execute(
        sql`insert into agent_access_events(integration_id,tool,operation_id,outcome) values(${integration.id}::uuid,${String(claim.row["tool"])},${operationId}::uuid,${status})`,
      );
    });
    return { operationId, status, result };
  } catch {
    await db.execute(
      sql`update agent_operations set status='uncertain',updated_at=now() where id=${operationId}::uuid`,
    );
    return {
      operationId,
      status: "uncertain",
      guidance:
        "Inspect Stonegate operation/audit/provider state before retrying. Do not issue a new requestKey to bypass this receipt.",
    };
  }
}
