import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { appointments, closeDbForTests, contacts, getDb, partnerAccounts, partnerAccountCostCenters, partnerAccountLocations, partnerAccountMemberships, partnerBillingDocumentOperations, partnerBookings, partnerDocumentAccessLogs, partnerDocuments, partnerInvoices, partnerStatements, partnerUsers, properties } from "@/db";
const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (name: string, factory: () => Record<string, unknown>) => void;
const objects = new Map<string, Buffer>();
const signedReads: Array<{ key: string; expiresIn: number }> = [];
mockModule("@/lib/media-storage", () => ({
  getMediaStorageBucket: () => "local-private-billing-test",
  createMediaReadUrl: (key: string, expiresIn: number) => {
    signedReads.push({ key, expiresIn });
    return Promise.resolve(`https://local-storage.example.test/${encodeURIComponent(key)}`);
  },
  tryHeadMediaObject: (key: string) => Promise.resolve(objects.has(key) ? { byteLength: objects.get(key)!.length } : null),
  getMediaObject: (key: string) => { const value = objects.get(key); return value ? Promise.resolve(value) : Promise.reject(new Error("local_object_missing")); },
  putImmutableMediaObject: ({ key, body }: { key: string; body: Buffer }) => {
    const existing = objects.get(key); if (existing && !existing.equals(body)) return Promise.reject(new Error("local_immutable_bytes_conflict"));
    objects.set(key, body); return Promise.resolve(existing ? "already_exists" : "created");
  },
}));
const { processPartnerBillingDocumentOperation, queuePartnerBillingDocument } = await import("@/lib/partner-billing-documents");
const { createPartnerDocumentDownloadIntent } = await import("@/lib/partner-portal-v2-documents");
const local = process.env["DATABASE_URL"] && ["127.0.0.1", "localhost"].includes(new URL(process.env["DATABASE_URL"]).hostname);
const describeLocal = local ? describe : describe.skip;

async function downloadFixture() {
  const accountId = randomUUID(), foreignAccountId = randomUUID(), userId = randomUUID(), membershipId = randomUUID();
  const propertyId = randomUUID(), locationId = randomUUID(), contactId = randomUUID(), appointmentId = randomUUID(), bookingId = randomUUID();
  const costCenterId = randomUUID(), foreignCostCenterId = randomUUID();
  const documentId = randomUUID(), accountDocumentId = randomUUID(), foreignDocumentId = randomUUID();
  const email = `${userId}@example.test`;
  await getDb().transaction(async (tx) => {
    await tx.insert(partnerAccounts).values([accountId, foreignAccountId].map((id) => ({ id, name: "Local document access", normalizedName: id, status: "active_partner" as const })));
    await tx.insert(partnerUsers).values({ id: userId, name: "Local billing user", email, normalizedEmail: email, active: true, identityStatus: "active" });
    await tx.insert(partnerAccountMemberships).values({ id: membershipId, partnerAccountId: accountId, partnerUserId: userId, roleKey: "billing_approver", status: "active", acceptedAt: new Date() });
    await tx.insert(contacts).values({ id: contactId, firstName: "Local", lastName: "Document" });
    await tx.insert(properties).values({ id: propertyId, contactId, addressLine1: "1 Local Way", city: "Atlanta", state: "GA", postalCode: "30301" });
    await tx.insert(partnerAccountLocations).values({ id: locationId, partnerAccountId: accountId, propertyId, siteName: "Local document site", addressLine1: "1 Local Way", city: "Atlanta", state: "GA", postalCode: "30301" });
    await tx.insert(appointments).values({ id: appointmentId, contactId, propertyId, partnerAccountId: accountId, type: "job", status: "requested", rescheduleToken: randomUUID() });
    await tx.insert(partnerBookings).values({ id: bookingId, orgContactId: contactId, partnerAccountId: accountId, appointmentId, propertyId });
    await tx.insert(partnerAccountCostCenters).values([
      { id: costCenterId, partnerAccountId: accountId, code: "LOCAL-DOCUMENT", name: "Local cost center" },
      { id: foreignCostCenterId, partnerAccountId: foreignAccountId, code: "LOCAL-DOCUMENT", name: "Same code, different account" },
    ]);
    await tx.insert(partnerInvoices).values({ partnerAccountId: accountId, partnerBookingId: bookingId, invoiceNumber: `DOC-${randomUUID()}`, subtotalCents: 100, totalCents: 100, balanceCents: 100, billingContact: {}, costCenter: "LOCAL-DOCUMENT" });
    await tx.insert(partnerDocuments).values([
      { id: documentId, partnerAccountId: accountId, partnerBookingId: bookingId },
      { id: accountDocumentId, partnerAccountId: accountId, partnerBookingId: null },
      { id: foreignDocumentId, partnerAccountId: foreignAccountId, partnerBookingId: null },
    ].map((document) => ({ ...document, documentType: "invoice", filename: "Local invoice.pdf", contentType: "application/pdf", byteSize: 5, storageBucket: "local-private-billing-test", storageObjectKey: `local-document/${document.id}.pdf`, sha256: "a".repeat(64) })));
  });
  const input: Parameters<typeof createPartnerDocumentDownloadIntent>[0] = {
    accountId, documentId, membershipId, partnerUserId: userId, email, roleKey: "billing_approver", accessLevel: "account", accessScope: {}, sessionId: randomUUID(), correlationId: randomUUID(),
  };
  return { input, propertyId, locationId, costCenterId, foreignCostCenterId, accountDocumentId, foreignDocumentId };
}

