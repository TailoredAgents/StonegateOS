import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  closeDbForTests,
  getDb,
  appointments,
  contacts,
  mediaAssets,
  partnerAccounts,
  partnerBookings,
  partnerJobEvidence,
  properties,
} from "@/db";
import {
  getPartnerServiceReview,
  listPartnerServiceReviews,
} from "@/lib/partner-service-review-queue";

const local =
  process.env["DATABASE_URL"] &&
  ["localhost", "127.0.0.1"].includes(
    new URL(process.env["DATABASE_URL"]).hostname,
  );
const suite = local ? describe : describe.skip;
async function fixture(
  status = "under_review",
  startAt: Date | null = null,
  account?: { id: string; name: string },
  originalJobId: string | null = null,
) {
  const accountId = account?.id ?? randomUUID(),
    accountName = account?.name ?? "Service review " + randomUUID();
  const contactId = randomUUID(),
    propertyId = randomUUID(),
    appointmentId = randomUUID(),
    jobId = randomUUID(),
    mediaId = randomUUID();
  await getDb().transaction(async (tx) => {
    if (!account)
      await tx.insert(partnerAccounts).values({
        id: accountId,
        name: accountName,
        normalizedName: accountName,
        portalAccessEnabled: true,
      });
    await tx.insert(contacts).values({
      id: contactId,
      firstName: "Local",
      lastName: "Request",
      email: contactId + "@example.test",
    });
    await tx.insert(properties).values({
      id: propertyId,
      contactId,
      addressLine1: "1 Local Way",
      city: "Atlanta",
      state: "GA",
      postalCode: "30301",
    });
    await tx.insert(appointments).values({
      id: appointmentId,
      partnerAccountId: accountId,
      contactId,
      propertyId,
      type: "job",
      status: startAt ? "confirmed" : "requested",
      startAt,
      rescheduleToken: randomUUID(),
    });
    await tx.insert(partnerBookings).values({
      id: jobId,
      partnerAccountId: accountId,
      orgContactId: contactId,
      propertyId,
      appointmentId,
      publicStatus: status,
      additionalServiceFromPartnerBookingId: originalJobId,
      scopeSnapshot: {
        description: "Remove the sample cabinet.",
        crewInstructions: "Use loading area.",
        accessDetails: "SECRET GATE 9876",
        onSiteContact: { name: "Local Contact", phone: "4045550100" },
        scope: {
          quantity: 1,
          gateCode: "SECRET GATE 9876",
          nestedProvider: { token: "SECRET TOKEN" },
        },
        preferredWindows: [{ localDate: "2026-09-10", timeOfDay: "morning" }],
        locationSnapshot: {
          id: propertyId,
          name: "Sample site",
          timezone: "America/New_York",
          address: {
            line1: "1 Local Way",
            city: "Atlanta",
            state: "GA",
            postalCode: "30301",
          },
        },
      },
      proofRequirementsSnapshot: { before: 2, after: 1 },
      requestedReviewReasons: ["service_profile_missing"],
    });
    await tx.insert(mediaAssets).values({
      id: mediaId,
      partnerAccountId: accountId,
      storageBucket: "local-test",
      originalObjectKey: "private-local-object-" + mediaId,
      contentType: "image/jpeg",
      status: "processing",
    });
    await tx.insert(partnerJobEvidence).values({
      partnerAccountId: accountId,
      partnerBookingId: jobId,
      mediaAssetId: mediaId,
      category: "intake",
    });
  });
  return { accountId, accountName, appointmentId, jobId, mediaId };
}

