import { and, eq } from "drizzle-orm";
import {
  partnerAccountLocations,
  partnerLocationAddressReviews,
  type DatabaseClient,
} from "@/db";
import { TeamMutationFailure } from "@/lib/team-mutation";

type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0];

function expectedVersion(value: string): number {
  if (!/^[1-9][0-9]{0,9}$/u.test(value)) {
    throw new TeamMutationFailure(
      "invalid",
      "Refresh the address review before deciding it.",
      { status: 428 },
    );
  }
  return Number(value);
}

export async function decidePartnerLocationAddressReview(
  tx: Transaction,
  input: Readonly<{
    reviewId: string;
    decision: "verified" | "correction_required" | "dismissed";
    note: string;
    latitude?: number;
    longitude?: number;
    serviceAreaEligible?: boolean;
    teamMemberId: string;
    expectedVersion: string;
  }>,
) {
  const revision = expectedVersion(input.expectedVersion);
  const [review] = await tx
    .select()
    .from(partnerLocationAddressReviews)
    .where(eq(partnerLocationAddressReviews.id, input.reviewId))
    .for("update")
    .limit(1);
  if (!review) {
    throw new TeamMutationFailure("invalid", "Address review not found.", {
      status: 404,
    });
  }
  if (review.version !== revision) {
    throw new TeamMutationFailure(
      "conflict",
      "This address review changed. Refresh before deciding.",
      { status: 412 },
    );
  }
  if (review.state !== "pending") {
    throw new TeamMutationFailure(
      "conflict",
      "This address review already has a final decision.",
      { status: 409 },
    );
  }
  const [location] = await tx
    .select()
    .from(partnerAccountLocations)
    .where(
      and(
        eq(
          partnerAccountLocations.partnerAccountId,
          review.partnerAccountId,
        ),
        eq(partnerAccountLocations.id, review.locationId),
      ),
    )
    .for("update")
    .limit(1);
  if (!location) {
    throw new TeamMutationFailure("invalid", "Address review not found.", {
      status: 404,
    });
  }
  if (
    input.decision === "verified" &&
    (typeof input.latitude !== "number" ||
      !Number.isFinite(input.latitude) ||
      input.latitude < -90 ||
      input.latitude > 90 ||
      typeof input.longitude !== "number" ||
      !Number.isFinite(input.longitude) ||
      input.longitude < -180 ||
      input.longitude > 180 ||
      typeof input.serviceAreaEligible !== "boolean")
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Verified coordinates and a service-area decision are required.",
      { status: 422 },
    );
  }
  const now = new Date();
  if (input.decision === "verified") {
    await tx
      .update(partnerAccountLocations)
      .set({
        latitude: String(input.latitude),
        longitude: String(input.longitude),
        geocodeStatus: "manual",
        serviceAreaStatus: input.serviceAreaEligible ? "eligible" : "outside",
        addressVerificationStatus: "staff_verified",
        addressVerificationProvider: "manual",
        addressVerificationConfidence: 100,
        addressVerifiedAt: now,
        version: location.version + 1,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerAccountLocations.id, location.id),
          eq(
            partnerAccountLocations.partnerAccountId,
            review.partnerAccountId,
          ),
          eq(partnerAccountLocations.version, location.version),
        ),
      );
  }
  const [decided] = await tx
    .update(partnerLocationAddressReviews)
    .set({
      state: input.decision,
      reviewedByTeamMemberId: input.teamMemberId,
      resolutionNote: input.note,
      resolvedAt: now,
      version: review.version + 1,
      updatedAt: now,
    })
    .where(
      and(
        eq(partnerLocationAddressReviews.id, review.id),
        eq(partnerLocationAddressReviews.state, "pending"),
        eq(partnerLocationAddressReviews.version, review.version),
      ),
    )
    .returning();
  if (!decided) {
    throw new TeamMutationFailure(
      "conflict",
      "This address review changed. Refresh before deciding.",
      { status: 412 },
    );
  }
  return {
    before: {
      state: review.state,
      version: String(review.version),
      addressVerificationStatus: location.addressVerificationStatus,
    },
    after: {
      state: decided.state,
      version: String(decided.version),
      addressVerificationStatus:
        input.decision === "verified"
          ? "staff_verified"
          : location.addressVerificationStatus,
    },
    review: decided,
    locationId: location.id,
    partnerAccountId: review.partnerAccountId,
    locationVersion:
      input.decision === "verified" ? location.version + 1 : location.version,
  };
}
