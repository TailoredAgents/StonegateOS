import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  getDb,
  closeDbForTests,
  partnerAccounts,
  partnerUsers,
  partnerAccountMemberships,
  partnerAccountLocations,
  partnerBookingDrafts,
  partnerDraftMedia,
  partnerBookings,
  partnerJobEvidence,
  mediaAssets,
  contacts,
  properties,
  appointments,
  auditLogs,
  outboxEvents,
  teamMembers,
  partnerEvidenceRequirements,
} from "@/db";
import type { PartnerPrincipal } from "@/lib/partner-account-authorization";
import {
  restorePartnerMedia,
  softDeletePartnerMedia,
  listPartnerMedia,
  listRecoverablePartnerMedia,
  createPartnerMediaUploadIntents,
} from "@/lib/partner-portal-v2-media";
import {
  evaluatePartnerProofCompletion,
  recordPartnerProofCompletionOverride,
} from "@/lib/partner-proof-completion";

const local =
  process.env["DATABASE_URL"] &&
  ["localhost", "127.0.0.1"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const suite = local ? describe : describe.skip;
type Kind = "draft" | "job";
const DAY = 86_400_000;

/** Local synthetic rows only. The real restore/delete services and PostgreSQL
 * locks run unmocked; this workflow never reads or writes object storage. */
async function fixture(parentKind: Kind, additionalService = false) {
  const db = getDb(),
    accountId = randomUUID(),
    userId = randomUUID(),
    membershipId = randomUUID(),
    contactId = randomUUID(),
    propertyId = randomUUID(),
    locationId = randomUUID(),
    appointmentId = randomUUID(),
    parentId = randomUUID(),
    sourceJobId = randomUUID(),
    sourcePropertyId = randomUUID(),
    sourceLocationId = randomUUID(),
    email = `${userId}@example.test`,
    now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(partnerAccounts).values({
      id: accountId,
      name: "Local restore account",
      normalizedName: accountId,
      portalAccessEnabled: true,
    });
    await tx.insert(partnerUsers).values({
      id: userId,
      email,
      normalizedEmail: email,
      name: "Local restore member",
      identityStatus: "active",
    });
    await tx.insert(partnerAccountMemberships).values({
      id: membershipId,
      partnerAccountId: accountId,
      partnerUserId: userId,
      roleKey: "operations",
      status: "active",
      accessLevel: "account",
      acceptedAt: now,
    });
    await tx
      .insert(contacts)
      .values({ id: contactId, firstName: "Local", lastName: "Restore" });
    await tx.insert(properties).values({
      id: propertyId,
      contactId,
      addressLine1: "1 Synthetic Way",
      city: "Atlanta",
      state: "GA",
      postalCode: "30301",
    });
    await tx.insert(partnerAccountLocations).values({
      id: locationId,
      partnerAccountId: accountId,
      propertyId,
      siteName: "Synthetic restore site",
      addressLine1: "1 Synthetic Way",
      city: "Atlanta",
      state: "GA",
      postalCode: "30301",
    });
    if (additionalService) {
      const sourceAppointmentId = randomUUID();
      await tx
        .insert(properties)
        .values({
          id: sourcePropertyId,
          contactId,
          addressLine1: "2 Original Site Way",
          city: "Atlanta",
          state: "GA",
          postalCode: "30301",
        });
      await tx
        .insert(partnerAccountLocations)
        .values({
          id: sourceLocationId,
          partnerAccountId: accountId,
          propertyId: sourcePropertyId,
          siteName: "Original service site",
          addressLine1: "2 Original Site Way",
          city: "Atlanta",
          state: "GA",
          postalCode: "30301",
        });
      await tx
        .insert(appointments)
        .values({
          id: sourceAppointmentId,
          partnerAccountId: accountId,
          contactId,
          propertyId: sourcePropertyId,
          type: "job",
          status: "completed",
          rescheduleToken: randomUUID(),
        });
      await tx
        .insert(partnerBookings)
        .values({
          id: sourceJobId,
          partnerAccountId: accountId,
          appointmentId: sourceAppointmentId,
          orgContactId: contactId,
          propertyId: sourcePropertyId,
          publicStatus: "completed",
        });
    }
    if (parentKind === "draft")
      await tx.insert(partnerBookingDrafts).values({
        id: parentId,
        partnerAccountId: accountId,
        createdByMembershipId: membershipId,
        locationId,
        state: "draft",
        additionalServiceFromPartnerBookingId: additionalService
          ? sourceJobId
          : null,
      });
    else {
      await tx.insert(appointments).values({
        id: appointmentId,
        partnerAccountId: accountId,
        contactId,
        propertyId,
        type: "job",
        status: "confirmed",
        rescheduleToken: randomUUID(),
      });
      await tx.insert(partnerBookings).values({
        id: parentId,
        partnerAccountId: accountId,
        appointmentId,
        orgContactId: contactId,
        propertyId,
        publicStatus: "confirmed",
        proofRequirementsSnapshot: { before: 1, after: 1 },
      });
    }
  });
  const principal: PartnerPrincipal = {
    type: "partner",
    partnerUserId: userId,
    email,
    name: "Local restore member",
    passwordSet: true,
    accountId,
    accountName: "Local restore account",
    membershipId,
    roleKey: "operations",
    persona: "contractor",
    accessLevel: "account",
    accessScope: {},
    preferences: {},
    legacyOrgContactId: null,
    capabilities: ["media.read", "media.upload"],
    accessSource: "membership",
    availableAccounts: [],
    session: {
      id: randomUUID(),
      authMethod: "password",
      deviceName: "Local test",
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + DAY),
    },
  };
  const association =
    parentKind === "draft" ? partnerDraftMedia : partnerJobEvidence;
  async function add(
    count = 1,
    category: "before" | "after" | "document" = "before",
    removedAt: Date | null = null,
  ) {
    const rows = Array.from({ length: count }, () => ({
      id: randomUUID(),
      assetId: randomUUID(),
    }));
    await db.transaction(async (tx) => {
      await tx.insert(mediaAssets).values(
        rows.map((row) => ({
          id: row.assetId,
          partnerAccountId: accountId,
          status: "ready" as const,
          storageBucket: "local-restoration-test",
          originalObjectKey: `local/restore/${row.assetId}`,
          originalFilename: category === "document" ? "scope.pdf" : "proof.png",
          contentType:
            category === "document" ? "application/pdf" : "image/png",
          sourceMetadata:
            category === "document" ? { scanStatus: "clean" } : {},
          byteSize: 100,
          sha256: "a".repeat(64),
          readyAt: now,
        })),
      );
      const values = rows.map((row) => ({
        id: row.id,
        partnerAccountId: accountId,
        mediaAssetId: row.assetId,
        uploadedByMembershipId: membershipId,
        category,
        deletedAt: removedAt,
        purgeEligibleAt: removedAt
          ? new Date(removedAt.getTime() + 30 * DAY)
          : null,
      }));
      if (parentKind === "draft")
        await tx
          .insert(partnerDraftMedia)
          .values(values.map((row) => ({ ...row, bookingDraftId: parentId })));
      else
        await tx
          .insert(partnerJobEvidence)
          .values(
            values.map((row) => ({ ...row, partnerBookingId: parentId })),
          );
    });
    return rows;
  }
  function restore(id: string, deletedAt: string, actor = principal) {
    return restorePartnerMedia({
      parentKind,
      parentId,
      associationId: id,
      principal: actor,
      deletedAt,
      correlationId: `local-restore-${id}`,
    });
  }
  return {
    db,
    accountId,
    appointmentId,
    parentId,
    principal,
    association,
    add,
    restore,
    parentKind,
    locationId,
    sourceLocationId,
  };
}

