import { randomBytes } from "node:crypto";
import {
  decryptPartnerLocationSecret,
  encryptPartnerLocationSecret,
  PartnerLocationSecretConfigurationError,
} from "@/lib/partner-location-secrets";
import {
  PartnerLocationCreateSchema,
  PartnerLocationUpdateSchema,
} from "@/lib/partner-portal-v2-locations";
import {
  normalizePartnerJobMessageAttachmentIds,
  orderPartnerMediaAssociations,
  PartnerMediaUploadIntentSchema,
  projectPartnerJobMessageAttachmentHandles,
  resolvePartnerMediaFinalizeChecksum,
  sanitizePartnerMediaPublicValue,
} from "@/lib/partner-portal-v2-media";
import { isMissingMediaObjectError } from "@/lib/media-storage";
import {
  derivePartnerProofShareToken,
  hashPartnerProofShareToken,
  PartnerProofShareTokenConfigurationError,
} from "@/lib/partner-proof-share-tokens";

const ACCOUNT_ID = "55f64d58-0d21-4978-a0e1-4fd47c95b85b";
const JOB_ID = "65f64d58-0d21-4978-a0e1-4fd47c95b85b";
const EVIDENCE_ID = "75f64d58-0d21-4978-a0e1-4fd47c95b85b";
const OTHER_EVIDENCE_ID = "85f64d58-0d21-4978-a0e1-4fd47c95b85b";
const DELETED_EVIDENCE_ID = "95f64d58-0d21-4978-a0e1-4fd47c95b85b";
const FAILED_EVIDENCE_ID = "a5f64d58-0d21-4978-a0e1-4fd47c95b85b";
const RAW_ASSET_ID = "b5f64d58-0d21-4978-a0e1-4fd47c95b85b";
const ORIGINAL_ENV = {
  locationKey: process.env["PARTNER_LOCATION_SECRET_KEY_BASE64"],
  locationKeys: process.env["PARTNER_LOCATION_SECRET_KEYS_JSON"],
  locationVersion: process.env["PARTNER_LOCATION_SECRET_KEY_VERSION"],
  shareKey: process.env["PARTNER_PROOF_SHARE_TOKEN_KEY_BASE64"],
};

afterEach(() => {
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  restore("PARTNER_LOCATION_SECRET_KEY_BASE64", ORIGINAL_ENV.locationKey);
  restore("PARTNER_LOCATION_SECRET_KEYS_JSON", ORIGINAL_ENV.locationKeys);
  restore("PARTNER_LOCATION_SECRET_KEY_VERSION", ORIGINAL_ENV.locationVersion);
  restore("PARTNER_PROOF_SHARE_TOKEN_KEY_BASE64", ORIGINAL_ENV.shareKey);
});

describe("partner location secret envelope", () => {
  it("round-trips with authenticated encryption and supports key versions", () => {
    const key = randomBytes(32).toString("base64");
    process.env["PARTNER_LOCATION_SECRET_KEYS_JSON"] = JSON.stringify({
      7: key,
    });
    process.env["PARTNER_LOCATION_SECRET_KEY_VERSION"] = "7";
    delete process.env["PARTNER_LOCATION_SECRET_KEY_BASE64"];

    const encrypted = encryptPartnerLocationSecret("Gate code 1942#");
    expect(encrypted.keyVersion).toBe(7);
    expect(encrypted.ciphertext).not.toContain("1942");
    expect(decryptPartnerLocationSecret(encrypted)).toBe("Gate code 1942#");

    const tampered = {
      ...encrypted,
      ciphertext: `${encrypted.ciphertext.slice(0, -1)}A`,
    };
    expect(() => decryptPartnerLocationSecret(tampered)).toThrow();
  });

  it("fails closed when no valid storage key is configured", () => {
    delete process.env["PARTNER_LOCATION_SECRET_KEY_BASE64"];
    delete process.env["PARTNER_LOCATION_SECRET_KEYS_JSON"];
    delete process.env["PARTNER_LOCATION_SECRET_KEY_VERSION"];
    expect(() => encryptPartnerLocationSecret("gate code")).toThrow(
      PartnerLocationSecretConfigurationError,
    );
  });
});

describe("partner location request policy", () => {
  const valid = {
    siteName: "North warehouse",
    address: {
      line1: "100 Main Street",
      line2: null,
      city: "Marietta",
      state: "ga",
      postalCode: "30060",
    },
    timezone: "America/New_York",
    locale: "en-US",
  };

  it("normalizes state and validates IANA timezones", () => {
    expect(PartnerLocationCreateSchema.parse(valid).address.state).toBe("GA");
    expect(
      PartnerLocationCreateSchema.safeParse({
        ...valid,
        timezone: "Not/A_Timezone",
      }).success,
    ).toBe(false);
  });

  it("requires at least one revision-safe update field", () => {
    expect(PartnerLocationUpdateSchema.safeParse({}).success).toBe(false);
    expect(
      PartnerLocationUpdateSchema.safeParse({ accessSecret: null }).success,
    ).toBe(true);
  });
});

