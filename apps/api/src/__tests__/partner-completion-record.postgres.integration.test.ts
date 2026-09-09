import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import {
  closeDbForTests,
  getDb,
  partnerAccounts,
  contacts,
  properties,
  appointments,
  partnerBookings,
  partnerAccountLocations,
  mediaAssets,
  partnerJobEvidence,
  partnerProofPackages,
  partnerDocuments,
} from "@/db";
const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  name: string,
  factory: () => Record<string, unknown>,
) => void;
const objects = new Map<string, Buffer>();
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
mockModule("@/lib/media-storage", () => ({
  getMediaStorageBucket: () => "local-proof-test",
  getMediaObject: (key: string) => {
    const bytes = objects.get(key);
    if (!bytes) return Promise.reject(new Error("missing_test_object"));
    return Promise.resolve(bytes);
  },
  putImmutableMediaObject: ({
    key,
    body,
  }: {
    key: string;
    body: Buffer;
  }) => {
    if (objects.has(key) && !objects.get(key)!.equals(body))
      return Promise.reject(new Error("immutable_conflict"));
    objects.set(key, body);
    return Promise.resolve();
  },
  putImmutableMediaFile: async ({
    key,
    path,
  }: {
    key: string;
    path: string;
  }) => {
    const body = await readFile(path);
    if (objects.has(key) && !objects.get(key)!.equals(body))
      throw new Error("immutable_conflict");
    objects.set(key, body);
  },
}));
const { preparePartnerCompletionRecord } = await import(
  "@/lib/partner-completion-record"
);
const local =
  process.env["DATABASE_URL"] &&
  ["localhost", "127.0.0.1"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
(local ? describe : describe.skip)(
  "completion records: local PostgreSQL, actual PDF/ZIP, in-memory private storage",
  () => {
    afterAll(closeDbForTests);
    it("requires snapshot proof and creates one immutable record on replay without reading another account", async () => {
      const db = getDb(),
        accountId = randomUUID(),
        contactId = randomUUID(),
        propertyId = randomUUID(),
        appointmentId = randomUUID(),
        jobId = randomUUID(),
        locationId = randomUUID(),
        assetId = randomUUID();
      await db.transaction(async (tx) => {
        await tx
          .insert(partnerAccounts)
          .values({
            id: accountId,
            name: "Local proof account",
            normalizedName: accountId,
            portalAccessEnabled: true,
          });
        await tx
          .insert(contacts)
          .values({ id: contactId, firstName: "Local", lastName: "Proof" });
        await tx
          .insert(properties)
          .values({
            id: propertyId,
            contactId,
            addressLine1: "1 Local Way",
            city: "Atlanta",
            state: "GA",
            postalCode: "30301",
          });
        await tx
          .insert(partnerAccountLocations)
          .values({
            id: locationId,
            partnerAccountId: accountId,
            propertyId,
            siteName: "Renamed current site",
            addressLine1: "1 Local Way",
            city: "Atlanta",
            state: "GA",
            postalCode: "30301",
          });
        await tx
          .insert(appointments)
          .values({
            id: appointmentId,
            contactId,
            propertyId,
            type: "job",
            status: "completed",
            completedAt: new Date(),
            rescheduleToken: randomUUID(),
          });
        await tx
          .insert(partnerBookings)
          .values({
            id: jobId,
            partnerAccountId: accountId,
            orgContactId: contactId,
            propertyId,
            appointmentId,
            publicStatus: "completed",
            proofRequirementsSnapshot: { before: 1 },
            scopeSnapshot: {
              locationSnapshot: {
                id: locationId,
                name: "Original job site",
                address: {
                  line1: "1 Local Way",
                  city: "Atlanta",
                  state: "GA",
                  postalCode: "30301",
                },
                timezone: "America/New_York",
              },
            },
          });
      });
      await preparePartnerCompletionRecord(accountId, jobId);
      expect(
        await db
          .select()
          .from(partnerProofPackages)
          .where(eq(partnerProofPackages.partnerBookingId, jobId)),
      ).toHaveLength(0);
      objects.set(`original/${assetId}`, PNG);
      await db
        .insert(mediaAssets)
        .values({
          id: assetId,
          partnerAccountId: accountId,
          status: "ready",
          storageBucket: "local-proof-test",
          originalObjectKey: `original/${assetId}`,
          contentType: "image/png",
          byteSize: PNG.length,
          sha256: createHash("sha256").update(PNG).digest("hex"),
          width: 1,
          height: 1,
          readyAt: new Date(),
        });
      await db
        .insert(partnerJobEvidence)
        .values({
          partnerAccountId: accountId,
          partnerBookingId: jobId,
          mediaAssetId: assetId,
          category: "before",
        });
      await preparePartnerCompletionRecord(randomUUID(), jobId);
      await preparePartnerCompletionRecord(accountId, jobId);
      await preparePartnerCompletionRecord(accountId, jobId);
      const packages = await db
        .select()
        .from(partnerProofPackages)
        .where(eq(partnerProofPackages.partnerBookingId, jobId));
      const documents = await db
        .select()
        .from(partnerDocuments)
        .where(eq(partnerDocuments.partnerBookingId, jobId));
      expect(packages).toHaveLength(1);
      expect(documents).toHaveLength(2);
      expect(packages[0]!.manifest).toMatchObject({
        job: { id: jobId, location: { name: "Original job site" } },
        proof: {
          requirements: [
            expect.objectContaining({ category: "before", satisfied: true }),
          ],
        },
      });
      for (const document of documents) {
        const bytes = objects.get(document.storageObjectKey)!;
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          document.sha256,
        );
        expect(bytes.length).toBe(document.byteSize);
      }
      expect(
        objects
          .get(
            documents.find((row) => row.contentType === "application/pdf")!
              .storageObjectKey,
          )!
          .subarray(0, 5)
          .toString(),
      ).toBe("%PDF-");
      expect(
        objects
          .get(
            documents.find((row) => row.contentType === "application/zip")!
              .storageObjectKey,
          )!
          .readUInt32LE(0),
      ).toBe(0x04034b50);
    });
  },
);