describeLocal("financial document worker with real local PostgreSQL and in-memory private storage", () => {
  afterAll(closeDbForTests);
  it("renders immutable PDF bytes once across concurrent delivery and inserts only one statement/document", async () => {
    const accountId = randomUUID(); const db = getDb();
    await db.insert(partnerAccounts).values({ id: accountId, name: "Local statement test", normalizedName: `statement-${accountId}`, status: "active_partner" });
    const operationId = await db.transaction((tx) => queuePartnerBillingDocument(tx, { accountId, bookingId: null, invoiceId: null,
      sourceKey: "2026-09-01/2026-09-30/USD", kind: "statement", snapshot: { title: "Statement", number: "LOCAL-STATEMENT-1",
        accountName: "Local statement test", issuedAt: "2026-10-01T12:00:00.000Z", currency: "USD",
        lines: [{ description: "Invoice LOCAL-1", amountCents: 10000 }], totals: [{ label: "Closing balance", amountCents: 5000 }], notes: [],
        statement: { periodStart: "2026-09-01", periodEnd: "2026-09-30", revision: 1, openingBalanceCents: 0,
          invoiceCents: 10000, paymentCents: 5000, refundCents: 0, creditCents: 0, closingBalanceCents: 5000 },
      } }));
    await Promise.all([processPartnerBillingDocumentOperation(operationId), processPartnerBillingDocumentOperation(operationId)]);
    await processPartnerBillingDocumentOperation(operationId);
    const documents = await db.select().from(partnerDocuments).where(eq(partnerDocuments.partnerAccountId, accountId));
    const statements = await db.select().from(partnerStatements).where(eq(partnerStatements.partnerAccountId, accountId));
    expect(documents).toHaveLength(1); expect(statements).toHaveLength(1); expect(objects.size).toBe(1);
    const document = documents[0]!; const bytes = objects.get(document.storageObjectKey)!;
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(document.sha256).toBe(createHash("sha256").update(bytes).digest("hex")); expect(document.byteSize).toBe(bytes.length);
    expect(statements[0]).toMatchObject({ documentId: document.id, closingBalanceCents: 5000, revision: 1 });
    expect((await db.select().from(partnerBillingDocumentOperations).where(eq(partnerBillingDocumentOperations.id, operationId)))[0])
      .toMatchObject({ status: "ready", documentId: document.id });
    await expect(db.update(partnerBillingDocumentOperations).set({ snapshot: { tampered: true } }).where(eq(partnerBillingDocumentOperations.id, operationId)))
      .rejects.toHaveProperty("cause.message", expect.stringContaining("immutable"));
    await expect(db.update(partnerBillingDocumentOperations).set({ status: "pending" }).where(eq(partnerBillingDocumentOperations.id, operationId)))
      .rejects.toHaveProperty("cause.message", expect.stringContaining("immutable"));
  });

  it("authorizes account, location, property and cost-center document access before signing and records each intent", async () => {
    const fixture = await downloadFixture();
    signedReads.length = 0;
    const scopes = [null, { locationIds: [fixture.locationId] }, { propertyIds: [fixture.propertyId] }, { costCenterIds: [fixture.costCenterId] }];
    for (const accessScope of scopes) {
      const result = await createPartnerDocumentDownloadIntent({ ...fixture.input, accessLevel: accessScope ? "scoped" : "account", accessScope: accessScope ?? {} });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("Expected authorized local document");
      expect(result.download.documentId).toBe(fixture.input.documentId);
      expect(result.download).not.toHaveProperty("storageBucket");
      expect(result.download).not.toHaveProperty("storageObjectKey");
    }
    expect(signedReads).toHaveLength(4);
    expect(signedReads.every((read) => read.expiresIn === 300)).toBe(true);
    const logs = await getDb().select().from(partnerDocumentAccessLogs).where(eq(partnerDocumentAccessLogs.partnerAccountId, fixture.input.accountId));
    expect(logs).toHaveLength(4);
    for (const log of logs) expect(log).toMatchObject({ partnerDocumentId: fixture.input.documentId, actorMembershipId: fixture.input.membershipId, action: "download_intent" });
  });

  it("returns opaque 404 without signing or logging foreign, ungranted and account-wide documents for scoped users", async () => {
    const fixture = await downloadFixture();
    signedReads.length = 0;
    const denied: Array<Partial<Parameters<typeof createPartnerDocumentDownloadIntent>[0]>> = [
      { documentId: fixture.foreignDocumentId },
      { accessLevel: "scoped", accessScope: {} },
      { accessLevel: "scoped", accessScope: { locationIds: [randomUUID()] } },
      { accessLevel: "scoped", accessScope: { costCenterIds: [fixture.foreignCostCenterId] } },
      { documentId: fixture.accountDocumentId, accessLevel: "scoped", accessScope: { locationIds: [fixture.locationId], costCenterIds: [fixture.costCenterId] } },
    ];
    for (const override of denied) {
      expect(await createPartnerDocumentDownloadIntent({ ...fixture.input, ...override }))
        .toEqual({ ok: false, error: "not_found", status: 404 });
    }
    expect(signedReads).toHaveLength(0);
    expect(await getDb().select().from(partnerDocumentAccessLogs).where(eq(partnerDocumentAccessLogs.partnerAccountId, fixture.input.accountId))).toHaveLength(0);
  });
});
