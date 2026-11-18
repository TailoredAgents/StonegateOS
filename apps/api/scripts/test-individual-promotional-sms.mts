import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { CampaignTerms } from "@myst-os/sdk";
import { mkdir, writeFile } from "node:fs/promises";
import postgres from "postgres";
import { z } from "zod";
import { DateTime } from "luxon";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// This executable can never target production data or a real SMS provider.
const database = new URL(process.env["DATABASE_URL"] ?? "http://missing");
assert.equal(database.hostname, "127.0.0.1");
assert.equal(database.pathname, "/stonegate_individual_sms_test");
assert.equal(process.env["TWILIO_API_BASE_URL"], "http://127.0.0.1:4155");
assert.equal(process.env["TWILIO_ACCOUNT_SID"], "AC" + "0".repeat(32));
assert.equal(
  process.env["TWILIO_AUTH_TOKEN"],
  "fictional-local-provider-token",
);
assert.equal(process.env["TEAM_CRM_AUDIT_MODE"], "1");
const base = "http://localhost:3002";
const db = postgres(database.toString(), { max: 3, prepare: false });
const record = (value: unknown) => z.record(z.unknown()).parse(value);
const text = (value: unknown) => z.string().parse(value);
const id = (value: unknown) => z.string().uuid().parse(value);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const realFetch = globalThis.fetch;
globalThis.fetch = ((
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
) => {
  const url = new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  assert(
    ["localhost", "127.0.0.1"].includes(url.hostname),
    "Test attempted non-local network access",
  );
  return realFetch(input, init);
}) as typeof fetch;
const providerCalls: { to: string; from: string; body: string; sid: string }[] =
  [];
let uncertainNext = false;
const handleProvider = async (
  request: IncomingMessage,
  response: ServerResponse,
) => {
  if (request.method !== "POST" || !request.url?.endsWith("/Messages.json")) {
    response.writeHead(404).end();
    return;
  }
  let body = "";
  for await (const chunk of request) body += String(chunk);
  const form = new URLSearchParams(body);
  const sid = "SM" + randomUUID().replaceAll("-", "");
  providerCalls.push({
    to: form.get("To") ?? "",
    from: form.get("From") ?? "",
    body: form.get("Body") ?? "",
    sid,
  });
  if (uncertainNext) {
    uncertainNext = false;
    response.destroy();
    return;
  }
  response
    .writeHead(201, { "content-type": "application/json" })
    .end(JSON.stringify({ sid, status: "queued" }));
};
const provider = createServer((request, response) => {
  void handleProvider(request, response).catch(() => response.destroy());
});
await new Promise<void>((resolve) =>
  provider.listen(4155, "127.0.0.1", resolve),
);
const client = new Client({
  name: "fictional-single-sms-proof",
  version: "1.0",
});
const ownerToken = randomUUID(),
  jeffreyToken = randomUUID();
const checks: string[] = [];
const pass = (message: string) => {
  checks.push(message);
  console.log("PASS " + message);
};
async function http(
  path: string,
  body: unknown,
  token = ownerToken,
  key = `fictional-${randomUUID()}`,
) {
  const response = await fetch(base + path, {
    method: "POST",
    headers: {
      "x-api-key": process.env["ADMIN_API_KEY"]!,
      Authorization: `Bearer ${token}`,
      Origin: base,
      "Content-Type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify(body),
  });
  const result: unknown = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  return record(result);
}
async function call(name: string, args: Record<string, unknown>) {
  const response = await client.callTool({ name, arguments: args });
  const data = z
    .object({
      isError: z.boolean().optional(),
      content: z.array(
        z
          .object({ type: z.string(), text: z.string().optional() })
          .passthrough(),
      ),
    })
    .parse(response);
  assert(!data.isError, data.content[0]?.text);
  return record(JSON.parse(data.content.find((x) => x.type === "text")!.text!));
}
async function webhook(
  from: string,
  body: string,
  sid = "SM" + randomUUID().replaceAll("-", ""),
  status = "received",
) {
  const url = base + "/api/webhooks/twilio/sms";
  const values: Record<string, string> = {
    From: from,
    To: "+12025550100",
    Body: body,
    MessageSid: sid,
    SmsStatus: status,
  };
  const signed =
    url +
    Object.keys(values)
      .sort()
      .map((k) => k + values[k])
      .join("");
  const signature = createHmac("sha1", process.env["TWILIO_AUTH_TOKEN"]!)
    .update(signed)
    .digest("base64");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
    body: new URLSearchParams(values),
  });
  assert.equal(response.status, 200, await response.text());
  return sid;
}

