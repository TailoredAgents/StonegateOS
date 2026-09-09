import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { z } from "zod";
import { closeDbForTests, getDb, partnerAccounts, partnerInvoices, partnerBillingDocumentOperations, partnerBillingRefundRequests, payments, teamMembers } from "@/db";

const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (name: string, factory: () => Record<string, unknown>) => void;
const permission = jest.fn<() => Promise<Response | null>>().mockResolvedValue(null);
mockModule("@/lib/permissions", () => ({ requirePermission: permission }));
const HistoryResponse = z.object({ ok: z.literal(true), accountId: z.string().uuid(), invoiceId: z.string().uuid(), kind: z.enum(["documents", "refunds"]),
  items: z.array(z.object({ id: z.string().uuid(), createdAt: z.string() }).passthrough()), nextCursor: z.string().nullable() }).passthrough();
const { GET } = await import("../../app/api/admin/partner-management/v1/accounts/[accountId]/billing/invoices/[invoiceId]/history/route");
const local = process.env["DATABASE_URL"] && ["127.0.0.1", "localhost"].includes(new URL(process.env["DATABASE_URL"]).hostname);
const suite = local ? describe : describe.skip;
type Fixture = { accountId: string; invoiceId: string; siblingId: string; documentIds: string[]; refundIds: string[] };
async function fixture(documentCount = 521, refundCount = 537): Promise<Fixture> {
  const accountId = randomUUID(), invoiceId = randomUUID(), siblingId = randomUUID(), actorId = randomUUID(), paymentId = randomUUID();
  const documentIds = Array.from({ length: documentCount }, () => randomUUID());
  const refundIds = Array.from({ length: refundCount }, () => randomUUID());
  await getDb().transaction(async (tx) => {
    await tx.insert(teamMembers).values({ id: actorId, name: "Local history reader", active: true });
    await tx.insert(partnerAccounts).values({ id: accountId, name: "Local billing history", normalizedName: `history-${accountId}`, status: "active_partner" });
    await tx.insert(partnerInvoices).values([invoiceId, siblingId].map((id) => ({ id, partnerAccountId: accountId, invoiceNumber: `LOCAL-${id}`, subtotalCents: 1000, totalCents: 1000, balanceCents: 1000, billingContact: {} })));
    await tx.insert(payments).values({ id: paymentId, provider: "manual", providerPaymentId: paymentId, amount: 1000, jobAmountCents: 1000,
      totalAmountCents: 1000, currency: "USD", method: "cash", status: "completed", canonicalStatus: "completed", providerStatus: "COMPLETED" });
    // Equal timestamps, including microseconds, force the stable UUID tie-break.
    const createdAt = sql`'2026-09-01T12:00:00.123456Z'::timestamptz`;
    if (documentIds.length) await tx.insert(partnerBillingDocumentOperations).values(documentIds.map((id) => ({ id, partnerAccountId: accountId,
      partnerInvoiceId: invoiceId, sourceKey: id, documentType: "invoice", version: 1, snapshot: { private: "NEVER_SERIALIZE_SNAPSHOT" },
      snapshotHash: "0".repeat(64), createdAt })));
    if (refundIds.length) await tx.insert(partnerBillingRefundRequests).values(refundIds.map((id) => ({ id, partnerAccountId: accountId, partnerInvoiceId: invoiceId,
      paymentId, amountCents: 1, reason: "NEVER_SERIALIZE_REFUND_REASON", providerRefundId: `PRIVATE_PROVIDER_${id}`, requestedBy: actorId, createdAt })));
    await tx.insert(partnerBillingDocumentOperations).values({ partnerAccountId: accountId, partnerInvoiceId: siblingId, sourceKey: siblingId,
      documentType: "invoice", version: 1, snapshot: {}, snapshotHash: "0".repeat(64), createdAt });
  });
  return { accountId, invoiceId, siblingId, documentIds, refundIds };
}
function read(ids: Pick<Fixture, "accountId" | "invoiceId">, query = "kind=documents") {
  return GET(new NextRequest(`https://api.example.test/api/admin/partner-management/v1/accounts/${ids.accountId}/billing/invoices/${ids.invoiceId}/history?${query}`),
    { params: Promise.resolve(ids) });
}

suite("staff invoice child-history GET with real local PostgreSQL", () => {
  let ids: Fixture;
  beforeAll(async () => { ids = await fixture(); });
  beforeEach(() => { permission.mockReset().mockResolvedValue(null); });
  afterAll(closeDbForTests); // Evidence stays only in the disposable local DB.

  it.each(["documents", "refunds"])("retrieves every %s record beyond 500, with a stable same-timestamp cursor and safe fields", async (kind) => {
    const found: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await read(ids, `kind=${kind}&limit=100${cursor ? `&cursor=${cursor}` : ""}`);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const body = HistoryResponse.parse(await response.json());
      expect(body).toMatchObject({ ok: true, accountId: ids.accountId, invoiceId: ids.invoiceId, kind });
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.items.length).toBeLessThanOrEqual(100);
      expect(JSON.stringify(body)).not.toMatch(/NEVER_SERIALIZE|PRIVATE_PROVIDER|snapshot|providerRefundId|reason/u);
      expect(body.items.every((row: { createdAt: string }) => row.createdAt === "2026-09-01T12:00:00.123456Z")).toBe(true);
      found.push(...body.items.map((row: { id: string }) => row.id));
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor);
    const expected = kind === "documents" ? ids.documentIds : ids.refundIds;
    expect(pages).toBe(6);
    expect(found).toEqual([...expected].sort().reverse());
    expect(new Set(found).size).toBe(expected.length);
    expect(permission).toHaveBeenCalledWith(expect.anything(), "partners.commercial.read");
  });

  it("denies cross-account invoices and binds cursors to invoice, account, kind and page size", async () => {
    const other = await fixture(1, 1);
    expect((await read({ accountId: other.accountId, invoiceId: ids.invoiceId })).status).toBe(404);
    const first = HistoryResponse.parse(await (await read(ids)).json());
    expect(first.items).toHaveLength(50);
    const token = first.nextCursor;
    for (const [target, query] of [
      [ids, `kind=refunds&cursor=${token}`],
      [ids, `kind=documents&limit=100&cursor=${token}`],
      [{ accountId: ids.accountId, invoiceId: ids.siblingId }, `kind=documents&cursor=${token}`],
      [other, `kind=documents&cursor=${token}`],
    ] as const) expect((await read(target, query)).status).toBe(400);
    const sibling = HistoryResponse.parse(await (await read({ accountId: ids.accountId, invoiceId: ids.siblingId })).json());
    expect(sibling.items).toHaveLength(1);
    expect(sibling.nextCursor).toBeNull();
  });

  it("rejects invalid/duplicate/unbounded filters and unknown invoices", async () => {
    for (const query of ["kind=documents&limit=101", "kind=documents&cursor=invalid", "kind=documents&kind=refunds", "kind=documents&extra=1", "kind=unknown", "kind=documents&cursor=", "kind=documents&limit=0"])
      expect((await read(ids, query)).status).toBe(400);
    expect((await read({ accountId: ids.accountId, invoiceId: randomUUID() })).status).toBe(404);
  });

  it("checks financial permission before reading params or the database", async () => {
    const denied = Response.json({ ok: false, error: "forbidden" }, { status: 403 });
    permission.mockResolvedValue(denied);
    const context = { get params(): Promise<{ accountId: string; invoiceId: string }> { throw new Error("must not read target"); } };
    expect(await GET(new NextRequest("https://api.example.test/"), context)).toBe(denied);
  });
});
