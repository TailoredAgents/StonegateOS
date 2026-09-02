import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
} from "node:crypto";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js/core";
import metadataImport from "libphonenumber-js/metadata.min";
import type { MetadataJson } from "libphonenumber-js/core";
import {
  auditLogs,
  getDb,
  outboxEvents,
  partnerAccountMemberships,
  partnerAccounts,
  partnerNotificationEndpointChallenges,
  partnerNotificationEndpoints,
  partnerNotificationPreferences,
  partnerUsers,
} from "@/db";
import { sendSmsMessage } from "@/lib/messaging";
import {
  hashPartnerPassword,
  verifyPartnerPassword,
} from "@/lib/partner-password-crypto";
import { arePartnerPortalOutboundNotificationsEnabled } from "@/lib/partner-portal-feature-flags";

export const PARTNER_NOTIFICATION_SMS_CODE_EVENT =
  "partner.notification_endpoint.sms_code" as const;
export const PARTNER_SMS_CONSENT_SOURCE =
  "partner_portal_notification_settings" as const;
export const PARTNER_SMS_CONSENT_VERSION = "partner-sms-consent-v1" as const;

const VERIFICATION_TTL_MS = 10 * 60 * 1_000;
const MAX_VERIFICATION_ATTEMPTS = 5;
const ENVELOPE_VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const DEVELOPMENT_SECRET =
  "stonegate-partner-notification-endpoint-development-only-secret";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

// Jest's native-ESM bridge wraps JSON-backed package exports in `default`,
// while Node and Next receive the metadata object directly. Resolve either
// representation and pass metadata explicitly so validation is identical.
function hasDefaultPhoneMetadata(
  value: unknown,
): value is { default: MetadataJson } {
  return (
    typeof value === "object" &&
    value !== null &&
    "default" in value &&
    typeof value.default === "object" &&
    value.default !== null
  );
}

const PHONE_METADATA: MetadataJson = hasDefaultPhoneMetadata(metadataImport)
  ? metadataImport.default
  : metadataImport;

export class PartnerNotificationEndpointConfigurationError extends Error {
  constructor() {
    super("Partner notification endpoint verification is unavailable.");
    this.name = "PartnerNotificationEndpointConfigurationError";
  }
}

export type PartnerNotificationEndpointPublic = Readonly<{
  id: string;
  channel: "sms";
  maskedDestination: string;
  status: "pending" | "verified" | "revoked";
  verifiedAt: string | null;
  consentSource: string | null;
  consentVersion: string | null;
  createdAt: string;
  updatedAt: string;
  activeChallenge: Readonly<{
    expiresAt: string;
    deliveryStatus:
      | "queued"
      | "dispatching"
      | "accepted"
      | "failed"
      | "reconciliation_required";
  }> | null;
}>;

type PartnerNotificationActor = Readonly<{
  partnerUserId: string;
  accountId: string;
  membershipId: string;
  sessionId: string;
  correlationId: string;
  idempotencyKeyHash: string;
}>;

type EndpointRow = typeof partnerNotificationEndpoints.$inferSelect;

function endpointSecret(): Buffer {
  const configured =
    process.env["PARTNER_NOTIFICATION_ENDPOINT_SECRET"]?.trim() ||
    process.env["TEAM_AUTH_RATE_LIMIT_SECRET"]?.trim() ||
    process.env["ADMIN_API_KEY"]?.trim() ||
    (process.env["NODE_ENV"] === "production" ? "" : DEVELOPMENT_SECRET);
  if (
    !configured ||
    (process.env["NODE_ENV"] === "production" &&
      Buffer.byteLength(configured, "utf8") < 32)
  ) {
    throw new PartnerNotificationEndpointConfigurationError();
  }
  return createHash("sha256")
    .update("stonegate-partner-notification-endpoint\0", "utf8")
    .update(configured, "utf8")
    .digest();
}

function endpointPurposeKey(purpose: "delivery-v1" | "fingerprint-v1"): Buffer {
  return createHmac("sha256", endpointSecret())
    .update("stonegate-partner-notification-endpoint-purpose\0", "utf8")
    .update(purpose, "utf8")
    .digest();
}

export function normalizePartnerSmsDestination(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 80) return null;
  const parsed = parsePhoneNumberFromString(value.trim(), "US", PHONE_METADATA);
  if (!parsed?.isValid()) return null;
  const normalized = parsed.number;
  return /^\+[1-9][0-9]{7,14}$/u.test(normalized) ? normalized : null;
}

export function maskPartnerSmsDestination(value: string): string {
  const normalized = normalizePartnerSmsDestination(value);
  if (!normalized) throw new TypeError("The SMS destination is invalid.");
  return `•••• ${normalized.slice(-4)}`;
}