suite("partner media recovery / real PostgreSQL", () => {
  afterAll(closeDbForTests);
  it("blocks linked-draft media listing, upload, deletion and restore after source-job scope is lost", async () => {
    const f = await fixture("draft", true);
    const authorized: PartnerPrincipal = {
      ...f.principal,
      accessLevel: "scoped",
      accessScope: { locationIds: [f.locationId, f.sourceLocationId] },
    };
    const request = {
      parentKind: "draft" as const,
      parentId: f.parentId,
      principal: authorized,
    };
    expect(await listPartnerMedia(request)).toEqual([]);
    const [active, removed] = await f.add(2);
    const deletion = await softDeletePartnerMedia({
      ...request,
      associationId: removed!.id,
    });
    expect(await listRecoverablePartnerMedia(request)).toHaveLength(1);
    const revoked: PartnerPrincipal = {
      ...authorized,
      accessScope: { locationIds: [f.locationId] },
    };
    const denied = { ...request, principal: revoked };
    await expect(listPartnerMedia(denied)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    await expect(listRecoverablePartnerMedia(denied)).rejects.toMatchObject({
      code: "not_found",
      status: 404,
    });
    await expect(
      softDeletePartnerMedia({ ...denied, associationId: active!.id }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(
      f.restore(removed!.id, deletion.deletedAt, revoked),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
    // Storage configuration is resolved before the parent guard, but a denied
    // parent must stop before signing/uploading anything. No server runs here.
    const previousEndpoint = process.env["MEDIA_OBJECT_ENDPOINT"];
    const previousAutoCreate = process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"];
    process.env["MEDIA_OBJECT_ENDPOINT"] = "http://127.0.0.1:1";
    process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"] = "false";
    try {
      await expect(
        createPartnerMediaUploadIntents({
          ...denied,
          idempotencyKeyHash: "f".repeat(64),
          files: [{ clientId: "denied-upload", filename: "proof.png", contentType: "image/png", byteLength: 100, category: "intake" }],
        }),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });
    } finally {
      if (previousEndpoint === undefined) delete process.env["MEDIA_OBJECT_ENDPOINT"];
      else process.env["MEDIA_OBJECT_ENDPOINT"] = previousEndpoint;
      if (previousAutoCreate === undefined) delete process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"];
      else process.env["MEDIA_OBJECT_AUTO_CREATE_BUCKET"] = previousAutoCreate;
    }
    const rows = await f.db
      .select()
      .from(partnerDraftMedia)
      .where(eq(partnerDraftMedia.bookingDraftId, f.parentId));
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === active!.id)?.deletedAt).toBeNull();
    expect(
      rows.find((row) => row.id === removed!.id)?.deletedAt?.toISOString(),
    ).toBe(deletion.deletedAt);
  });
  for (const parentKind of ["draft", "job"] as const) {
    it(`${parentKind}: restores within 30 days, replays safely, and audits only one committed restoration`, async () => {
      const f = await fixture(parentKind),
        [media] = await f.add();
      const deleted = await softDeletePartnerMedia({
        parentKind,
        parentId: f.parentId,
        associationId: media!.id,
        principal: f.principal,
      });
      expect(
        new Date(deleted.purgeEligibleAt).getTime() -
          new Date(deleted.deletedAt).getTime(),
      ).toBe(30 * DAY);
      await expect(f.restore(media!.id, deleted.deletedAt)).resolves.toEqual({
        id: media!.id,
        restored: true,
      });
      await expect(f.restore(media!.id, deleted.deletedAt)).resolves.toEqual({
        id: media!.id,
        restored: true,
      });
      const [saved] = await f.db
        .select()
        .from(f.association)
        .where(eq(f.association.id, media!.id));
      expect(saved?.deletedAt).toBeNull();
      expect(saved?.purgeEligibleAt).toBeNull();
      const audits = await f.db
        .select()
        .from(auditLogs)
        .where(
          and(
            eq(auditLogs.action, "partner.media.restored"),
            eq(auditLogs.entityId, media!.id),
          ),
        );
      expect(audits).toHaveLength(1);
      expect(audits[0]?.actorId).toBe(f.principal.partnerUserId);
      const events = await f.db
        .select()
        .from(outboxEvents)
        .where(
          and(
            eq(outboxEvents.type, "partner.proof.prepare"),
            sql`${outboxEvents.payload}->>'jobId' = ${f.parentId}`,
          ),
        );
      expect(events).toHaveLength(parentKind === "job" ? 1 : 0);
    });

    it(`${parentKind}: rejects stale deleted revisions and expired recovery without changing the association`, async () => {
      const f = await fixture(parentKind),
        deletedAt = new Date(Date.now() - DAY),
        [media] = await f.add(1, "before", deletedAt);
      await expect(
        f.restore(media!.id, new Date(deletedAt.getTime() - 1).toISOString()),
      ).rejects.toMatchObject({ code: "revision_mismatch", status: 412 });
      const expiredAt = new Date(Date.now() - 31 * DAY);
      await f.db
        .update(f.association)
        .set({
          deletedAt: expiredAt,
          purgeEligibleAt: new Date(expiredAt.getTime() + 30 * DAY),
        })
        .where(eq(f.association.id, media!.id));
      await expect(
        f.restore(media!.id, expiredAt.toISOString()),
      ).rejects.toMatchObject({ code: "restore_expired", status: 410 });
      const [saved] = await f.db
        .select()
        .from(f.association)
        .where(eq(f.association.id, media!.id));
      expect(saved?.deletedAt?.toISOString()).toBe(expiredAt.toISOString());
    });

    it(`${parentKind}: denies another account and an out-of-scope location without revealing media`, async () => {
      const f = await fixture(parentKind),
        foreign = await fixture(parentKind),
        deletedAt = new Date(Date.now() - DAY),
        [media] = await f.add(1, "before", deletedAt);
      await expect(
        f.restore(media!.id, deletedAt.toISOString(), foreign.principal),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });
      await expect(
        f.restore(media!.id, deletedAt.toISOString(), {
          ...f.principal,
          accessLevel: "scoped",
          accessScope: { locationIds: [randomUUID()] },
        }),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });
      await f.db
        .update(mediaAssets)
        .set({ deletedAt: new Date() })
        .where(eq(mediaAssets.id, media!.assetId));
      await expect(
        f.restore(media!.id, deletedAt.toISOString()),
      ).rejects.toMatchObject({ code: "not_found", status: 404 });
    });

    it(`${parentKind}: restores up to 40 photos PLUS 10 PDFs and independently rejects either overflow`, async () => {
      const f = await fixture(parentKind),
        deletedAt = new Date(Date.now() - DAY);
      await f.add(39);
      await f.add(9, "document");
      const photos = await f.add(2, "before", deletedAt),
        documents = await f.add(2, "document", deletedAt);
      await expect(
        f.restore(photos[0]!.id, deletedAt.toISOString()),
      ).resolves.toMatchObject({ restored: true });
      await expect(
        f.restore(documents[0]!.id, deletedAt.toISOString()),
      ).resolves.toMatchObject({ restored: true });
      await expect(
        f.restore(photos[1]!.id, deletedAt.toISOString()),
      ).rejects.toMatchObject({ code: "media_limit_reached", status: 409 });
      await expect(
        f.restore(documents[1]!.id, deletedAt.toISOString()),
      ).rejects.toMatchObject({ code: "media_limit_reached", status: 409 });
    });
  }

  it("serializes two restorations competing for the final photo allowance", async () => {
    const f = await fixture("job"),
      deletedAt = new Date(Date.now() - DAY);
    await f.add(39);
    const photos = await f.add(2, "before", deletedAt);
    const results = await Promise.allSettled(
      photos.map((photo) => f.restore(photo.id, deletedAt.toISOString())),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(
      rejected && rejected.status === "rejected" ? rejected.reason : null,
    ).toMatchObject({ code: "media_limit_reached", status: 409 });
  });

  it("restores completed-job proof without rewriting the reasoned staff override or reopening the job", async () => {
    const f = await fixture("job"),
      deletedAt = new Date(Date.now() - DAY),
      [photo] = await f.add(1, "before", deletedAt),
      staffId = randomUUID();
    await f.add(1, "after");
    await f.db.insert(teamMembers).values({
      id: staffId,
      name: "Local proof supervisor",
      email: `${staffId}@example.test`,
      active: true,
    });
    await f.db.transaction(async (tx) => {
      const decision = await evaluatePartnerProofCompletion(
        tx,
        f.appointmentId,
      );
      expect(decision.kind).toBe("missing");
      if (decision.kind !== "missing")
        throw new Error("missing_fixture_evidence");
      await recordPartnerProofCompletionOverride(tx, {
        decision,
        reason: "Before image could not be recovered at completion",
        teamMemberId: staffId,
        now: new Date(),
      });
      await tx
        .update(appointments)
        .set({ status: "completed", completedAt: new Date() })
        .where(eq(appointments.id, f.appointmentId));
      await tx
        .update(partnerBookings)
        .set({ publicStatus: "completed" })
        .where(eq(partnerBookings.id, f.parentId));
    });
    const before = await f.db
      .select()
      .from(partnerEvidenceRequirements)
      .where(eq(partnerEvidenceRequirements.partnerBookingId, f.parentId));
    await f.restore(photo!.id, deletedAt.toISOString());
    expect(
      await f.db
        .select()
        .from(partnerEvidenceRequirements)
        .where(eq(partnerEvidenceRequirements.partnerBookingId, f.parentId)),
    ).toEqual(before);
    const [job] = await f.db
        .select()
        .from(partnerBookings)
        .where(eq(partnerBookings.id, f.parentId)),
      [appointment] = await f.db
        .select()
        .from(appointments)
        .where(eq(appointments.id, f.appointmentId));
    expect(job?.publicStatus).toBe("completed");
    expect(job?.proofRequirementsSnapshot).toEqual({ before: 1, after: 1 });
    expect(appointment?.status).toBe("completed");
    expect(
      (
        await f.db.transaction((tx) =>
          evaluatePartnerProofCompletion(tx, f.appointmentId),
        )
      ).kind,
    ).toBe("satisfied");
  });
});
