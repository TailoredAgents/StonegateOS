import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

describe("Quote V2 public route boundary", () => {
  it("rate-limits candidate token and trusted network independently before lookup", () => {
    const preflight = source("src/lib/quote-v2-public-rate-limit.ts");
    expect(
      preflight.indexOf("enforceIndependentQuotePublicRateLimits"),
    ).toBeLessThan(
      preflight.indexOf("hashQuoteCapabilityToken(candidateToken)"),
    );
    const rateLimit = source("src/lib/quote-v2-rate-limit.ts");
    const independentStart = rateLimit.indexOf(
      "enforceIndependentQuotePublicRateLimits",
    );
    const independentBranch = rateLimit.slice(independentStart);
    expect(
      independentBranch.indexOf("scope: `${input.scope}:network`"),
    ).toBeLessThan(
      independentBranch.indexOf("scope: `${input.scope}:candidate_token`"),
    );
    expect(independentBranch).toContain('blockedDimension: "network"');

    const publicRoute = source("src/lib/quote-v2-public-route.ts");
    const publicIdentify = publicRoute.slice(
      publicRoute.indexOf("async function identifyCapability"),
      publicRoute.indexOf("maybeHandleQuoteV2PublicGet"),
    );
    expect(publicIdentify.indexOf("limitQuoteV2PublicCandidate")).toBeLessThan(
      publicIdentify.indexOf(
        "const capability = await loadQuoteV2CapabilityByHash",
      ),
    );
    const schedulingRoute = source("src/lib/quote-v2-scheduling-route.ts");
    const schedulingIdentify = schedulingRoute.slice(
      schedulingRoute.indexOf("async function identifyAndLimit"),
      schedulingRoute.indexOf("async function readBody"),
    );
    expect(
      schedulingIdentify.indexOf("limitQuoteV2PublicCandidate"),
    ).toBeLessThan(
      schedulingIdentify.indexOf(
        "capability = await loadQuoteV2CapabilityByHash",
      ),
    );
    const checkoutRoute = source(
      "app/api/public/quotes/[token]/checkout/route.ts",
    );
    const checkoutIdentify = checkoutRoute.slice(
      checkoutRoute.indexOf("async function identifyAndLimit"),
      checkoutRoute.indexOf("export async function POST"),
    );
    expect(
      checkoutIdentify.indexOf("limitQuoteV2PublicCandidate"),
    ).toBeLessThan(
      checkoutIdentify.indexOf(
        "capability = await loadQuoteV2CapabilityByHash",
      ),
    );
  });

  it("forwards only a signed HMAC network class from the customer site", () => {
    const proxy = source(
      "../site/src/app/api/public/quotes/[token]/[[...segments]]/route.ts",
    );
    expect(proxy).toContain("quotePublicProxyNetworkHeaders(request, target)");
    expect(proxy).not.toContain('upstreamHeaders.set("x-forwarded-for"');
    const network = source("../site/src/lib/quote-public-proxy-network.ts");
    expect(network).toContain("QUOTE_PUBLIC_TRUSTED_PROXY_HOPS");
    expect(network).toContain("quote-v2-rate-limit:network-class");
    expect(network).toContain("QUOTE_PUBLIC_PROXY_SHARED_SECRET");
    expect(network).not.toMatch(/upstreamHeaders|clientIp|rawIp/u);

    const page = source("../site/src/app/quote/[token]/page.tsx");
    expect(page).toContain("quotePublicProxyNetworkHeaders(");
    expect(page.match(/quoteApiHeaders\("GET",/gu)).toHaveLength(2);
    expect(page.match(/quoteApiHeaders\("POST",/gu)).toHaveLength(4);
    expect(page).not.toContain('"x-forwarded-for"');
    const pdf = source("../site/src/app/quote/[token]/pdf/route.ts");
    expect(pdf).toContain("quotePublicProxyNetworkHeaders(request, target)");
    expect(pdf).not.toContain('"x-forwarded-for"');
    expect(pdf).toContain('response.headers.get("retry-after")');
  });

  it("branches capability reads and decisions before the legacy bearer lookup", () => {
    const route = source("app/api/public/quotes/[token]/route.ts");
    expect(
      route.indexOf("maybeHandleQuoteV2PublicGet(request, token)"),
    ).toBeLessThan(route.indexOf("eq(quotes.shareToken, token)"));
    expect(
      route.indexOf("maybeHandleQuoteV2PublicDecision(request, token)"),
    ).toBeLessThan(route.lastIndexOf("eq(quotes.shareToken, token)"));

    const changes = source("app/api/public/quotes/[token]/changes/route.ts");
    expect(
      changes.indexOf("maybeHandleQuoteV2PublicChange(request, token)"),
    ).toBeLessThan(changes.indexOf("eq(quotes.shareToken, token)"));
  });

  it("resolves V2 capabilities only by token hash and emits ID-only outbox payloads", () => {
    const service = source("src/lib/quote-v2-public-service.ts");
    expect(service).toContain(
      "eq(quoteCapabilities.tokenHash, input.tokenHash)",
    );
    expect(service).toContain("schemaVersion: 2");
    const helperStart = service.indexOf("async function insertV2OutboxEvent");
    const payloadStart = service.indexOf("const payload = {", helperStart);
    const payloadEnd = service.indexOf(
      "};\n  parseQuoteV2OutboxEvent",
      payloadStart,
    );
    const payload = service.slice(payloadStart, payloadEnd);
    expect(payload).toContain("quoteId: input.quoteId");
    expect(payload).toContain("versionId: input.versionId");
    expect(payload).toContain("responseId: input.responseId");
    expect(payload).not.toMatch(/token|email|phone|address|signer|message/iu);
  });

  it("creates the owner task first and never mutates frozen accepted options", () => {
    const service = source("src/lib/quote-v2-public-service.ts");
    const terminal = source("src/lib/quote-v2-terminal-decision.ts");
    const changeStart = service.indexOf("recordQuoteV2ChangeRequest");
    expect(service.indexOf(".insert(crmTasks)", changeStart)).toBeLessThan(
      service.indexOf(".insert(quoteChangeRequests)", changeStart),
    );
    expect(service).toContain("persistQuoteV2TerminalDecision");
    const versionUpdate = terminal.slice(
      terminal.indexOf(".update(quoteVersions)"),
      terminal.indexOf(".update(quotes)"),
    );
    expect(versionUpdate).toContain("state: input.decision");
    expect(versionUpdate).not.toContain("selectedOptionIds");
  });

  it("proxies the immutable V2 PDF before legacy generation and records no raw IP", () => {
    const pdfRoute = source("app/api/public/quotes/[token]/pdf/route.ts");
    expect(
      pdfRoute.indexOf("maybeHandleQuoteV2PublicPdf(request, token)"),
    ).toBeLessThan(pdfRoute.indexOf("eq(quotes.shareToken, token)"));
    const publicRoute = source("src/lib/quote-v2-public-route.ts");
    const pdfStart = publicRoute.indexOf("maybeHandleQuoteV2PublicPdf");
    const pdfEnd = publicRoute.indexOf(
      "async function readMutationBody",
      pdfStart,
    );
    const pdfBranch = publicRoute.slice(pdfStart, pdfEnd);
    expect(pdfBranch).toContain("getMediaObject");
    expect(pdfBranch).toContain('createHash("sha256")');
    expect(pdfBranch).toContain("quoteVersionId");
    expect(pdfBranch).not.toContain("x-forwarded-for");
    expect(pdfBranch).not.toContain("ipAddress");
  });

  it("serves customer attachments only through the exact capability version", () => {
    const attachmentRoute = source(
      "app/api/public/quotes/[token]/attachments/[attachmentId]/route.ts",
    );
    expect(attachmentRoute).toContain("maybeHandleQuoteV2PublicAttachment");
    const publicRoute = source("src/lib/quote-v2-public-route.ts");
    const start = publicRoute.indexOf("maybeHandleQuoteV2PublicAttachment");
    const branch = publicRoute.slice(start);
    expect(branch).toContain("identified.capability.versionId");
    expect(branch).toContain("customerVisibleOnly: true");
    expect(branch).toContain("loadQuoteV2AttachmentContent");
    expect(branch).not.toContain("createMediaReadUrl");
  });

  it("rejects stale checkout commands before consulting Square configuration", () => {
    const service = source("src/lib/quote-v2-deposit-service.ts");
    const start = service.indexOf(
      "export async function createQuoteV2DepositCheckout",
    );
    const branch = service.slice(start);
    expect(
      branch.indexOf("assertCheckoutAction(row, input, now)"),
    ).toBeLessThan(branch.indexOf('requiredEnvironment("SQUARE_LOCATION_ID")'));
    expect(branch.indexOf("loadAcceptedResponse(tx, input)")).toBeLessThan(
      branch.indexOf('requiredEnvironment("SQUARE_LOCATION_ID")'),
    );
    expect(
      branch.indexOf("const reservation = await db.transaction"),
    ).toBeLessThan(
      branch.indexOf('requiredEnvironment("SQUARE_POS_STATE_SECRET")'),
    );
  });

  it("counts only browser-confirmed visible engagement instead of proposal GETs", () => {
    const publicRoute = source("src/lib/quote-v2-public-route.ts");
    const getStart = publicRoute.indexOf("maybeHandleQuoteV2PublicGet");
    const engagementStart = publicRoute.indexOf(
      "maybeHandleQuoteV2VisibleEngagement",
    );
    const getBranch = publicRoute.slice(getStart, engagementStart);
    const engagementEnd = publicRoute.indexOf(
      "function safePdfFilename",
      engagementStart,
    );
    const engagementBranch = publicRoute.slice(engagementStart, engagementEnd);
    expect(getBranch).not.toContain("recordQuoteV2CapabilityUse");
    expect(engagementBranch).toContain("quoteVisibleEngagementEvents");
    expect(engagementBranch).toContain("idempotencyKeyHash: idempotency.hash");
    expect(engagementBranch).not.toContain("quoteActivityEvents");
    expect(engagementBranch).toContain("pg_advisory_xact_lock");
    expect(engagementBranch).toContain("recordQuoteV2CapabilityUse(tx");
    expect(engagementBranch).not.toMatch(/x-forwarded-for|ipAddress/iu);
    const route = source("app/api/public/quotes/[token]/engagement/route.ts");
    expect(route).toContain("maybeHandleQuoteV2VisibleEngagement");
    const proxy = source(
      "../site/src/app/api/public/quotes/[token]/[[...segments]]/route.ts",
    );
    expect(proxy).toContain('"engagement"');
  });
});