export function partnerNotificationSensitiveFingerprint(value: string): string {
  return createHmac("sha256", endpointPurposeKey("fingerprint-v1"))
    .update("partner-notification-sensitive\0", "utf8")
    .update(value, "utf8")
    .digest("hex");
}

function verificationMaterial(challengeId: string, code: string): string {
  return `partner-notification-sms-code\0${challengeId}\0${code}`;
}

function deliveryAad(input: {
  challengeId: string;
  endpointId: string;
  generation: number;
}): Buffer {
  return Buffer.from(
    `partner-notification-sms-delivery\0${input.challengeId}\0${input.endpointId}\0${input.generation}`,
    "utf8",
  );
}

function encryptVerificationCode(input: {
  challengeId: string;
  endpointId: string;
  generation: number;
  code: string;
}): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(
    ALGORITHM,
    endpointPurposeKey("delivery-v1"),
    iv,
    {
      authTagLength: AUTH_TAG_BYTES,
    },
  );
  cipher.setAAD(deliveryAad(input));
  const ciphertext = Buffer.concat([
    cipher.update(input.code, "utf8"),
    cipher.final(),
  ]);
  return [
    ENVELOPE_VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function decryptVerificationCode(input: {
  challengeId: string;
  endpointId: string;
  generation: number;
  ciphertext: string;
}): string {
  const parts = input.ciphertext.split(".");
  if (parts.length !== 4 || parts[0] !== ENVELOPE_VERSION) {
    throw new TypeError("partner_notification_code_envelope_invalid");
  }
  const iv = Buffer.from(parts[1] ?? "", "base64url");
  const tag = Buffer.from(parts[2] ?? "", "base64url");
  const ciphertext = Buffer.from(parts[3] ?? "", "base64url");
  if (
    iv.length !== IV_BYTES ||
    tag.length !== AUTH_TAG_BYTES ||
    ciphertext.length < 1 ||
    ciphertext.length > 64
  ) {
    throw new TypeError("partner_notification_code_envelope_invalid");
  }
  const decipher = createDecipheriv(
    ALGORITHM,
    endpointPurposeKey("delivery-v1"),
    iv,
    {
      authTagLength: AUTH_TAG_BYTES,
    },
  );
  decipher.setAAD(deliveryAad(input));
  decipher.setAuthTag(tag);
  const code = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
  if (!/^\d{6}$/u.test(code)) {
    throw new TypeError("partner_notification_code_envelope_invalid");
  }
  return code;
}

function publicEndpoint(
  row: EndpointRow,
  activeChallenge: PartnerNotificationEndpointPublic["activeChallenge"] = null,
): PartnerNotificationEndpointPublic {
  return {
    id: row.id,
    channel: "sms",
    maskedDestination: maskPartnerSmsDestination(row.normalizedDestination),
    status: row.status,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    consentSource: row.consentSource,
    consentVersion: row.consentVersion,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    activeChallenge,
  };
}

function actorAuditValues(input: {
  actor: PartnerNotificationActor;
  action: string;
  outcome: "attempted" | "succeeded" | "denied" | "failed";
  entityId: string | null;
  meta: Record<string, unknown>;
  at: Date;
}) {
  return {
    id: randomUUID(),
    actorType: "human" as const,
    actorId: input.actor.partnerUserId,
    sessionId: input.actor.sessionId,
    authMethod: "partner_session",
    correlationId: input.actor.correlationId,
    outcome: input.outcome,
    surface: "partner_portal_v2",
    idempotencyKeyHash: input.actor.idempotencyKeyHash,
    action: input.action,
    entityType: "partner_notification_endpoint",
    entityId: input.entityId,
    meta: {
      accountId: input.actor.accountId,
      membershipId: input.actor.membershipId,
      ...input.meta,
    },
    createdAt: input.at,
  };
}

async function lockAndValidateActor(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  actor: PartnerNotificationActor,
): Promise<boolean> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`partner-notification-endpoint:${actor.partnerUserId}`}))`,
  );
  const [binding] = await tx
    .select({ id: partnerAccountMemberships.id })
    .from(partnerAccountMemberships)
    .innerJoin(
      partnerUsers,
      and(
        eq(partnerUsers.id, partnerAccountMemberships.partnerUserId),
        eq(partnerUsers.active, true),
      ),
    )
    .innerJoin(
      partnerAccounts,
      and(
        eq(partnerAccounts.id, partnerAccountMemberships.partnerAccountId),
        eq(partnerAccounts.portalAccessEnabled, true),
      ),
    )
    .where(
      and(
        eq(partnerAccountMemberships.id, actor.membershipId),
        eq(partnerAccountMemberships.partnerAccountId, actor.accountId),
        eq(partnerAccountMemberships.partnerUserId, actor.partnerUserId),
        eq(partnerAccountMemberships.status, "active"),
      ),
    )
    .limit(1);
  return Boolean(binding);
}

export async function listPartnerNotificationEndpoints(input: {
  partnerUserId: string;
}): Promise<PartnerNotificationEndpointPublic[]> {
  const rows = await getDb()
    .select()
    .from(partnerNotificationEndpoints)
    .where(eq(partnerNotificationEndpoints.partnerUserId, input.partnerUserId))
    .orderBy(
      desc(partnerNotificationEndpoints.updatedAt),
      desc(partnerNotificationEndpoints.id),
    );
  const pending = rows.filter((row) => row.status === "pending");
  const challenges = pending.length
    ? await getDb()
        .select({
          endpointId: partnerNotificationEndpointChallenges.endpointId,
          expiresAt: partnerNotificationEndpointChallenges.expiresAt,
          deliveryStatus: partnerNotificationEndpointChallenges.deliveryStatus,
        })
        .from(partnerNotificationEndpointChallenges)
        .where(
          and(
            inArray(
              partnerNotificationEndpointChallenges.endpointId,
              pending.map((row) => row.id),
            ),
            eq(partnerNotificationEndpointChallenges.status, "pending"),
            eq(
              partnerNotificationEndpointChallenges.partnerUserId,
              input.partnerUserId,
            ),
          ),
        )
    : [];
  const byEndpoint = new Map(
    challenges.map((challenge) => [
      challenge.endpointId,
      {
        expiresAt: challenge.expiresAt.toISOString(),
        deliveryStatus: challenge.deliveryStatus,
      },
    ]),
  );
  return rows.map((row) => publicEndpoint(row, byEndpoint.get(row.id) ?? null));
}

export type RequestPartnerNotificationEndpointResult =
  | {
      kind: "challenge_created";
      endpoint: PartnerNotificationEndpointPublic;
      challenge: {
        expiresAt: string;
        deliveryStatus: "queued";
      };
    }
  | { kind: "already_verified"; endpoint: PartnerNotificationEndpointPublic }
  | { kind: "cooldown"; retryAfterSeconds: number }
  | { kind: "binding_unavailable" };

export async function requestPartnerNotificationEndpointVerification(input: {
  actor: PartnerNotificationActor;
  normalizedDestination: string;
  now?: Date;
}): Promise<RequestPartnerNotificationEndpointResult> {
  const normalizedDestination = normalizePartnerSmsDestination(
    input.normalizedDestination,
  );
  if (!normalizedDestination) throw new TypeError("invalid_sms_destination");
  const now = input.now ?? new Date();
  const challengeId = randomUUID();
  const outboxEventId = randomUUID();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const codeHash = await hashPartnerPassword(
    verificationMaterial(challengeId, code),
  );
  const destinationFingerprint = partnerNotificationSensitiveFingerprint(
    normalizedDestination,
  );

  return getDb().transaction(async (tx) => {
    if (!(await lockAndValidateActor(tx, input.actor))) {
      return { kind: "binding_unavailable" as const };
    }
    let [endpoint] = await tx
      .select()
      .from(partnerNotificationEndpoints)
      .where(
        and(
          eq(
            partnerNotificationEndpoints.partnerUserId,
            input.actor.partnerUserId,
          ),
          eq(partnerNotificationEndpoints.channel, "sms"),
          eq(
            partnerNotificationEndpoints.normalizedDestination,
            normalizedDestination,
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (endpoint?.status === "verified") {
      await tx.insert(auditLogs).values(
        actorAuditValues({
          actor: input.actor,
          action: "partner.notification_endpoint.verification_requested",
          outcome: "succeeded",
          entityId: endpoint.id,
          meta: { alreadyVerified: true, destinationFingerprint },
          at: now,
        }),
      );
      return {
        kind: "already_verified" as const,
        endpoint: publicEndpoint(endpoint),
      };
    }
    if (!endpoint) {
      [endpoint] = await tx
        .insert(partnerNotificationEndpoints)
        .values({
          partnerUserId: input.actor.partnerUserId,
          channel: "sms",
          normalizedDestination,
          status: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .returning();
    } else if (endpoint.status === "revoked") {
      [endpoint] = await tx
        .update(partnerNotificationEndpoints)
        .set({
          status: "pending",
          verifiedAt: null,
          consentAt: null,
          consentSource: null,
          consentVersion: null,
          revokedAt: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(partnerNotificationEndpoints.id, endpoint.id),
            eq(
              partnerNotificationEndpoints.partnerUserId,
              input.actor.partnerUserId,
            ),
          ),
        )
        .returning();
    }
    if (!endpoint) throw new Error("partner_notification_endpoint_not_created");

    const [activeChallenge] = await tx
      .select({
        createdAt: partnerNotificationEndpointChallenges.createdAt,
        expiresAt: partnerNotificationEndpointChallenges.expiresAt,
      })
      .from(partnerNotificationEndpointChallenges)
      .where(
        and(
          eq(partnerNotificationEndpointChallenges.endpointId, endpoint.id),
          eq(partnerNotificationEndpointChallenges.status, "pending"),
        ),
      )
      .for("update")
      .limit(1);
    if (
      activeChallenge &&
      activeChallenge.expiresAt > now &&
      now.getTime() - activeChallenge.createdAt.getTime() < 60_000
    ) {
      return {
        kind: "cooldown" as const,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil(
            (60_000 - (now.getTime() - activeChallenge.createdAt.getTime())) /
              1_000,
          ),
        ),
      };
    }

    const otherPendingEndpoints = await tx
      .select({ id: partnerNotificationEndpoints.id })
      .from(partnerNotificationEndpoints)
      .where(
        and(
          eq(
            partnerNotificationEndpoints.partnerUserId,
            input.actor.partnerUserId,
          ),
          eq(partnerNotificationEndpoints.channel, "sms"),
          eq(partnerNotificationEndpoints.status, "pending"),
          ne(partnerNotificationEndpoints.id, endpoint.id),
        ),
      )
      .for("update");
    const otherPendingIds = otherPendingEndpoints.map((row) => row.id);
    if (otherPendingIds.length > 0) {
      await tx
        .update(partnerNotificationEndpoints)
        .set({ status: "revoked", revokedAt: now, updatedAt: now })
        .where(inArray(partnerNotificationEndpoints.id, otherPendingIds));
      await tx
        .update(partnerNotificationEndpointChallenges)
        .set({
          status: "revoked",
          codeHash: null,
          revokedAt: now,
          updatedAt: now,
        })
        .where(
          and(
            inArray(
              partnerNotificationEndpointChallenges.endpointId,
              otherPendingIds,
            ),
            eq(partnerNotificationEndpointChallenges.status, "pending"),
          ),
        );
    }

    const [latest] = await tx
      .select({ generation: partnerNotificationEndpointChallenges.generation })
      .from(partnerNotificationEndpointChallenges)
      .where(eq(partnerNotificationEndpointChallenges.endpointId, endpoint.id))
      .orderBy(desc(partnerNotificationEndpointChallenges.generation))
      .limit(1);
    const generation = (latest?.generation ?? 0) + 1;
    await tx
      .update(partnerNotificationEndpointChallenges)
      .set({
        status: "revoked",
        codeHash: null,
        revokedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerNotificationEndpointChallenges.endpointId, endpoint.id),
          eq(partnerNotificationEndpointChallenges.status, "pending"),
        ),
      );
    const expiresAt = new Date(now.getTime() + VERIFICATION_TTL_MS);
    const codeCiphertext = encryptVerificationCode({
      challengeId,
      endpointId: endpoint.id,
      generation,
      code,
    });
    const [outbox] = await tx
      .insert(outboxEvents)
      .values({
        id: outboxEventId,
        type: PARTNER_NOTIFICATION_SMS_CODE_EVENT,
        payload: {
          challengeId,
          endpointId: endpoint.id,
          generation,
          codeCiphertext,
          correlationId: input.actor.correlationId,
        },
        createdAt: now,
      })
      .returning({ id: outboxEvents.id });
    if (!outbox) throw new Error("partner_notification_outbox_not_created");
    const [challenge] = await tx
      .insert(partnerNotificationEndpointChallenges)
      .values({
        id: challengeId,
        endpointId: endpoint.id,
        partnerUserId: input.actor.partnerUserId,
        partnerAccountId: input.actor.accountId,
        membershipId: input.actor.membershipId,
        codeHash,
        generation,
        status: "pending",
        attemptCount: 0,
        deliveryStatus: "queued",
        deliveryOutboxEventId: outboxEventId,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: partnerNotificationEndpointChallenges.id });
    if (!challenge)
      throw new Error("partner_notification_challenge_not_created");
    await tx.insert(auditLogs).values(
      actorAuditValues({
        actor: input.actor,
        action: "partner.notification_endpoint.verification_requested",
        outcome: "attempted",
        entityId: endpoint.id,
        meta: {
          challengeId,
          generation,
          expiresAt: expiresAt.toISOString(),
          destinationFingerprint,
        },
        at: now,
      }),
    );
    return {
      kind: "challenge_created" as const,
      endpoint: publicEndpoint(endpoint),
      challenge: {
        expiresAt: expiresAt.toISOString(),
        deliveryStatus: "queued" as const,
      },
    };
  });
}

export type CompletePartnerNotificationEndpointResult =
  | { kind: "verified"; endpoint: PartnerNotificationEndpointPublic }
  | { kind: "verification_failed" };

export async function completePartnerNotificationEndpointVerification(input: {
  actor: PartnerNotificationActor;
  endpointId: string;
  code: string;
  consentAccepted: true;
  consentVersion: string;
  now?: Date;
}): Promise<CompletePartnerNotificationEndpointResult> {
  if (
    !UUID_PATTERN.test(input.endpointId) ||
    !/^\d{6}$/u.test(input.code) ||
    input.consentAccepted !== true ||
    input.consentVersion !== PARTNER_SMS_CONSENT_VERSION
  ) {
    return { kind: "verification_failed" };
  }
  const now = input.now ?? new Date();
  const db = getDb();
  const [candidate] = await db
    .select({
      id: partnerNotificationEndpointChallenges.id,
      codeHash: partnerNotificationEndpointChallenges.codeHash,
    })
    .from(partnerNotificationEndpointChallenges)
    .where(
      and(
        eq(partnerNotificationEndpointChallenges.endpointId, input.endpointId),
        eq(
          partnerNotificationEndpointChallenges.partnerUserId,
          input.actor.partnerUserId,
        ),
        eq(
          partnerNotificationEndpointChallenges.partnerAccountId,
          input.actor.accountId,
        ),
        eq(
          partnerNotificationEndpointChallenges.membershipId,
          input.actor.membershipId,
        ),
        eq(partnerNotificationEndpointChallenges.status, "pending"),
      ),
    )
    .limit(1);
  if (!candidate?.codeHash) return { kind: "verification_failed" };
  const verification = await verifyPartnerPassword(
    verificationMaterial(candidate.id, input.code),
    candidate.codeHash,
  );

  return db.transaction(async (tx) => {
    if (!(await lockAndValidateActor(tx, input.actor))) {
      return { kind: "verification_failed" as const };
    }
    const [endpoint] = await tx
      .select()
      .from(partnerNotificationEndpoints)
      .where(
        and(
          eq(partnerNotificationEndpoints.id, input.endpointId),
          eq(
            partnerNotificationEndpoints.partnerUserId,
            input.actor.partnerUserId,
          ),
        ),
      )
      .for("update")
      .limit(1);
    const [challenge] = await tx
      .select()
      .from(partnerNotificationEndpointChallenges)
      .where(
        and(
          eq(partnerNotificationEndpointChallenges.id, candidate.id),
          eq(
            partnerNotificationEndpointChallenges.endpointId,
            input.endpointId,
          ),
          eq(
            partnerNotificationEndpointChallenges.partnerUserId,
            input.actor.partnerUserId,
          ),
          eq(
            partnerNotificationEndpointChallenges.partnerAccountId,
            input.actor.accountId,
          ),
          eq(
            partnerNotificationEndpointChallenges.membershipId,
            input.actor.membershipId,
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (
      !challenge ||
      !endpoint ||
      challenge.status !== "pending" ||
      endpoint.status !== "pending" ||
      !challenge.codeHash ||
      challenge.codeHash !== candidate.codeHash
    ) {
      return { kind: "verification_failed" as const };
    }
    if (challenge.expiresAt <= now) {
      await tx
        .update(partnerNotificationEndpointChallenges)
        .set({
          status: "expired",
          codeHash: null,
          expiredAt: now,
          updatedAt: now,
        })
        .where(eq(partnerNotificationEndpointChallenges.id, challenge.id));
      await tx.insert(auditLogs).values(
        actorAuditValues({
          actor: input.actor,
          action: "partner.notification_endpoint.verification_failed",
          outcome: "denied",
          entityId: endpoint.id,
          meta: { challengeId: challenge.id, reason: "expired" },
          at: now,
        }),
      );
      return { kind: "verification_failed" as const };
    }
    if (!verification.valid) {
      const attemptCount = Math.min(
        MAX_VERIFICATION_ATTEMPTS,
        challenge.attemptCount + 1,
      );
      const exhausted = attemptCount >= MAX_VERIFICATION_ATTEMPTS;
      await tx
        .update(partnerNotificationEndpointChallenges)
        .set({
          attemptCount,
          ...(exhausted
            ? {
                status: "revoked" as const,
                codeHash: null,
                revokedAt: now,
              }
            : {}),
          updatedAt: now,
        })
        .where(eq(partnerNotificationEndpointChallenges.id, challenge.id));
      await tx.insert(auditLogs).values(
        actorAuditValues({
          actor: input.actor,
          action: "partner.notification_endpoint.verification_failed",
          outcome: "denied",
          entityId: endpoint.id,
          meta: { challengeId: challenge.id, attemptCount, exhausted },
          at: now,
        }),
      );
      return { kind: "verification_failed" as const };
    }

    const otherVerified = await tx
      .select({ id: partnerNotificationEndpoints.id })
      .from(partnerNotificationEndpoints)
      .where(
        and(
          eq(
            partnerNotificationEndpoints.partnerUserId,
            input.actor.partnerUserId,
          ),
          eq(partnerNotificationEndpoints.channel, "sms"),
          eq(partnerNotificationEndpoints.status, "verified"),
          ne(partnerNotificationEndpoints.id, endpoint.id),
        ),
      )
      .for("update");
    const replacedIds = otherVerified.map((row) => row.id);
    if (replacedIds.length > 0) {
      await tx
        .update(partnerNotificationEndpoints)
        .set({ status: "revoked", revokedAt: now, updatedAt: now })
        .where(inArray(partnerNotificationEndpoints.id, replacedIds));
      await tx
        .update(partnerNotificationPreferences)
        .set({
          smsEnabled: false,
          smsVerifiedOptInAt: null,
          smsVerifiedPhoneE164: null,
          smsVerifiedEndpointId: null,
          smsOptInSource: null,
          smsConsentVersion: null,
          updatedAt: now,
        })
        .where(
          inArray(
            partnerNotificationPreferences.smsVerifiedEndpointId,
            replacedIds,
          ),
        );
    }
    const [verified] = await tx
      .update(partnerNotificationEndpoints)
      .set({
        status: "verified",
        verifiedAt: now,
        consentAt: now,
        consentSource: PARTNER_SMS_CONSENT_SOURCE,
        consentVersion: PARTNER_SMS_CONSENT_VERSION,
        revokedAt: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerNotificationEndpoints.id, endpoint.id),
          eq(
            partnerNotificationEndpoints.partnerUserId,
            input.actor.partnerUserId,
          ),
          eq(partnerNotificationEndpoints.status, "pending"),
        ),
      )
      .returning();
    if (!verified)
      throw new Error("partner_notification_endpoint_not_verified");
    const [consumed] = await tx
      .update(partnerNotificationEndpointChallenges)
      .set({
        status: "consumed",
        codeHash: null,
        consumedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerNotificationEndpointChallenges.id, challenge.id),
          eq(partnerNotificationEndpointChallenges.status, "pending"),
        ),
      )
      .returning({ id: partnerNotificationEndpointChallenges.id });
    if (!consumed)
      throw new Error("partner_notification_challenge_not_consumed");
    await tx.insert(auditLogs).values(
      actorAuditValues({
        actor: input.actor,
        action: "partner.notification_endpoint.verified",
        outcome: "succeeded",
        entityId: verified.id,
        meta: {
          challengeId: challenge.id,
          consentSource: PARTNER_SMS_CONSENT_SOURCE,
          consentVersion: PARTNER_SMS_CONSENT_VERSION,
          replacedEndpointCount: replacedIds.length,
        },
        at: now,
      }),
    );
    return { kind: "verified" as const, endpoint: publicEndpoint(verified) };
  });
}

export type RevokePartnerNotificationEndpointResult =
  | { kind: "revoked"; endpoint: PartnerNotificationEndpointPublic }
  | { kind: "not_found" };

export async function revokePartnerNotificationEndpoint(input: {
  actor: PartnerNotificationActor;
  endpointId: string;
  now?: Date;
}): Promise<RevokePartnerNotificationEndpointResult> {
  if (!UUID_PATTERN.test(input.endpointId)) return { kind: "not_found" };
  const now = input.now ?? new Date();
  return getDb().transaction(async (tx) => {
    if (!(await lockAndValidateActor(tx, input.actor))) {
      return { kind: "not_found" as const };
    }
    const [endpoint] = await tx
      .select()
      .from(partnerNotificationEndpoints)
      .where(
        and(
          eq(partnerNotificationEndpoints.id, input.endpointId),
          eq(
            partnerNotificationEndpoints.partnerUserId,
            input.actor.partnerUserId,
          ),
        ),
      )
      .for("update")
      .limit(1);
    if (!endpoint) return { kind: "not_found" as const };
    if (endpoint.status === "revoked") {
      return { kind: "revoked" as const, endpoint: publicEndpoint(endpoint) };
    }
    const [revoked] = await tx
      .update(partnerNotificationEndpoints)
      .set({ status: "revoked", revokedAt: now, updatedAt: now })
      .where(
        and(
          eq(partnerNotificationEndpoints.id, endpoint.id),
          eq(
            partnerNotificationEndpoints.partnerUserId,
            input.actor.partnerUserId,
          ),
        ),
      )
      .returning();
    if (!revoked) throw new Error("partner_notification_endpoint_not_revoked");
    await tx
      .update(partnerNotificationEndpointChallenges)
      .set({
        status: "revoked",
        codeHash: null,
        revokedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerNotificationEndpointChallenges.endpointId, endpoint.id),
          eq(partnerNotificationEndpointChallenges.status, "pending"),
        ),
      );
    await tx
      .update(partnerNotificationPreferences)
      .set({
        smsEnabled: false,
        smsVerifiedOptInAt: null,
        smsVerifiedPhoneE164: null,
        smsVerifiedEndpointId: null,
        smsOptInSource: null,
        smsConsentVersion: null,
        updatedAt: now,
      })
      .where(
        eq(partnerNotificationPreferences.smsVerifiedEndpointId, endpoint.id),
      );
    await tx.insert(auditLogs).values(
      actorAuditValues({
        actor: input.actor,
        action: "partner.notification_endpoint.revoked",
        outcome: "succeeded",
        entityId: endpoint.id,
        meta: {
          previousStatus: endpoint.status,
          smsPreferencesDisabled: true,
        },
        at: now,
      }),
    );
    return { kind: "revoked" as const, endpoint: publicEndpoint(revoked) };
  });
}

export type PartnerNotificationSmsDeliveryOutcome =
  | { status: "processed" }
  | { status: "skipped"; error: string }
  | { status: "retry"; error: string; nextAttemptAt: Date };

function safeProviderValue(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized && /^[A-Za-z0-9._:-]{1,240}$/u.test(normalized)
    ? normalized
    : null;
}

export async function processPartnerNotificationSmsCode(input: {
  challengeId: string;
  endpointId: string;
  generation: number;
  codeCiphertext: string;
  outboxEventId: string;
  correlationId: string | null;
}): Promise<PartnerNotificationSmsDeliveryOutcome> {
  let code: string;
  try {
    code = decryptVerificationCode({
      challengeId: input.challengeId,
      endpointId: input.endpointId,
      generation: input.generation,
      ciphertext: input.codeCiphertext,
    });
  } catch (error) {
    if (error instanceof PartnerNotificationEndpointConfigurationError) {
      throw error;
    }
    return { status: "skipped", error: "partner_sms_code_payload_invalid" };
  }
  const db = getDb();
  const attemptId = randomUUID();
  const prepared = await db.transaction(async (tx) => {
    const [endpoint] = await tx
      .select()
      .from(partnerNotificationEndpoints)
      .where(eq(partnerNotificationEndpoints.id, input.endpointId))
      .for("update")
      .limit(1);
    const [challenge] = await tx
      .select()
      .from(partnerNotificationEndpointChallenges)
      .where(eq(partnerNotificationEndpointChallenges.id, input.challengeId))
      .for("update")
      .limit(1);
    if (
      !challenge ||
      !endpoint ||
      challenge.endpointId !== endpoint.id ||
      challenge.partnerUserId !== endpoint.partnerUserId ||
      challenge.generation !== input.generation ||
      challenge.deliveryOutboxEventId !== input.outboxEventId ||
      challenge.status !== "pending" ||
      endpoint.status !== "pending"
    ) {
      return { kind: "terminal" as const };
    }
    const now = new Date();
    if (challenge.expiresAt <= now) {
      await tx
        .update(partnerNotificationEndpointChallenges)
        .set({
          status: "expired",
          codeHash: null,
          expiredAt: now,
          updatedAt: now,
        })
        .where(eq(partnerNotificationEndpointChallenges.id, challenge.id));
      return { kind: "terminal" as const };
    }
    const [binding] = await tx
      .select({ id: partnerAccountMemberships.id })
      .from(partnerAccountMemberships)
      .innerJoin(
        partnerUsers,
        and(
          eq(partnerUsers.id, partnerAccountMemberships.partnerUserId),
          eq(partnerUsers.active, true),
        ),
      )
      .innerJoin(
        partnerAccounts,
        and(
          eq(partnerAccounts.id, partnerAccountMemberships.partnerAccountId),
          eq(partnerAccounts.portalAccessEnabled, true),
        ),
      )
      .where(
        and(
          eq(partnerAccountMemberships.id, challenge.membershipId),
          eq(
            partnerAccountMemberships.partnerAccountId,
            challenge.partnerAccountId,
          ),
          eq(partnerAccountMemberships.partnerUserId, challenge.partnerUserId),
          eq(partnerAccountMemberships.status, "active"),
        ),
      )
      .limit(1);
    if (!binding) {
      await tx
        .update(partnerNotificationEndpointChallenges)
        .set({
          status: "revoked",
          codeHash: null,
          revokedAt: now,
          deliveryStatus: "failed",
          deliveryDetail: "membership_unavailable",
          updatedAt: now,
        })
        .where(eq(partnerNotificationEndpointChallenges.id, challenge.id));
      await tx.insert(auditLogs).values({
        id: randomUUID(),
        actorType: "system",
        actorId: challenge.partnerUserId,
        actorLabel: "partner-notification-endpoint-worker",
        authMethod: "service",
        correlationId: input.correlationId,
        outcome: "denied",
        surface: "partner_portal_v2",
        action: "partner.notification_endpoint.verification_code_suppressed",
        entityType: "partner_notification_endpoint_challenge",
        entityId: challenge.id,
        meta: {
          accountId: challenge.partnerAccountId,
          membershipId: challenge.membershipId,
          endpointId: endpoint.id,
          reason: "membership_unavailable",
        },
        createdAt: now,
      });
      return { kind: "terminal" as const };
    }
    if (
      !arePartnerPortalOutboundNotificationsEnabled(challenge.partnerAccountId)
    ) {
      return { kind: "feature_disabled" as const };
    }
    if (challenge.deliveryStatus === "dispatching") {
      await tx
        .update(partnerNotificationEndpointChallenges)
        .set({
          deliveryStatus: "reconciliation_required",
          deliveryDetail: "dispatch_result_not_persisted",
          updatedAt: now,
        })
        .where(eq(partnerNotificationEndpointChallenges.id, challenge.id));
      return { kind: "terminal" as const };
    }
    if (challenge.deliveryStatus !== "queued") {
      return { kind: "terminal" as const };
    }
    const [claimed] = await tx
      .update(partnerNotificationEndpointChallenges)
      .set({
        deliveryStatus: "dispatching",
        deliveryAttemptId: attemptId,
        dispatchStartedAt: now,
        deliveryDetail: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerNotificationEndpointChallenges.id, challenge.id),
          eq(partnerNotificationEndpointChallenges.deliveryStatus, "queued"),
        ),
      )
      .returning({ id: partnerNotificationEndpointChallenges.id });
    if (!claimed) return { kind: "terminal" as const };
    return { kind: "dispatch" as const, challenge, endpoint };
  });
  if (prepared.kind === "feature_disabled") {
    return {
      status: "retry",
      error: "partner_sms_code_feature_disabled",
      nextAttemptAt: new Date(Date.now() + 15 * 60_000),
    };
  }
  if (prepared.kind !== "dispatch") return { status: "processed" };

  const message = `Stonegate Partner Portal verification code: ${code}. It expires in 10 minutes. Do not share this code. Reply STOP to opt out.`;
  let result: Awaited<ReturnType<typeof sendSmsMessage>>;
  try {
    result = await sendSmsMessage(
      prepared.endpoint.normalizedDestination,
      message,
      null,
      {
        idempotencyKey: `partner-notification-code:${input.outboxEventId}:${input.generation}`,
      },
    );
  } catch {
    result = {
      ok: false,
      provider: "twilio",
      providerIdempotencySupported: false,
      deliveryCertainty: "uncertain",
      detail: "provider_dispatch_exception",
    };
  }
  const deliveryStatus = result.ok
    ? "accepted"
    : result.deliveryCertainty === "uncertain"
      ? "reconciliation_required"
      : "failed";
  const now = new Date();
  await db.transaction(async (tx) => {
    const [updated] = await tx
      .update(partnerNotificationEndpointChallenges)
      .set({
        deliveryStatus,
        deliveryProvider: safeProviderValue(result.provider),
        deliveryProviderMessageId: safeProviderValue(result.providerMessageId),
        deliveryDetail: result.ok
          ? null
          : (safeProviderValue(result.detail) ?? "provider_failed"),
        sentAt: result.ok ? now : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(partnerNotificationEndpointChallenges.id, prepared.challenge.id),
          eq(
            partnerNotificationEndpointChallenges.deliveryOutboxEventId,
            input.outboxEventId,
          ),
          eq(
            partnerNotificationEndpointChallenges.deliveryAttemptId,
            attemptId,
          ),
          eq(
            partnerNotificationEndpointChallenges.deliveryStatus,
            "dispatching",
          ),
        ),
      )
      .returning({ id: partnerNotificationEndpointChallenges.id });
    if (!updated) throw new Error("partner_sms_delivery_result_not_persisted");
    await tx.insert(auditLogs).values({
      id: randomUUID(),
      actorType: "system",
      actorId: prepared.challenge.partnerUserId,
      actorLabel: "partner-notification-endpoint-worker",
      authMethod: "service",
      correlationId: input.correlationId,
      outcome: result.ok
        ? "succeeded"
        : deliveryStatus === "reconciliation_required"
          ? "attempted"
          : "failed",
      surface: "partner_portal_v2",
      action: result.ok
        ? "partner.notification_endpoint.verification_code_sent"
        : "partner.notification_endpoint.verification_code_delivery_failed",
      entityType: "partner_notification_endpoint_challenge",
      entityId: prepared.challenge.id,
      meta: {
        accountId: prepared.challenge.partnerAccountId,
        membershipId: prepared.challenge.membershipId,
        endpointId: prepared.endpoint.id,
        generation: input.generation,
        deliveryStatus,
        provider: safeProviderValue(result.provider),
      },
      createdAt: now,
    });
  });
  return { status: "processed" };
}
