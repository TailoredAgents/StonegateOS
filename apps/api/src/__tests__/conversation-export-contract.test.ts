import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifyTeamActionRisk } from "@/lib/team-route-security-manifest";

const API_ROOT = process.cwd();
const SITE_ROOT = join(API_ROOT, "../site");

function apiSource(path: string): string {
  return readFileSync(join(API_ROOT, path), "utf8");
}

function siteSource(path: string): string {
  return readFileSync(join(SITE_ROOT, path), "utf8");
}

describe("sensitive conversation export production contract", () => {
  const route = apiSource("app/api/admin/inbox/export/jsonl/route.ts");
  const helper = apiSource("src/lib/conversation-export.ts");
  const siteRoute = siteSource("src/app/api/team/inbox/export/route.ts");
  const siteHelper = siteSource("src/app/team/lib/conversation-export.ts");
  const settings = siteSource("src/app/team/settings-surface.tsx");
  const settingsClient = siteSource(
    "src/app/team/components/ConversationExportClient.tsx",
  );
  const schema = apiSource("src/db/schema.ts");
  const migration = apiSource(
    "src/db/migrations/0085_conversation_export_query_index.sql",
  );

  it("requires a verified messages.export human actor before data access", () => {
    expect(route).toContain('requirePermission(request, "messages.export")');
    expect(route).toContain("getVerifiedRequestActor(request)");
    expect(route).toContain('actor.type === "human"');
    expect(route).toContain("actor.sessionId");
    expect(route).toContain('action: "conversation.export.denied"');
    expect(siteRoute).toContain('"messages.export"');
    const sitePost = siteRoute.slice(
      siteRoute.indexOf("export async function POST"),
    );
    const siteGuard = sitePost.indexOf("requireTeamPrincipal(request");
    expect(sitePost).toContain('permissions: "messages.export"');
    expect(siteGuard).toBeGreaterThan(-1);
    expect(siteGuard).toBeLessThan(
      sitePost.indexOf("readSiteConversationExportConfirmation(request"),
    );
    expect(siteGuard).toBeLessThan(
      sitePost.indexOf("request.nextUrl.searchParams"),
    );
    expect(siteGuard).toBeLessThan(
      sitePost.indexOf("upstream = await callAdminApiAs("),
    );
  });

  it("uses strict trailing filters, a statement deadline, and one snapshot", () => {
    expect(helper).toContain(
      'ALLOWED_QUERY_KEYS = new Set(["days", "channel"])',
    );
    expect(helper).toContain("CONVERSATION_EXPORT_ALLOWED_DAYS = [7, 30, 90]");
    expect(helper).toContain("toExclusive = new Date(now.getTime())");
    expect(route).toContain(
      "set transaction isolation level repeatable read read only",
    );
    expect(route).toContain("set local statement_timeout = '15s'");
    expect(route).toContain("octet_length(${conversationMessages.body})");
    expect(route).toContain("CONVERSATION_EXPORT_MAX_MESSAGES + 1");
    expect(route).not.toContain(".offset(");
    expect(route).not.toContain("ReadableStream");
  });

  it("uses a matching partial query index and whitespace predicate", () => {
    expect(route).toContain("!~ E'^[\\\\t\\\\n\\\\v\\\\f\\\\r ]*$'");
    expect(schema).toContain(
      '"conversation_messages_export_eligible_effective_idx"',
    );
    expect(migration).toContain(
      '"conversation_messages_export_eligible_effective_idx"',
    );
    expect(migration).toContain(
      'coalesce("sent_at", "received_at", "created_at")',
    );
    expect(migration).toContain("\"direction\" = 'inbound'");
    expect(migration).toContain("'sent', 'delivered'");
  });

  it("fails without truncation at every content boundary", () => {
    expect(helper).toContain("CONVERSATION_EXPORT_MAX_MESSAGES = 5_000");
    expect(helper).toContain("CONVERSATION_EXPORT_MAX_THREADS = 1_000");
    expect(helper).toContain("CONVERSATION_EXPORT_MAX_BODY_BYTES = 32 * 1024");
    expect(helper).toContain("CONVERSATION_EXPORT_MAX_LINE_BYTES = 256 * 1024");
    expect(helper).toContain("CONVERSATION_EXPORT_MAX_BYTES = 8 * 1024 * 1024");
    expect(route).toContain('status === 413 ? "conversation_export_too_large"');
    expect(route).toContain('"X-Export-Truncated": "false"');
    expect(route).not.toContain("preflight.slice(");
    expect(helper).not.toContain("rows.slice(");
  });

  it("excludes drafts, internal messages, and unsent outbound effects", () => {
    expect(route).toContain('eq(conversationMessages.direction, "inbound")');
    expect(route).toContain('eq(conversationMessages.direction, "outbound")');
    expect(route).toContain('["sent", "delivered"]');
    expect(route).toContain("metadata}->>'draft'");
    expect(helper).toContain('input.direction === "internal"');
    expect(helper).toContain('input.deliveryStatus === "sent"');
    expect(helper).toContain('input.deliveryStatus === "delivered"');
  });

  it("emits privacy-minimal JSONL and exact receipt evidence", () => {
    expect(helper).toContain("JSON.stringify({ messages })");
    expect(route).not.toContain("toAddress:");
    expect(route).not.toContain("fromAddress:");
    expect(route).not.toContain("providerMessageId:");
    expect(route).not.toContain("contactId:");
    for (const header of [
      "X-Export-Receipt-Id",
      "X-Export-Row-Count",
      "X-Export-Thread-Count",
      "X-Export-Message-Count",
      "X-Export-Byte-Count",
      "X-Export-Audit-State",
      "X-Audit-Correlation-Id",
    ]) {
      expect(route).toContain(`"${header}"`);
    }
  });

  it("uses attempted, prepared, released, failed, and denied audit states", () => {
    const attempt = route.indexOf('action: "conversation.export.attempted"');
    const prepare = route.indexOf(
      "prepareSnapshotExport(getDb(), parsed.query)",
    );
    const prepared = route.indexOf('action: "conversation.export.prepared"');
    expect(attempt).toBeGreaterThan(-1);
    expect(prepare).toBeGreaterThan(attempt);
    expect(prepared).toBeGreaterThan(prepare);
    expect(route).toContain('"conversation.export.released"');
    expect(route).toContain('action: "conversation.export.failed"');
    expect(route).toContain('action: "conversation.export.denied"');
    expect(route).toContain("pg_advisory_xact_lock");
    expect(route).toContain("tx.insert(auditLogs)");
    expect(route).toContain("sensitive: true");
    expect(route).not.toContain("body: row.body");
  });

  it("validates the complete body and release audit before Site release", () => {
    const receipt = siteRoute.indexOf("parseConversationExportReceipt(");
    const read = siteRoute.indexOf("readBoundedExportResponse(", receipt);
    const validate = siteRoute.indexOf("validateConversationJsonl(", read);
    const finalized = siteRoute.indexOf(
      "const released = await finalizeExport(",
      validate,
    );
    const release = siteRoute.indexOf("return new Response(body", finalized);
    expect(receipt).toBeGreaterThan(-1);
    expect(read).toBeGreaterThan(receipt);
    expect(validate).toBeGreaterThan(read);
    expect(finalized).toBeGreaterThan(validate);
    expect(release).toBeGreaterThan(finalized);
    expect(siteHelper).toContain("contentLength !== byteCount");
    expect(siteHelper).toContain("Object.keys(message).length !== 2");
    expect(siteHelper).toContain('new TextDecoder("utf-8", { fatal: true })');
    expect(siteRoute).not.toContain("new NextResponse(upstream.body");
  });

  it("bounds an ambiguous release replay to the identical terminal operation", () => {
    expect(siteHelper).toContain("RELEASE_FINALIZATION_MAX_ATTEMPTS = 2");
    expect(siteHelper).toContain("const body = JSON.stringify({");
    expect(siteHelper).toContain("body,");
    expect(siteHelper).toContain("correlationId: input.correlationId");
    expect(siteHelper).toContain("requireIdempotentReplay");
    expect(siteHelper).toContain("acknowledgement.idempotent");
    expect(siteRoute).toContain("finalizeSiteConversationExport({");
  });

  it("requires confirmed same-origin POST and strict error correlation", () => {
    expect(siteRoute).toContain("export async function POST");
    expect(siteRoute).not.toContain("export async function GET");
    expect(route).toContain("export async function POST");
    expect(route).not.toContain("export async function GET");
    expect(siteRoute).toContain("isSameOriginConversationExportRequest");
    expect(siteRoute).toContain("readSiteConversationExportConfirmation");
    expect(route).toContain("readConversationExportConfirmation");
    expect(siteRoute).toContain("parseConversationExportError(");
    expect(siteHelper).toContain("supportId.toLowerCase()");
    expect(siteHelper).toContain("ConversationExportBodyTimeoutError");
    expect(
      classifyTeamActionRisk(
        "app/api/admin/inbox/export/jsonl/route.ts",
        "POST",
      ),
    ).toBe("read");
    expect(
      classifyTeamActionRisk(
        "app/api/admin/inbox/export/jsonl/route.ts",
        "PUT",
      ),
    ).toBe("read");
  });

  it("explains sensitive scope and provides accessible range/channel controls", () => {
    expect(settings).toContain("Sensitive conversation export");
    expect(settings).toContain("1,000");
    expect(settings).toContain("5,000 eligible messages");
    expect(settings).toContain("Free-form message bodies can still contain");
    expect(settings).toContain("structured contact fields");
    expect(settings).toContain("no partial file");
    expect(settings).toContain("ConversationExportClient");
    expect(settings).toContain("canExportMessages");
    for (const value of [
      "7",
      "30",
      "90",
      "sms",
      "email",
      "dm",
      "call",
      "web",
    ]) {
      expect(settingsClient).toContain(`<option value="${value}">`);
    }
    expect(settingsClient).toContain("I understand that message bodies");
    expect(settingsClient).toContain('role="alert"');
    expect(settingsClient).toContain('aria-live="polite"');
  });
});
