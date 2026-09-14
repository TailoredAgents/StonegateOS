import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
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
  partnerUsers,
  partnerAccountMemberships,
  partnerProofShareLinks,
  partnerDocumentAccessLogs,
  partnerRoleTemplates,
} from "@/db";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
const jest = import.meta.jest;
const mockModule = jest.unstable_mockModule as unknown as (
  name: string,
  factory: () => Record<string, unknown>,
) => void;
const objects = new Map<string, Buffer>();
const signedObjects = new Map<string, string>();
type SharePayload = {
  shareLink: { id: string; url: string; expiresAt: string; replayed: boolean };
};
type DownloadDescriptor = {
  url: string;
  byteSize: number;
  checksumSha256: string;
};
const authorization = await import("@/lib/partner-account-authorization");
let principal: PartnerPrincipal | null = null;
// Only session transport and private storage are replaced. Authorization,
// share tokens, the HTTP handlers, and the database lifecycle remain real.
mockModule("@/lib/partner-account-authorization", () => ({
  ...authorization,
  requirePartnerCapability: (
    _request: NextRequest,
    capability: Parameters<typeof authorization.hasPartnerCapability>[1],
  ) =>
    Promise.resolve(
      principal && authorization.hasPartnerCapability(principal, capability)
        ? { ok: true, principal }
        : { ok: false, status: 403, error: "forbidden" },
    ),
}));
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
mockModule("@/lib/media-storage", () => ({
  getMediaStorageBucket: () => "local-proof-test",
  createMediaReadUrl: (key: string, expiresIn: number) => {
    expect(expiresIn).toBeLessThanOrEqual(300);
    expect(objects.has(key)).toBe(true);
    const url = `https://local-proof.test/download/${randomUUID()}`;
    signedObjects.set(url, key);
    return Promise.resolve(url);
  },
  getMediaObject: (key: string) => {
    const bytes = objects.get(key);
    if (!bytes) return Promise.reject(new Error("missing_test_object"));
    return Promise.resolve(bytes);
  },
  putImmutableMediaObject: ({ key, body }: { key: string; body: Buffer }) => {
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
const { POST: createShare } = await import(
  "../../app/api/portal/v2/jobs/[jobId]/proof/share-links/route"
);
const { DELETE: revokeShare } = await import(
  "../../app/api/portal/v2/jobs/[jobId]/proof/share-links/[shareId]/route"
);
const { GET: readShare } = await import(
  "../../app/api/portal/v2/proof-shares/[token]/route"
);
const environmentKeys = [
  "PARTNER_PORTAL_V2_READS_ENABLED",
  "PARTNER_PORTAL_V2_WRITES_ENABLED",
  "PARTNER_PORTAL_INTERNAL_TEST_MODE",
  "PARTNER_PROOF_SHARE_TOKEN_KEY_BASE64",
  "NEXT_PUBLIC_SITE_URL",
];
const priorEnvironment = new Map(
  environmentKeys.map((key) => [key, process.env[key]]),
);
const local =
  process.env["DATABASE_URL"] &&
  ["localhost", "127.0.0.1"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
(local ? describe : describe.skip)(
  "completion records: local PostgreSQL, actual PDF/ZIP, in-memory private storage",
  () => {
    beforeAll(() => {
      process.env["PARTNER_PORTAL_V2_READS_ENABLED"] = "true";
      process.env["PARTNER_PORTAL_V2_WRITES_ENABLED"] = "true";
      process.env["PARTNER_PORTAL_INTERNAL_TEST_MODE"] = "false";
      process.env["PARTNER_PROOF_SHARE_TOKEN_KEY_BASE64"] = Buffer.alloc(
        32,
        7,
      ).toString("base64");
      process.env["NEXT_PUBLIC_SITE_URL"] = "https://local-proof.test";
    });
    afterAll(async () => {
      for (const [key, value] of priorEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await closeDbForTests();
    });
    it("generates immutable proof, shares real artifacts, isolates accounts, and rejects revoked or expired links", async () => {
      const db = getDb(),
        accountId = randomUUID(),
        contactId = randomUUID(),
        propertyId = randomUUID(),
        appointmentId = randomUUID(),
        jobId = randomUUID(),
        locationId = randomUUID(),
        assetId = randomUUID();
      await db.transaction(async (tx) => {
        await tx.insert(partnerAccounts).values({
          id: accountId,
          name: "Local proof account",
          normalizedName: accountId,
          status: "active_partner",
          portalAccessEnabled: true,
        });
        await tx
          .insert(contacts)
          .values({ id: contactId, firstName: "Local", lastName: "Proof" });
        await tx.insert(properties).values({
          id: propertyId,
          contactId,
          addressLine1: "1 Local Way",
          city: "Atlanta",
          state: "GA",
          postalCode: "30301",
        });
        await tx.insert(partnerAccountLocations).values({
          id: locationId,
          partnerAccountId: accountId,
          propertyId,
          siteName: "Renamed current site",
          addressLine1: "1 Local Way",
          city: "Atlanta",
          state: "GA",
          postalCode: "30301",
        });
        await tx.insert(appointments).values({
          id: appointmentId,
          contactId,
          propertyId,
          type: "job",
          status: "completed",
          completedAt: new Date(),
          rescheduleToken: randomUUID(),
        });
        await tx.insert(partnerBookings).values({
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
      await db.insert(mediaAssets).values({
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
      await db.insert(partnerJobEvidence).values({
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

      const userId = randomUUID(),
        membershipId = randomUUID();
      const [role] = await db
        .select()
        .from(partnerRoleTemplates)
        .where(
          and(
            eq(partnerRoleTemplates.key, "administrator"),
            isNull(partnerRoleTemplates.partnerAccountId),
          ),
        )
        .limit(1);
      if (!role) throw new Error("Local proof role missing");
      await db.insert(partnerUsers).values({
        id: userId,
        email: `${userId}@example.test`,
        normalizedEmail: `${userId}@example.test`,
        name: "Local proof administrator",
        active: true,
        identityStatus: "active",
        emailVerifiedAt: new Date(),
      });
      await db.insert(partnerAccountMemberships).values({
        id: membershipId,
        partnerAccountId: accountId,
        partnerUserId: userId,
        roleKey: "administrator",
        roleTemplateId: role.id,
        status: "active",
        accessLevel: "account",
        acceptedAt: new Date(),
      });
      const [access] = await authorization.loadActiveMembershipAccesses(userId);
      if (!access) throw new Error("Local proof membership missing");
      principal = {
        ...access,
        type: "partner",
        partnerUserId: userId,
        email: `${userId}@example.test`,
        name: "Local proof administrator",
        passwordSet: true,
        accessSource: "membership",
        availableAccounts: [access],
        session: {
          id: randomUUID(),
          authMethod: "password",
          deviceName: null,
          createdAt: new Date(),
          lastSeenAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
      };
      const owner = principal;
      const requestShare = (key: string) =>
        createShare(
          new NextRequest(
            `http://localhost/api/portal/v2/jobs/${jobId}/proof/share-links`,
            {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "idempotency-key": key,
              },
              body: JSON.stringify({
                proofPackageId: packages[0]!.id,
                expiresIn: "1h",
              }),
            },
          ),
          { params: Promise.resolve({ jobId }) },
        );
      const requestRevoke = (shareId: string) =>
        revokeShare(
          new NextRequest(
            `http://localhost/api/portal/v2/jobs/${jobId}/proof/share-links/${shareId}`,
            { method: "DELETE" },
          ),
          { params: Promise.resolve({ jobId, shareId }) },
        );
      const requestRead = (url: string) => {
        const token = new URL(url).pathname.split("/").at(-1)!;
        return readShare(
          new NextRequest(
            `http://localhost/api/portal/v2/proof-shares/${token}`,
          ),
          {
            params: Promise.resolve({ token }),
          },
        );
      };
      const idempotencyKey = randomUUID();
      const created = await requestShare(idempotencyKey);
      expect(created.status).toBe(201);
      const { shareLink } = (await created.json()) as SharePayload;
      const replay = await requestShare(idempotencyKey);
      expect(replay.status).toBe(200);
      expect(((await replay.json()) as SharePayload).shareLink).toMatchObject({
        ...shareLink,
        replayed: true,
      });
      const shared = await requestRead(shareLink.url);
      expect(shared.status).toBe(200);
      expect(shared.headers.get("cache-control")).toContain("no-store");
      expect(shared.headers.get("referrer-policy")).toBe("no-referrer");
      const { proofPackage } = (await shared.json()) as {
        proofPackage: {
          evidence: unknown[];
          downloads: {
            pdf: DownloadDescriptor;
            originalMediaZip: DownloadDescriptor;
          };
        };
      };
      expect(proofPackage.evidence).toHaveLength(1);
      for (const download of [
        proofPackage.downloads.pdf,
        proofPackage.downloads.originalMediaZip,
      ]) {
        const bytes = objects.get(signedObjects.get(download.url)!)!;
        expect(bytes.length).toBe(download.byteSize);
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(
          download.checksumSha256,
        );
      }
      expect(
        await db
          .select()
          .from(partnerDocumentAccessLogs)
          .where(eq(partnerDocumentAccessLogs.shareLinkId, shareLink.id)),
      ).toHaveLength(2);

      principal = { ...owner, accountId: randomUUID() };
      expect((await requestShare(randomUUID())).status).toBe(404);
      expect((await requestRevoke(shareLink.id)).status).toBe(404);
      principal = owner;
      process.env["PARTNER_PORTAL_V2_WRITES_ENABLED"] = "false";
      expect((await requestShare(randomUUID())).status).toBe(503);
      expect((await requestRevoke(shareLink.id)).status).toBe(503);
      process.env["PARTNER_PORTAL_V2_WRITES_ENABLED"] = "true";
      expect((await requestRevoke(shareLink.id)).status).toBe(200);
      const revokedReplay = await requestRevoke(shareLink.id);
      expect(revokedReplay.status).toBe(200);
      expect(
        ((await revokedReplay.json()) as SharePayload).shareLink.replayed,
      ).toBe(true);
      expect((await requestRead(shareLink.url)).status).toBe(404);

      const expiring = await requestShare(randomUUID());
      expect(expiring.status).toBe(201);
      const expiringLink = ((await expiring.json()) as SharePayload).shareLink;
      await db
        .update(partnerProofShareLinks)
        .set({
          createdAt: new Date(Date.now() - 7200000),
          expiresAt: new Date(Date.now() - 3600000),
        })
        .where(eq(partnerProofShareLinks.id, expiringLink.id));
      expect((await requestRead(expiringLink.url)).status).toBe(404);
    });
  },
);