try {
  const [contactCount] = await db<
    { count: number }[]
  >`select count(*)::int count from contacts`;
  assert.equal(
    contactCount!.count,
    0,
    "Use a newly migrated, empty fictional test database",
  );
  const [role] = await db<
    { id: string }[]
  >`insert into team_roles(name,slug,permissions) values('Fictional owner','owner',ARRAY['*']) returning id`;
  const [owner] = await db<
    { id: string }[]
  >`insert into team_members(name,role_id) values('Fictional Austin',${role!.id}) returning id`;
  const [jeffrey] = await db<
    { id: string }[]
  >`insert into team_members(name,role_id) values('Fictional Jeffrey',${role!.id}) returning id`;
  for (const [member, token] of [
    [owner!.id, ownerToken],
    [jeffrey!.id, jeffreyToken],
  ])
    await db`insert into team_sessions(team_member_id,session_hash,expires_at) values(${member!},${createHash("sha256").update(token!).digest("base64url")},now()+interval '2 hours')`;
  const grant = await http("/api/admin/agent-integrations", {
    action: "create",
    name: "Fictional promotional SMS proof",
    days: 1,
  });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(base + "/api/mcp"), {
      requestInit: {
        headers: { Authorization: "Bearer " + text(grant["token"]) },
      },
    }),
  );
  // Existing grants must receive explicit owner capability refresh; credentials stay valid.
  await db`update agent_integrations set tools='["contacts_search"]'::jsonb where id=${id(grant["id"])}`;
  assert(
    !(await client.listTools()).tools.some(
      (t) => t.name === "promotional_sms_release",
    ),
  );
  await http("/api/admin/agent-integrations", {
    action: "enable_individual_sms",
    id: grant["id"],
  });
  const discovered = await client.listTools();
  for (const name of [
    "promotional_sms_preview",
    "promotional_sms_release",
    "promotional_sms_status",
    "promotional_sms_drafts",
  ])
    assert(discovered.tools.some((t) => t.name === name));
  const recipientIds = Array.from({ length: 1318 }, () => randomUUID());
  const contacts = recipientIds.map((contactId, i) => ({
    id: contactId,
    first_name: "Fictional",
    last_name: "Prospect " + (i + 1),
    phone: i < 12 ? `+120255501${String(i + 1).padStart(2, "0")}` : null,
    phone_e164: i < 12 ? `+120255501${String(i + 1).padStart(2, "0")}` : null,
  }));
  await db`insert into contacts ${db(contacts, "id", "first_name", "last_name", "phone", "phone_e164")}`;
  const now = new Date();
  const zone = [
    "America/New_York",
    "Pacific/Honolulu",
    "Europe/London",
    "Asia/Tokyo",
  ].find((tz) => {
    const h = DateTime.fromJSDate(now, { zone: tz }).hour;
    return h >= 9 && h < 18;
  })!;
  assert(zone);
  await db`insert into policy_settings(key,value) values('business_hours',${db.json({ timezone: zone })}),('quiet_hours',${db.json({ channels: { sms: { start: "00:00", end: "00:00" } } })})`;
  const terms: CampaignTerms = {
    name: "Fictional individual 30%",
    audience: "customers_and_leads",
    deliveryMode: "individual_drafts",
    discountBasisPoints: 3000,
    expiresAt: new Date(now.getTime() + 14 * 86400_000).toISOString(),
    serviceThrough: new Date(now.getTime() + 21 * 86400_000)
      .toISOString()
      .slice(0, 10),
    retroactivePolicy: "include_unaccepted_quotes",
    stackingPolicy: "no_stacking",
    introduction: "Fictional test only",
  };
  const created = await http("/api/admin/sms-campaigns", {
    action: "create",
    terms,
  });
  const campaignId = id(record(created["data"])["campaignId"]);
  const records = recipientIds.map((contactId, i) => ({
    contactId,
    body: `Hi Fictional ${i + 1}, Jeffrey at Stonegate here. We have 30% off winter cleanups if you still need help with your project.`,
    sourceReference: `fictional-fixture:reviewed-draft-${i + 1}`,
  }));
  const importInput = {
    campaignId,
    sourceHash: sha(JSON.stringify(records)),
    records,
  };
  const before = await http("/api/admin/sms-campaigns/drafts", {
    ...importInput,
    action: "dry_run",
  });
  const report = record(before["data"]);
  assert.equal(report["rows"], 1318);
  assert.equal(report["valid"], true);
  assert.equal(report["wouldImport"], 1318);
  const [noImport] = await db<
    { count: number }[]
  >`select count(*)::int count from sms_campaign_drafts`;
  assert.equal(noImport!.count, 0);
  const importKey = `fixture-import-${randomUUID()}`;
  const imported = await http(
    "/api/admin/sms-campaigns/drafts",
    { ...importInput, action: "import", reviewHash: report["reviewHash"] },
    ownerToken,
    importKey,
  );
  assert.equal(record(imported["data"])["imported"], 1318);
  await http(
    "/api/admin/sms-campaigns/drafts",
    { ...importInput, action: "import", reviewHash: report["reviewHash"] },
    ownerToken,
    importKey,
  );
  const drafts = await db<
    { id: string; contact_id: string; version: number; body: string }[]
  >`select id,contact_id,version,body from sms_campaign_drafts`;
  assert.equal(drafts.length, 1318);
  assert(
    drafts.every(
      (d) => records.find((r) => r.contactId === d.contact_id)?.body === d.body,
    ),
  );
  assert(
    drafts.every((d) => !d.body.includes("STOP")),
    "No footer was appended",
  );
  pass(
    "1,318 fictional drafts: zero-write dry run, atomic reviewed import, exact wording, idempotent retry",
  );
  const invalidImport = await http("/api/admin/sms-campaigns/drafts", {
    ...importInput,
    action: "dry_run",
    records: [
      records[0],
      records[0],
      { ...records[1], contactId: randomUUID() },
      { ...records[2], body: "Fictional 40% conflicting offer" },
    ],
  });
  const invalidReport = record(invalidImport["data"]);
  const codes = z
    .array(z.object({ code: z.string() }))
    .parse(invalidReport["issues"])
    .map((x) => x.code);
  for (const code of [
    "duplicate_contact_id",
    "contact_unavailable",
    "offer_copy_mismatch",
  ])
    assert(codes.includes(code));
  pass(
    "Dry-run rejects duplicate/missing CRM IDs and conflicting offer wording without partial import",
  );
  for (let i = 0; i < 12; i++) {
    await http("/api/admin/sms-campaigns/qualification", {
      contactId: recipientIds[i],
      expectedVersion: 0,
      qualification: i % 2 ? "quote_only" : "prior_inquiry",
      facebookStatus: "clear",
      holds: [],
      externalLastActivityAt: new Date(
        now.getTime() - 90 * 86400_000,
      ).toISOString(),
      evidenceReference: `fictional-secure-evidence:qualification-${i}`,
      reviewedAt: now.toISOString(),
    });
    await http("/api/admin/sms-campaigns", {
      action: "consent",
      contactId: recipientIds[i],
      status: "granted",
      source: "owner external evidence reference",
      evidence: "Fictional owner attestation; no real customer evidence.",
      evidenceReference: `fictional-secure-evidence:consent-${i}`,
      capturedAt: new Date(now.getTime() - 90 * 86400_000).toISOString(),
      timeZone: zone,
    });
  }
  const { campaignTestFingerprint, campaignReplyContext } = await import(
    "../src/lib/sms-campaigns"
  );
  const { getDb } = await import("../src/db");
  const { processOutboxBatch } = await import("../src/lib/outbox-processor");
  const { activeWinterSale, winterSaleEstimate } = await import(
    "../src/lib/winter-sale"
  );
  const { winterSalePrice } = await import("@myst-os/sdk");
  const [storedCampaign] = await db<
    { terms: typeof terms }[]
  >`select terms from sms_campaigns where id=${campaignId}`;
  // A synthetic prior owner-test receipt satisfies the existing launch gate.
  const testContact = randomUUID(),
    testThread = randomUUID(),
    testMessage = randomUUID();
  await db`insert into contacts(id,first_name,last_name,phone,phone_e164) values(${testContact},'Fictional','Owner test','+12025550199','+12025550199')`;
  await db`insert into conversation_threads(id,contact_id,channel) values(${testThread},${testContact},'sms')`;
  await db`insert into conversation_messages(id,thread_id,channel,direction,body,delivery_status,metadata) values(${testMessage},${testThread},'sms','outbound','Fictional prior owner test','sent',${db.json({ campaignTestFingerprint: campaignTestFingerprint(storedCampaign!.terms, "+12025550100") })})`;
  await db`insert into sms_campaign_recipients(campaign_id,contact_id,phone,name,body,message_id,is_test) values(${campaignId},${testContact},'+12025550199','Fictional owner test','Fictional prior owner test',${testMessage},true)`;
  const selection = (index: number) => {
    const d = drafts.find((v) => v.contact_id === recipientIds[index])!;
    return { contactId: d.contact_id, draftId: d.id, version: d.version };
  };
  async function preview(index: number) {
    return record(
      (await call("promotional_sms_preview", { query: selection(index) }))[
        "body"
      ],
    );
  }
  async function prepare(index: number) {
    const p = await preview(index);
    assert.equal(p["eligible"], true, JSON.stringify(p["blockers"]));
    const args = {
      body: {
        ...selection(index),
        review: p["review"],
        reviewExpiresAt: p["reviewExpiresAt"],
      },
      requestKey: `fictional-send-${randomUUID()}`,
    };
    const pending = await call("promotional_sms_release", args);
    assert.equal(pending["status"], "pending");
    const operationId = id(pending["operationId"]);
    const [operation] = await db<
      { payload_hash: string }[]
    >`select payload_hash from agent_operations where id=${operationId}`;
    await http("/api/admin/agent-integrations", {
      action: "approve",
      id: operationId,
      payloadHash: operation!.payload_hash,
    });
    return { args, operationId };
  }
  async function release(index: number) {
    const prepared = await prepare(index);
    const result = await call("promotional_sms_release", prepared.args);
    assert.equal(result["status"], "succeeded", JSON.stringify(result));
    const receipt = record(record(record(result["result"])["body"])["data"]);
    assert.equal(receipt["released"], 1, JSON.stringify(receipt));
    return { ...prepared, receipt };
  }
  async function status(index: number) {
    return record(
      record(
        (await call("promotional_sms_status", { query: selection(index) }))[
          "body"
        ],
      )["receipt"],
    );
  }
  async function blocked(index: number, code: string) {
    const p = await preview(index);
    assert.equal(p["eligible"], false);
    assert(
      z
        .array(z.object({ code: z.string() }))
        .parse(p["blockers"])
        .some((b) => b.code === code),
      JSON.stringify(p["blockers"]),
    );
  }
  await db`update contacts set phone='(202) 555-0105',phone_e164=null where id=${recipientIds[12]!}`;
  await blocked(4, "phone_ownership_ambiguous");
  await db`update contacts set phone=null,phone_e164=null where id=${recipientIds[12]!}`;
  await db`insert into conversation_threads(contact_id,channel) values(${recipientIds[5]!},'sms'),(${recipientIds[5]!},'sms')`;
  await blocked(5, "sms_thread_ambiguous");
  const [email] = await db<
    { id: string }[]
  >`insert into conversation_threads(contact_id,channel) values(${recipientIds[6]!},'email') returning id`;
  await db`insert into conversation_messages(thread_id,channel,direction,body) values(${email!.id},'email','inbound','Fictional recent email')`;
  await blocked(6, "recent_message_21_days");
  await db`insert into call_records(call_sid,direction,from_number) values(${randomUUID()},'inbound','(202) 555-0108')`;
  await blocked(7, "recent_call_21_days");
  await db`insert into conversation_threads(contact_id,channel) values(${recipientIds[8]!},'dm')`;
  await blocked(8, "facebook_history");
  await db`update contacts set first_name='Tim',last_name='Gant' where id=${recipientIds[9]!}`;
  await blocked(9, "named_exclusion");
  const [property] = await db<
    { id: string }[]
  >`insert into properties(address_line1,city,state,postal_code) values('123 Fictional Lane','Test','DC','20001') returning id`;
  await db`insert into appointments(contact_id,property_id,reschedule_token) values(${recipientIds[10]!},${property!.id},${randomUUID()})`;
  await blocked(10, "active_job");
  await db`update sms_outreach_qualifications set holds='["Unresolved fictional service issue"]'::jsonb,external_last_activity_at=now() where contact_id=${recipientIds[11]!}`;
  await blocked(11, "owner_service_or_identity_hold");
  await blocked(11, "recent_external_activity_21_days");
  await db`update sms_outreach_qualifications set facebook_status='uncertain' where contact_id=${recipientIds[11]!}`;
  await blocked(11, "facebook_exclusion");
  pass(
    "Phone/thread ambiguity, email/call/external 21-day activity, Facebook overlap, named exclusions, active jobs and service holds block preview",
  );
  const changed = await prepare(4);
  await db`update contacts set phone='+12025550188',phone_e164='+12025550188' where id=${recipientIds[4]!}`;
  const changedResult = await call("promotional_sms_release", changed.args);
  assert.equal(
    record(record(record(changedResult["result"])["body"])["data"])["released"],
    0,
  );
  await db`update contacts set phone='+12025550105',phone_e164='+12025550105' where id=${recipientIds[4]!}`;
  pass("Changing the destination after owner approval blocks release");
  const first = await release(0);
  assert.equal(first.receipt["deliveryState"], "queued");
  assert.equal(providerCalls.length, 0);
  const firstThreadId = id(first.receipt["threadId"]),
    firstMessageId = id(first.receipt["messageId"]);
  await processOutboxBatch({ eventTypes: ["message.send"], limit: 10 });
  assert.equal(providerCalls.length, 1);
  assert.equal(providerCalls[0]!.body, records[0]!.body);
  assert.equal(providerCalls[0]!.to, contacts[0]!.phone);
  assert.equal(providerCalls[0]!.from, "+12025550100");
  assert.equal((await status(0))["deliveryState"], "sent");
  await webhook("+12025550100", "", providerCalls[0]!.sid, "delivered");
  assert.equal((await status(0))["deliveryState"], "delivered");
  const inboundSid = await webhook(
    contacts[0]!.phone!,
    "Yes, could you quote this cleanup?",
  );
  await webhook(
    contacts[0]!.phone!,
    "Yes, could you quote this cleanup?",
    inboundSid,
  );
  const [inbound] = await db<
    { id: string; thread_id: string }[]
  >`select id,thread_id from conversation_messages where provider_message_id=${inboundSid}`;
  assert.equal(inbound!.thread_id, firstThreadId);
  const replied = await http(
    `/api/admin/inbox/threads/${firstThreadId}/messages`,
    {
      body: "Hi, Jeffrey here. Send a few photos and I can confirm your 30% quote.",
      channel: "sms",
      expectedContactId: recipientIds[0],
    },
    jeffreyToken,
  );
  const reply = record(
    replied["message"] ?? record(replied["data"])["message"],
  );
  assert.equal(reply["threadId"], firstThreadId);
  await processOutboxBatch({ eventTypes: ["message.send"], limit: 10 });
  assert.equal(providerCalls.length, 2);
  pass(
    "ONE MCP release sends ONLY the selected saved text; outbound, signed inbound webhook and Jeffrey's normal composer reply share one thread",
  );
  const retry = await call("promotional_sms_release", first.args);
  assert.equal(record(retry["delivery"])["messageId"], firstMessageId);
  await db`update agent_operations set status='uncertain' where id=${first.operationId}`;
  const timedOutRetry = await call("promotional_sms_release", first.args);
  assert.equal(record(timedOutRetry["delivery"])["threadId"], firstThreadId);
  await processOutboxBatch({ eventTypes: ["message.send"], limit: 10 });
  assert.equal(providerCalls.length, 2);
  const [single] = await db<
    { count: number }[]
  >`select count(*)::int count from conversation_messages where id=${firstMessageId}`;
  assert.equal(single!.count, 1);
  pass(
    "Repeated release and lost MCP completion return the original message/current state without another provider send",
  );
  const beforeStop = await prepare(1);
  await webhook(contacts[1]!.phone!, "STOP");
  const stopped = await call("promotional_sms_release", beforeStop.args);
  const stoppedData = record(record(record(stopped["result"])["body"])["data"]);
  assert.equal(stoppedData["released"], 0);
  assert(JSON.stringify(stoppedData["blockers"]).includes("opted_out"));
  const lateStop = await release(2);
  await webhook(contacts[2]!.phone!, "STOP");
  await processOutboxBatch({ eventTypes: ["message.send"], limit: 10 });
  assert.equal(providerCalls.length, 2);
  assert.equal((await status(2))["deliveryState"], "suppressed");
  pass(
    "A new STOP blocks release after approval and also blocks an already queued message at actual dispatch",
  );
  // Pacing is a separate gate. Age that synthetic scheduling slot to test the next provider attempt immediately.
  await db`update sms_campaigns set next_send_at=now()-interval '1 minute' where id=${campaignId}`;
  const uncertain = await release(3);
  uncertainNext = true;
  await processOutboxBatch({ eventTypes: ["message.send"], limit: 10 });
  assert.equal(providerCalls.length, 3);
  assert.equal((await status(3))["deliveryState"], "reconciliation_required");
  await call("promotional_sms_release", uncertain.args);
  await processOutboxBatch({ eventTypes: ["message.send"], limit: 10 });
  assert.equal(providerCalls.length, 3);
  assert(
    JSON.stringify((await preview(4))["blockers"]).includes(
      "reconciliation_required",
    ),
  );
  pass(
    "Provider accepted/connection lost stays in reconciliation; neither a retry nor another recipient bypasses it",
  );
  const offer = await activeWinterSale(getDb(), new Date(), recipientIds[0]);
  assert.equal(offer?.basisPoints, 3000);
  assert.equal(await activeWinterSale(getDb()), null);
  assert.equal(
    record(winterSaleEstimate({ priceLow: 100, priceHigh: 200 }, offer))[
      "priceLowDiscounted"
    ],
    70,
  );
  const [broadcast] = await db<
    { id: string }[]
  >`insert into sms_campaigns(terms,status,sender,activated_at) values(${db.json({ ...terms, deliveryMode: "broadcast", discountBasisPoints: 4000 })},'active','+12025550100',now()) returning id`;
  assert(broadcast);
  assert.equal((await activeWinterSale(getDb()))?.basisPoints, 4000);
  assert.equal(
    (await activeWinterSale(getDb(), new Date(), recipientIds[0]))?.basisPoints,
    3000,
  );
  assert.equal(
    (await activeWinterSale(getDb(), new Date(), recipientIds[4]))?.basisPoints,
    4000,
  );
  assert.equal(winterSalePrice(10000).finalCents, 6000);
  assert((await campaignReplyContext(recipientIds[0]!)).includes("30% off"));
  pass(
    "Recipient offer and suggested-reply context are 30%; public/global 40% behavior remains unchanged",
  );
  const proof = {
    fictionalOnly: true,
    realSmsSent: 0,
    draftsImported: 1318,
    tool: "promotional_sms_release",
    inputs: first.args,
    releaseResult: first.receipt,
    conversation: {
      contactId: recipientIds[0],
      outgoingMessageId: firstMessageId,
      outgoingThreadId: firstThreadId,
      incomingMessageId: inbound!.id,
      incomingThreadId: inbound!.thread_id,
      jeffreyReplyMessageId: reply["id"],
      jeffreyReplyThreadId: reply["threadId"],
    },
    duplicateReleaseProviderCalls: 0,
    lateOptOut: lateStop.receipt["messageId"],
    uncertainProviderResult: uncertain.receipt["messageId"],
    checks,
  };
  await mkdir("../../artifacts", { recursive: true });
  await writeFile(
    "../../artifacts/individual-promotional-sms-proof.json",
    JSON.stringify(proof, null, 2),
  );
  console.log(
    JSON.stringify({
      tool: proof.tool,
      outgoingThreadId: firstThreadId,
      incomingThreadId: inbound!.thread_id,
      jeffreyReplyThreadId: reply["threadId"],
      realSmsSent: 0,
      checks: checks.length,
    }),
  );
} finally {
  const { closeDbForWorkerShutdown } = await import("../src/db");
  await closeDbForWorkerShutdown();
  await client.close();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await db.end();
  globalThis.fetch = realFetch;
}
