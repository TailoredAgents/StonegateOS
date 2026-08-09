import { readFileSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = process.cwd();
const REPO_ROOT = join(API_ROOT, "../..");

function apiSource(relativePath: string): string {
  return readFileSync(join(API_ROOT, relativePath), "utf8");
}

function repoSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

function functionSlice(source: string, start: string, end?: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = end ? source.indexOf(end, startIndex + start.length) : -1;
  return source.slice(startIndex, endIndex >= 0 ? endIndex : undefined);
}

describe("quote lifecycle mutation safety", () => {
  const quoteCollectionRoute = apiSource("app/api/quotes/route.ts");
  const creation = functionSlice(
    quoteCollectionRoute,
    "export async function POST",
  );
  const send = apiSource("app/api/quotes/[id]/send/route.ts");
  const decision = apiSource("app/api/quotes/[id]/decision/route.ts");
  const publicQuote = apiSource("app/api/public/quotes/[token]/route.ts");
  const quoteRoute = apiSource("app/api/quotes/[id]/route.ts");
  const update = functionSlice(
    quoteRoute,
    "export async function PATCH",
    "export async function DELETE",
  );
  const deletion = functionSlice(quoteRoute, "export async function DELETE");
  const actions = repoSource("apps/site/src/app/team/actions.ts");
  const quoteList = repoSource("apps/site/src/app/team/QuotesList.tsx");
  const inboxWorkspace = repoSource(
    "apps/site/src/app/team/components/InboxCustomerWorkspaceClient.tsx",
  );
  const mobileActions = repoSource("apps/site/src/app/mobile/actions.ts");
  const mobilePage = repoSource("apps/site/src/app/mobile/page.tsx");
  const publicPage = repoSource("apps/site/src/app/quote/[token]/page.tsx");
  const publicQuoteLayout = repoSource("apps/site/src/app/quote/layout.tsx");
  const quoteBuilder = repoSource(
    "apps/site/src/app/team/components/QuoteBuilderClient.tsx",
  );
  const mutationFeedback = repoSource(
    "apps/site/src/app/team/lib/mutation-feedback.ts",
  );
  const migration = apiSource(
    "src/db/migrations/0077_public_quote_mutation_receipts.sql",
  );
  const notifications = apiSource("src/lib/notifications.ts");
  const salesDisposition = apiSource(
    "app/api/admin/sales/disposition/route.ts",
  );
  const threadDisposition = apiSource(
    "app/api/admin/inbox/threads/[threadId]/route.ts",
  );

  it("create establishes its human write boundary before parsing the body or opening the database", () => {
    const boundary = creation.indexOf("await beginTeamMutation(request");
    expect(boundary).toBeGreaterThanOrEqual(0);
    expect(creation).toContain('principalTypes: ["human"]');
    expect(creation).toContain('requiredPermissions: ["quotes.write"]');
    expect(creation).toContain('risk: "normal"');
    expect(creation).toContain("requiresIdempotency: true");
    expect(creation).toContain('auditAction: "quote.created"');
    expect(boundary).toBeLessThan(creation.indexOf("await request.json"));
    expect(boundary).toBeLessThan(creation.indexOf("db = getDb()"));
  });

  it.each([
    ["update", update, "quotes.update", "normal", "quote.updated"],
    ["send", send, "quotes.send", "external", "quote.sent"],
    ["decision", decision, "quotes.update", "normal", "quote.decision"],
    ["delete", deletion, "quotes.delete", "destructive", "quote.deleted"],
  ])(
    "%s establishes authorization before request-controlled input",
    (_name, source, permission, risk, auditAction) => {
      const boundary = source.indexOf("await beginTeamMutation(request");
      expect(boundary).toBeGreaterThanOrEqual(0);
      expect(source).toContain(`requiredPermissions: ["${permission}"]`);
      expect(source).toContain(`risk: "${risk}"`);
      expect(source).toContain("requiresIdempotency: true");
      expect(source).toContain(`auditAction: "${auditAction}"`);
      expect(boundary).toBeLessThan(source.indexOf("await context.params"));
      expect(boundary).toBeLessThan(source.indexOf("await request.json"));
    },
  );

  it.each([
    ["create", creation],
    ["update", update],
    ["send", send],
    ["decision", decision],
    ["delete", deletion],
  ])("%s records privacy-safe failed mutation evidence", (_name, source) => {
    expect(source).toContain("recordTeamMutationFailure");
    expect(source).toContain('phase: "request_validation"');
    expect(source).toContain('phase: "mutation"');
    expect(source).not.toContain("metadata: parsedBody.data");
  });

  it.each([
    ["update", update],
    ["send", send],
    ["decision", decision],
    ["delete", deletion],
  ])(
    "%s uses a caller key, current version, row lock, CAS, and atomic receipt",
    (_name, source) => {
      expect(source).toContain("claimTeamMutationIdempotency");
      expect(source).toContain("teamMutationIdempotencyReplayResponse");
      expect(source).toContain("mutation.expectedVersion");
      expect(source).toContain("assertTeamMutationExpectedVersion");
      expect(source).toContain('.for("update")');
      expect(source).toContain("eq(quotes.revision, existing.revision)");
      expect(source).toContain("mutation.audit.insertSuccess(tx");
      expect(source).toContain("completeTeamMutationIdempotency(");
      expect(source.indexOf("mutation.audit.insertSuccess(tx")).toBeLessThan(
        source.indexOf("completeTeamMutationIdempotency("),
      );
      expect(source).toContain("settleTeamMutationIdempotencyFailure");
    },
  );

  it("create claims/replays the caller key and co-commits its quote, verified audit, and receipt", () => {
    expect(creation).toContain("claimTeamMutationIdempotency");
    expect(creation).toContain("teamMutationIdempotencyReplayResponse");
    expect(creation).toContain("const result = await db.transaction");
    expect(creation).toContain(".insert(quotes)");
    expect(creation).toContain("mutation.audit.insertSuccess(tx");
    expect(creation).toContain("completeTeamMutationIdempotency(");
    expect(creation.indexOf("mutation.audit.insertSuccess(tx")).toBeLessThan(
      creation.indexOf("completeTeamMutationIdempotency("),
    );
    expect(creation).toContain("settleTeamMutationIdempotencyFailure");
    expect(creation).toContain("teamMutationSuccessResult(");
    expect(creation).toContain("teamMutationResultResponse(result, 201");
  });

  it("increments every edited quote revision under a row lock and CAS", () => {
    expect(update).toContain("assertTeamMutationExpectedVersion");
    expect(update).toContain('.for("update")');
    expect(update).toContain("const nextRevision = existing.revision + 1");
    expect(update).toContain("revision: nextRevision");
    expect(update).toContain("eq(quotes.revision, existing.revision)");
    expect(update).toContain("The quote changed while it was being updated");
  });

  it("keeps customer-visible pending drafts pending until an explicit send", () => {
    expect(update).toContain(
      "const customerVisible = Boolean(existing.shareToken)",
    );
    expect(update).toContain("status: existing.status");
    expect(update).not.toContain('wasShared ? "sent"');
    expect(update).toContain("Editing a customer-visible quote does not erase");
    expect(update).not.toContain("viewedAt: null");
    expect(update).not.toContain("lastViewedAt: null");
    expect(update).not.toContain("viewCount: 0");
  });

  it("requires send permission for shareable creation without claiming that a provider send occurred", () => {
    expect(quoteCollectionRoute).toContain(
      'requirePermission(request, "quotes.send")',
    );
    expect(creation).toContain("await requireShareableQuotePermission(");
    expect(
      creation.indexOf("await requireShareableQuotePermission("),
    ).toBeLessThan(creation.indexOf("db = getDb()"));
    expect(creation).toContain('status: "pending"');
    expect(creation).toContain("sentAt: null");
    expect(creation).not.toContain("outboxEvents");
  });

  it("keeps generated share tokens out of create and update audit payloads", () => {
    const createAudit = functionSlice(
      creation,
      "const audit = await mutation.audit.insertSuccess",
      "const mutationResult",
    );
    const updateAudit = functionSlice(
      update,
      "const audit = await mutation.audit.insertSuccess",
      "const mutationResult",
    );
    expect(createAudit).not.toContain("shareToken");
    expect(updateAudit).not.toContain("shareToken");
  });

  it("co-commits send work and internal decision workflow evidence without leaking the share token", () => {
    expect(send).toContain(".insert(outboxEvents)");
    expect(decision).toContain(".insert(outboxEvents)");
    expect(send).toContain("const sendAttemptId = buildQuoteSendAttemptId(");
    expect(send).toContain("sendAttemptId,");
    expect(decision).toContain('type: "pipeline.auto_stage_change"');
    expect(decision).not.toContain('type: "quote.decision"');
    expect(decision).toContain("customerNotificationQueued: false");
    expect(decision).toContain('existing.status !== "sent"');
    expect(decision).toContain("!existing.sentAt");
    expect(decision).toContain(".insert(crmPipeline)");
    expect(decision).toContain(".update(leadAutomationStates)");
    const sendAudit = functionSlice(
      send,
      "const audit = await mutation.audit.insertSuccess",
      "const mutationResult",
    );
    expect(sendAudit).toContain("outboxEventId");
    expect(sendAudit).not.toContain("shareToken");
    const sendOutbox = functionSlice(
      send,
      ".insert(outboxEvents)",
      "const audit = await mutation.audit.insertSuccess",
    );
    expect(sendOutbox).not.toContain("shareToken");
    expect(send).toContain("data: { ...mutationResult.data, shareUrl: null }");
    expect(creation).toContain(
      "data: { ...mutationResult.data, shareUrl: null }",
    );
    expect(migration).toContain("Scrub capabilities copied by pre-0077");
    expect(migration).toContain("#- '{data,quote,shareToken}'");
    expect(notifications).toContain("QUOTE_LINK_AI_PLACEHOLDER");
    expect(notifications).toContain("materializeGeneratedQuoteCopy(");
    expect(notifications).not.toContain("shareUrl: payload.shareUrl");
    expect(notifications).toContain(
      "!generated.emailSubject.includes(QUOTE_LINK_AI_PLACEHOLDER)",
    );
    expect(publicQuoteLayout).not.toContain("PublicMarketingTags");
    expect(publicQuoteLayout).toContain("telemetry-free");
    expect(publicQuoteLayout).toContain('referrer: "no-referrer"');
    expect(publicQuoteLayout).toContain("index: false");
  });

  it("locks and validates an active deliverable contact before marking a quote sent", () => {
    const contactGuard = send.indexOf(
      "await requireActiveContactForDirectOutbound(",
    );
    const quoteUpdate = send.indexOf(".update(quotes)", contactGuard);
    expect(contactGuard).toBeGreaterThan(-1);
    expect(quoteUpdate).toBeGreaterThan(contactGuard);
    expect(send).toContain("deliveryContact.doNotContact");
    expect(send).toContain("resolveUsableQuoteDeliveryChannels(");
    expect(send).toContain("Add a valid phone number or email address");
  });

  it("persists Inbox DNC choices to the canonical contact under the dispatch lock", () => {
    expect(salesDisposition).toContain("pg_advisory_xact_lock");
    expect(salesDisposition).toContain('.for("update")');
    expect(salesDisposition).toContain("doNotContact: true");
    expect(salesDisposition).toContain("doNotContactAt: now");
    expect(salesDisposition).toContain("doNotContactBy: mutation.actor.id");
    expect(threadDisposition).toContain("pg_advisory_xact_lock");
    expect(threadDisposition).toContain("doNotContact: true");
  });

  it("makes the public customer decision terminal, CAS-protected, and atomic with its workflow event", () => {
    const post = functionSlice(publicQuote, "export async function POST");
    expect(post).toContain("db.transaction(async (tx)");
    expect(post).toContain('.for("update")');
    expect(post).toContain('quote.status === "accepted"');
    expect(post).toContain('quote.status === "declined"');
    expect(post).toContain("const nextRevision = quote.revision + 1");
    expect(post).toContain("eq(quotes.revision, quote.revision)");
    expect(post).toContain('type: "quote.decision"');
    expect(post).toContain('source: "customer"');
    expect(post).toContain(".insert(crmPipeline)");
    expect(post).toContain(".update(leadAutomationStates)");
    expect(post.indexOf(".update(quotes)")).toBeLessThan(
      post.indexOf(".insert(outboxEvents)"),
    );
    expect(post).not.toContain("console.");
    expect(post).toContain("normalizePublicQuoteIdempotencyKey");
    expect(post).toContain("publicQuoteMutationKeyHash");
    expect(post).toContain("publicQuoteMutationRequestHash");
    expect(post).toContain("publicQuoteMutationReceipts");
    expect(post).toContain('outcome: "succeeded"');
    expect(post).toContain('quote.status === "sent"');
    expect(post).toContain('"refresh_already_requested"');
    expect(post).toContain('"quote_not_expired"');
    expect(post).toContain('kind: "refresh_not_allowed"');
    const receiptInsert = functionSlice(
      post,
      "await tx.insert(publicQuoteMutationReceipts).values({",
      'return { kind: "decided"',
    );
    expect(receiptInsert).not.toMatch(/\btoken\s*[,}:]/u);
  });

  it("makes public quote callers prove a valid response before showing success", () => {
    expect(publicPage).toContain("postPublicQuoteAction");
    expect(publicPage).toContain("!response.ok");
    expect(publicPage).toContain("!isPublicQuoteMutationSuccess");
    expect(publicPage).toContain('candidate["quoteId"] !== expectedQuoteId');
    expect(publicPage).toContain('"Idempotency-Key": input.idempotencyKey');
    expect(publicPage).toContain("approval=failed");
    expect(publicPage).toContain("decision=failed");
    expect(publicPage).toContain("refresh=failed");
    expect(publicPage).toContain('quote.status === "sent"');
    expect(publicPage).toContain("Read-only staff preview");
    expect(publicPage).toContain("{!preview ? (");
    expect(publicPage).toContain("{!preview &&");
  });

  it("keeps customer link creation and provider delivery explicit and permission gated", () => {
    expect(quoteBuilder).toContain("React.useState(false)");
    expect(quoteBuilder).toContain("setSendQuote(false)");
    expect(quoteBuilder).toContain("setShareQuote(false)");
    expect(quoteBuilder).toContain("{canSend ? (");
    expect(quoteBuilder).toContain("Create a customer link");
    expect(quoteBuilder).toContain("Send immediately");
    expect(quoteBuilder).toContain("Private draft");
    expect(mobilePage).toContain("const canUpdateQuotes = hasMobilePermission");
    expect(mobilePage).toContain("const canSendQuotes = hasMobilePermission");
    expect(mobilePage).toContain("{canSendQuotes &&");
    expect(mobilePage).toContain("{canUpdateQuotes &&");
    expect(mobilePage).toContain("Accept internally");
    expect(mobilePage).toContain("Decline internally");
  });

  it("requires a valid Team mutation envelope and receipt at every quote caller", () => {
    expect(mutationFeedback).toContain("isTeamMutationSuccessEnvelope");
    expect(mutationFeedback).toContain("await response.json().catch");
    expect(mutationFeedback).toContain('value["ok"] !== true');
    expect(mutationFeedback).toContain(
      'isNonEmptyString(receipt["operationId"])',
    );
    expect(mutationFeedback).toContain('isNonEmptyString(receipt["actorId"])');
    expect(actions).toContain("readTeamMutationSuccess");
    expect(mobileActions).toContain("readTeamMutationSuccess");
  });

  it("permits destructive deletion only for an unsent draft", () => {
    expect(deletion).toContain('existing.status !== "pending"');
    expect(deletion).toContain("existing.shareToken");
    expect(deletion).toContain("existing.sentAt");
    expect(deletion).toContain("existing.acceptedAppointmentId");
    expect(deletion).toContain("Only an unsent draft quote can be deleted");
  });

  it("carries stable per-render keys, versions, and explicit confirmations from the UI", () => {
    expect(quoteList).toContain('name="expectedVersion"');
    expect(quoteList).toContain('name="idempotencyKey"');
    expect(quoteList).toContain('value="send_quote"');
    expect(quoteList).toContain('value="set_quote_decision"');
    expect(quoteList).toContain('value="delete_quote"');
    expect(quoteList).toContain("canDelete && deletable");
    expect(actions).toContain('"Idempotency-Key": idempotencyKey.trim()');
    expect(actions).toContain('"If-Match": expectedVersion.trim()');
    expect(actions).toContain("JSON.stringify({ confirmation })");
    expect(actions).toContain("JSON.stringify({ decision, confirmation })");
    expect(actions).toContain(
      "Quote decision recorded internally. No customer message was sent.",
    );
    expect(actions).toContain('confirmation: "create_quote"');
    expect(actions).toContain('headers: { "Idempotency-Key": idempotencyKey }');
    expect(actions).toContain("envelope.data.quote?.id");
    expect(inboxWorkspace).toContain('name="idempotencyKey"');
    expect(inboxWorkspace).toContain('value="create_quote"');
    expect(mobileActions).toContain('confirmation: "update_quote"');
    expect(mobileActions).toContain('"If-Match": expectedVersion');
    expect(mobileActions).toContain("envelope.data.quote?.id");
    expect(mobilePage).toContain("quote-mobile-update:");
    expect(mobilePage).toContain('value="update_quote"');
  });
});