suite("initial partner service review queue / real PostgreSQL", () => {
  afterAll(async () => closeDbForTests());
  it("requires a specific company for history and rejects ambiguous modes", async () => {
    for (const params of [
      { includeScheduled: "true" },
      { includeScheduled: "true", accountId: "not-a-company-id" },
      { includeScheduled: "yes", accountId: randomUUID() },
    ]) {
      expect(
        await listPartnerServiceReviews(new URLSearchParams(params)),
      ).toBeNull();
    }
  });

  it("lists scheduled and closed company jobs without mixing companies or exposing scope secrets", async () => {
    const first = await fixture();
    const company = { id: first.accountId, name: first.accountName };
    const scheduled = await fixture(
      "confirmed",
      new Date("2035-06-04T14:00:00Z"),
      company,
    );
    const completed = await fixture(
      "completed",
      new Date("2035-06-03T14:00:00Z"),
      company,
    );
    const canceled = await fixture(
      "canceled",
      new Date("2035-06-02T14:00:00Z"),
      company,
    );
    const otherCompany = await fixture("confirmed", new Date());
    await getDb()
      .update(partnerBookings)
      .set({
        arrivalWindowStartAt: new Date("2035-06-04T14:00:00Z"),
        arrivalWindowEndAt: new Date("2035-06-04T16:00:00Z"),
      })
      .where(eq(partnerBookings.id, scheduled.jobId));

    const history = await listPartnerServiceReviews(
      new URLSearchParams({
        accountId: first.accountId,
        includeScheduled: "true",
      }),
    );
    expect(new Set(history!.requests.map((row) => row.id))).toEqual(
      new Set([first.jobId, scheduled.jobId, completed.jobId, canceled.jobId]),
    );
    expect(
      history!.requests.every((row) => row.accountId === first.accountId),
    ).toBe(true);
    expect(
      history!.requests.find((row) => row.id === scheduled.jobId),
    ).toMatchObject({
      appointmentId: scheduled.appointmentId,
      arrivalStartAt: "2035-06-04T14:00:00.000Z",
      arrivalEndAt: "2035-06-04T16:00:00.000Z",
    });
    expect(
      history!.requests.find((row) => row.id === first.jobId),
    ).toMatchObject({
      arrivalStartAt: null,
      arrivalEndAt: null,
    });
    expect(JSON.stringify(history)).not.toMatch(
      /SECRET|cabinet|4045550100|originalObjectKey/u,
    );
    expect(JSON.stringify(history)).not.toContain(otherCompany.jobId);
    const reviews = await listPartnerServiceReviews(
      new URLSearchParams({ accountId: first.accountId }),
    );
    expect(reviews!.requests.map((row) => row.id)).toEqual([first.jobId]);
    expect(JSON.stringify(reviews)).not.toContain(first.appointmentId);
  });

  it("paginates more than 100 company jobs and binds cursors to company and history mode", async () => {
    const first = await fixture("confirmed", new Date());
    const company = { id: first.accountId, name: first.accountName };
    for (let index = 0; index < 101; index += 1) {
      await fixture("completed", new Date(), company);
    }
    const params = new URLSearchParams({
      accountId: first.accountId,
      includeScheduled: "true",
      limit: "100",
    });
    const pageOne = await listPartnerServiceReviews(params);
    expect(pageOne!.requests).toHaveLength(100);
    expect(pageOne!.page.nextCursor).toBeTruthy();
    params.set("cursor", pageOne!.page.nextCursor!);
    const pageTwo = await listPartnerServiceReviews(params);
    expect(pageTwo!.requests).toHaveLength(2);
    expect(pageTwo!.page.nextCursor).toBeNull();
    expect(
      new Set([...pageOne!.requests, ...pageTwo!.requests].map((row) => row.id))
        .size,
    ).toBe(102);
    params.set("includeScheduled", "false");
    expect(await listPartnerServiceReviews(params)).toBeNull();
    params.set("includeScheduled", "true");
    params.set("accountId", randomUUID());
    expect(await listPartnerServiceReviews(params)).toBeNull();
  });
  it("shows original-job context on an additional request without contact-based preview links", async () => {
    const original = await fixture("completed", new Date());
    const additional = await fixture(
      "under_review",
      null,
      { id: original.accountId, name: original.accountName },
      original.jobId,
    );
    const list = await listPartnerServiceReviews(
      new URLSearchParams({ accountId: original.accountId }),
    );
    const detail = await getPartnerServiceReview(
      original.accountId,
      additional.jobId,
    );
    expect(
      list!.requests.find((row) => row.id === additional.jobId)?.originalJob,
    ).toMatchObject({
      id: original.jobId,
      status: "completed",
      serviceKey: null,
    });
    expect(detail!.request.originalJob).toEqual(
      list!.requests.find((row) => row.id === additional.jobId)?.originalJob,
    );
    expect(
      await getPartnerServiceReview(randomUUID(), additional.jobId),
    ).toBeNull();
    expect(JSON.stringify(detail!.request.originalJob)).not.toMatch(
      /orgContactId|appointmentId|preview|paid|invoice/u,
    );
  });
  it("shows unscheduled review work without leaking intake details into list responses", async () => {
    const f = await fixture();
    await fixture("confirmed", new Date(), {
      id: f.accountId,
      name: f.accountName,
    });
    const result = await listPartnerServiceReviews(
      new URLSearchParams({ accountId: f.accountId, limit: "25" }),
    );
    expect(result!.requests).toHaveLength(1);
    expect(result!.requests[0]).toMatchObject({
      id: f.jobId,
      accountId: f.accountId,
      siteName: "Sample site",
      preferredWindows: [{ localDate: "2026-09-10", timeOfDay: "morning" }],
    });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|cabinet|4045550100/u);
    expect(JSON.stringify(result)).not.toContain(f.appointmentId);
  });
  it("loads explicit job photos and scope but excludes access secrets, storage keys and account substitution", async () => {
    const f = await fixture(),
      detail = await getPartnerServiceReview(f.accountId, f.jobId);
    expect(detail!.request.description).toBe("Remove the sample cabinet.");
    expect(detail!.request.photos).toHaveLength(1);
    expect(detail!.request.photos[0]).toMatchObject({
      category: "intake",
      status: "processing",
      url: null,
    });
    expect(detail!.request.scopeFields).toEqual([
      { label: "quantity", value: "1" },
    ]);
    expect(detail!.request.proof).toEqual({ before: 2, after: 1 });
    expect(detail!.request.canSchedule).toBe(true);
    expect(JSON.stringify(detail)).not.toMatch(
      /SECRET|private-local-object|originalObjectKey|accessDetails|nestedProvider/u,
    );
    expect(await getPartnerServiceReview(randomUUID(), f.jobId)).toBeNull();
    expect(await getPartnerServiceReview(f.accountId, randomUUID())).toBeNull();
  });
  it("binds cursor pagination to company filters and blocks scheduling before required approval", async () => {
    const f = await fixture("approval_needed");
    await fixture("under_review", null, {
      id: f.accountId,
      name: f.accountName,
    });
    const first = await listPartnerServiceReviews(
      new URLSearchParams({ accountId: f.accountId, limit: "1" }),
    );
    expect(first!.page.nextCursor).toBeTruthy();
    const second = await listPartnerServiceReviews(
      new URLSearchParams({
        accountId: f.accountId,
        limit: "1",
        cursor: first!.page.nextCursor!,
      }),
    );
    expect(second!.requests).toHaveLength(1);
    expect(second!.requests[0]!.id).not.toBe(first!.requests[0]!.id);
    expect(
      await listPartnerServiceReviews(
        new URLSearchParams({
          accountId: randomUUID(),
          limit: "1",
          cursor: first!.page.nextCursor!,
        }),
      ),
    ).toBeNull();
    expect(
      (await getPartnerServiceReview(f.accountId, f.jobId))!.request
        .canSchedule,
    ).toBe(false);
    expect(
      await listPartnerServiceReviews(
        new URLSearchParams({ q: "a".repeat(101) }),
      ),
    ).toBeNull();
    expect(
      await listPartnerServiceReviews(
        new URLSearchParams({ includeSecrets: "true" }),
      ),
    ).toBeNull();
  });
});