describe("partner media upload declaration", () => {
  const file = {
    clientId: "upload_0001",
    filename: "before.heic",
    contentType: "image/heic",
    byteLength: 1_024,
    checksumSha256: "a".repeat(64),
    category: "before" as const,
  };

  it("accepts supported 10 MB-bounded images and rejects duplicate client IDs", () => {
    expect(
      PartnerMediaUploadIntentSchema.safeParse({ files: [file] }).success,
    ).toBe(true);
    expect(
      PartnerMediaUploadIntentSchema.safeParse({ files: [file, file] }).success,
    ).toBe(false);
  });

  it("rejects active content and unsupported proof categories", () => {
    expect(
      PartnerMediaUploadIntentSchema.safeParse({
        files: [{ ...file, contentType: "image/svg+xml" }],
      }).success,
    ).toBe(false);
    expect(
      PartnerMediaUploadIntentSchema.safeParse({
        files: [{ ...file, category: "internal" }],
      }).success,
    ).toBe(false);
  });

  it("returns upload associations in client request order", () => {
    const first = { id: "first", filename: "before.jpg" };
    const second = { id: "second", filename: "after.jpg" };
    expect(
      orderPartnerMediaAssociations([first.id, second.id], [second, first]),
    ).toEqual([first, second]);
    expect(() =>
      orderPartnerMediaAssociations([first.id, "missing"], [first]),
    ).toThrow("partner_media_association_reload_failed");
  });

  it("recursively removes raw storage identifiers from public media DTOs", () => {
    const publicValue = sanitizePartnerMediaPublicValue({
      id: "association-id",
      assetId: "raw-asset-id",
      nested: {
        mediaAssetId: "raw-media-asset-id",
        allowed: true,
      },
      list: [{ assetId: "another-raw-id", status: "ready" }],
    });
    const serialized = JSON.stringify(publicValue);

    expect(publicValue).toEqual({
      id: "association-id",
      nested: { allowed: true },
      list: [{ status: "ready" }],
    });
    expect(serialized).not.toContain("assetId");
    expect(serialized).not.toContain("mediaAssetId");
    expect(serialized).not.toContain("raw-asset-id");
  });

  it("normalizes stored message attachment metadata to bounded evidence IDs", () => {
    expect(
      normalizePartnerJobMessageAttachmentIds([
        EVIDENCE_ID.toUpperCase(),
        EVIDENCE_ID,
        RAW_ASSET_ID,
        "not-an-id",
        null,
      ]),
    ).toEqual([EVIDENCE_ID, RAW_ASSET_ID]);
    expect(normalizePartnerJobMessageAttachmentIds({ ids: [] })).toEqual([]);
    expect(
      normalizePartnerJobMessageAttachmentIds(
        Array.from(
          { length: 12 },
          (_, index) =>
            `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        ),
      ),
    ).toHaveLength(10);
  });

  it("projects only current, ready job evidence as sanitized message handles", () => {
    const readyAt = new Date("2026-08-31T14:00:00.000Z");
    const createdAt = new Date("2026-08-31T13:00:00.000Z");
    const validRow = {
      id: EVIDENCE_ID,
      partnerAccountId: ACCOUNT_ID,
      partnerBookingId: JOB_ID,
      category: "before",
      caption: "  Loading dock  ",
      evidenceDeletedAt: null,
      assetDeletedAt: null,
      assetStatus: "ready",
      storageBucket: "private-media",
      originalObjectKey: "partner/account/job/original.jpg",
      filename: " before\u0000.jpg ",
      contentType: "IMAGE/JPEG",
      byteSize: 1_024,
      width: 1_200,
      height: 800,
      sha256: "a".repeat(64),
      createdAt,
      readyAt,
    };
    const handles = projectPartnerJobMessageAttachmentHandles({
      accountId: ACCOUNT_ID,
      jobId: JOB_ID,
      requestedIds: [
        EVIDENCE_ID,
        OTHER_EVIDENCE_ID,
        DELETED_EVIDENCE_ID,
        FAILED_EVIDENCE_ID,
        RAW_ASSET_ID,
        "malformed",
      ],
      rows: [
        validRow,
        {
          ...validRow,
          id: OTHER_EVIDENCE_ID,
          partnerBookingId: "c5f64d58-0d21-4978-a0e1-4fd47c95b85b",
        },
        {
          ...validRow,
          id: DELETED_EVIDENCE_ID,
          evidenceDeletedAt: new Date("2026-08-31T15:00:00.000Z"),
        },
        {
          ...validRow,
          id: FAILED_EVIDENCE_ID,
          assetStatus: "failed",
        },
      ],
    });

    expect(handles).toEqual([
      {
        id: EVIDENCE_ID,
        category: "before",
        caption: "Loading dock",
        filename: "before_.jpg",
        contentType: "image/jpeg",
        byteSize: 1_024,
        width: 1_200,
        height: 800,
        sha256: "a".repeat(64),
        createdAt: createdAt.toISOString(),
        readyAt: readyAt.toISOString(),
      },
    ]);
    const serialized = JSON.stringify(handles);
    expect(serialized).not.toContain("partnerAccountId");
    expect(serialized).not.toContain("partnerBookingId");
    expect(serialized).not.toContain("storageBucket");
    expect(serialized).not.toContain("originalObjectKey");
    expect(serialized).not.toContain(RAW_ASSET_ID);
  });

  it("only treats object-store not-found responses as resumable missing uploads", () => {
    expect(isMissingMediaObjectError({ name: "NoSuchKey" })).toBe(true);
    expect(
      isMissingMediaObjectError({
        $metadata: { httpStatusCode: 404 },
      }),
    ).toBe(true);
    expect(
      isMissingMediaObjectError({
        name: "ServiceUnavailable",
        $metadata: { httpStatusCode: 503 },
      }),
    ).toBe(false);
    expect(
      isMissingMediaObjectError({
        name: "NoSuchBucket",
        $metadata: { httpStatusCode: 404 },
      }),
    ).toBe(false);
  });

  it("never lets finalization replace the checksum bound to the upload intent", () => {
    expect(() =>
      resolvePartnerMediaFinalizeChecksum({
        sourceMetadata: { expectedSha256: "a".repeat(64) },
        suppliedChecksum: "b".repeat(64),
      }),
    ).toThrow("idempotency_conflict");

    expect(
      resolvePartnerMediaFinalizeChecksum({
        sourceMetadata: {},
        suppliedChecksum: "c".repeat(64),
      }),
    ).toEqual({
      expectedChecksum: "c".repeat(64),
      metadataPatch: { finalizeExpectedSha256: "c".repeat(64) },
    });
  });

  it("fails closed when a ready asset lacks or contradicts its input digest", () => {
    expect(() =>
      resolvePartnerMediaFinalizeChecksum({
        sourceMetadata: { expectedSha256: "a".repeat(64) },
        readyInputSha256: null,
      }),
    ).toThrow("media_integrity_conflict");
    expect(() =>
      resolvePartnerMediaFinalizeChecksum({
        sourceMetadata: { expectedSha256: "a".repeat(64) },
        readyInputSha256: "b".repeat(64),
      }),
    ).toThrow("media_integrity_conflict");
    expect(
      resolvePartnerMediaFinalizeChecksum({
        sourceMetadata: { expectedSha256: "a".repeat(64) },
        readyInputSha256: "a".repeat(64),
      }).expectedChecksum,
    ).toBe("a".repeat(64));
  });
});

describe("proof-share bearer derivation", () => {
  it("is deterministic per account/request key while storing only a hash", () => {
    process.env["PARTNER_PROOF_SHARE_TOKEN_KEY_BASE64"] =
      randomBytes(32).toString("base64");
    const first = derivePartnerProofShareToken({
      partnerAccountId: ACCOUNT_ID,
      idempotencyKeyHash: "b".repeat(64),
    });
    const replay = derivePartnerProofShareToken({
      partnerAccountId: ACCOUNT_ID,
      idempotencyKeyHash: "b".repeat(64),
    });
    const different = derivePartnerProofShareToken({
      partnerAccountId: ACCOUNT_ID,
      idempotencyKeyHash: "c".repeat(64),
    });
    expect(replay).toEqual(first);
    expect(different.token).not.toBe(first.token);
    expect(hashPartnerProofShareToken(first.token)).toBe(first.tokenHash);
    expect(hashPartnerProofShareToken("invalid token")).toBeNull();
  });

  it("fails closed without a token-signing key", () => {
    delete process.env["PARTNER_PROOF_SHARE_TOKEN_KEY_BASE64"];
    expect(() =>
      derivePartnerProofShareToken({
        partnerAccountId: ACCOUNT_ID,
        idempotencyKeyHash: "d".repeat(64),
      }),
    ).toThrow(PartnerProofShareTokenConfigurationError);
  });
});
