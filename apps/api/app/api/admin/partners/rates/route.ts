import type { MutationResult } from "@myst-os/sdk";
import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { contacts, getDb, partnerRateCards, partnerRateItems } from "@/db";
import { requirePermission } from "@/lib/permissions";
import { readBoundedPartnerJson } from "@/lib/partner-operations";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  assertTeamMutationExpectedVersion,
  beginTeamMutation,
  recordTeamMutationFailure,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationExceptionResult,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";
import {
  isPartnerAllowedServiceKey,
  isPartnerTierKeyForService,
} from "@myst-os/pricing";
import { isAdminRequest } from "../../../web/admin";

const MAX_RATE_REQUEST_BYTES = 64 * 1024;
const MAX_RATE_ITEMS = 100;
const MAX_RATE_AMOUNT_CENTS = 10_000_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type PartnerRateInputItem = {
  serviceKey: string;
  tierKey: string;
  label: string | null;
  amountCents: number;
  sortOrder: number;
};

type PartnerRateInput = {
  orgContactId: string;
  currency: "USD";
  items: PartnerRateInputItem[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length && expected.every((key) => key in value)
  );
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

export function parsePartnerRateMutationPayload(
  value: unknown,
): PartnerRateInput {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["confirmation", "currency", "items", "orgContactId"])
  ) {
    throw new TeamMutationFailure(
      "invalid",
      "Send one complete partner-rate request.",
      { fieldErrors: { request: "The rate request is incomplete." } },
    );
  }
  const orgContactId =
    typeof value["orgContactId"] === "string"
      ? value["orgContactId"].trim().toLowerCase()
      : "";
  if (!UUID_PATTERN.test(orgContactId)) {
    throw new TeamMutationFailure("invalid", "Choose a valid partner.", {
      fieldErrors: { orgContactId: "Refresh the partner workspace." },
    });
  }
  if (value["currency"] !== "USD") {
    throw new TeamMutationFailure(
      "invalid",
      "Partner rates currently support USD only.",
      { fieldErrors: { currency: "Use USD." } },
    );
  }
  if (
    !Array.isArray(value["items"]) ||
    value["items"].length < 1 ||
    value["items"].length > MAX_RATE_ITEMS
  ) {
    throw new TeamMutationFailure(
      "invalid",
      `Enter between 1 and ${MAX_RATE_ITEMS} complete rate tiers.`,
      {
        fieldErrors: {
          items: `Use 1–${MAX_RATE_ITEMS} complete rate tiers.`,
        },
      },
    );
  }

  const items: PartnerRateInputItem[] = [];
  const identities = new Set<string>();
  for (const [index, raw] of value["items"].entries()) {
    if (
      !isRecord(raw) ||
      !hasExactKeys(raw, [
        "amountCents",
        "label",
        "serviceKey",
        "sortOrder",
        "tierKey",
      ])
    ) {
      throw new TeamMutationFailure(
        "invalid",
        `Rate row ${index + 1} is incomplete.`,
        { fieldErrors: { items: `Correct rate row ${index + 1}.` } },
      );
    }
    const serviceKey =
      typeof raw["serviceKey"] === "string"
        ? raw["serviceKey"].trim().toLowerCase()
        : "";
    const tierKey =
      typeof raw["tierKey"] === "string" ? raw["tierKey"].trim() : "";
    const label =
      raw["label"] === null
        ? null
        : typeof raw["label"] === "string"
          ? raw["label"].normalize("NFKC").trim()
          : "";
    const amountCents = raw["amountCents"];
    const sortOrder = raw["sortOrder"];
    if (
      !isPartnerAllowedServiceKey(serviceKey) ||
      !tierKey ||
      tierKey.length > 100 ||
      !isPartnerTierKeyForService(serviceKey, tierKey) ||
      (label !== null &&
        (label.length < 1 ||
          label.length > 120 ||
          containsControlCharacter(label))) ||
      typeof amountCents !== "number" ||
      !Number.isSafeInteger(amountCents) ||
      amountCents < 1 ||
      amountCents > MAX_RATE_AMOUNT_CENTS ||
      typeof sortOrder !== "number" ||
      !Number.isSafeInteger(sortOrder) ||
      sortOrder !== index
    ) {
      throw new TeamMutationFailure(
        "invalid",
        `Rate row ${index + 1} contains an invalid service, tier, label, amount, or order.`,
        { fieldErrors: { items: `Correct rate row ${index + 1}.` } },
      );
    }
    const identity = `${serviceKey}:${tierKey}`;
    if (identities.has(identity)) {
      throw new TeamMutationFailure(
        "invalid",
        `Rate row ${index + 1} duplicates ${serviceKey}/${tierKey}.`,
        { fieldErrors: { items: "Each service and tier may appear once." } },
      );
    }
    identities.add(identity);
    items.push({ serviceKey, tierKey, label, amountCents, sortOrder });
  }

  if (value["confirmation"] !== `SAVE ${items.length} PARTNER RATES`) {
    throw new TeamMutationFailure(
      "invalid",
      `Confirm the replacement of all negotiated rates with these ${items.length} tiers.`,
      {
        fieldErrors: {
          confirmation: `Use SAVE ${items.length} PARTNER RATES.`,
        },
      },
    );
  }
  return { orgContactId, currency: "USD", items };
}

function invalidFilter(field: string, message: string): NextResponse {
  return NextResponse.json(
    { ok: false, error: "invalid_filter", field, message },
    { status: 422, headers: { "Cache-Control": "private, no-store" } },
  );
}

function parseRateLookup(params: URLSearchParams): string | null {
  if (
    Array.from(params.keys()).some((key) => key !== "orgContactId") ||
    params.getAll("orgContactId").length !== 1
  ) {
    return null;
  }
  const value = params.get("orgContactId")?.trim().toLowerCase() ?? "";
  return UUID_PATTERN.test(value) ? value : null;
}

export async function GET(request: NextRequest): Promise<Response> {
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const permissionError = await requirePermission(request, "partners.read");
  if (permissionError) return permissionError;

  const orgContactId = parseRateLookup(request.nextUrl.searchParams);
  if (!orgContactId) {
    return invalidFilter(
      "orgContactId",
      "Provide one valid partner organization ID and no other filters.",
    );
  }
  try {
    const result = await getDb().transaction(async (tx) => {
      await tx.execute(
        sql`set transaction isolation level repeatable read read only`,
      );
      const [organization] = await tx
        .select({
          id: contacts.id,
          partnerStatus: contacts.partnerStatus,
        })
        .from(contacts)
        .where(and(eq(contacts.id, orgContactId), isNull(contacts.deletedAt)))
        .limit(1);
      if (!organization) return { kind: "missing" as const };
      if (organization.partnerStatus !== "partner") {
        return { kind: "not_partner" as const };
      }

      const [card] = await tx
        .select({
          id: partnerRateCards.id,
          currency: partnerRateCards.currency,
          active: partnerRateCards.active,
          updatedAt: partnerRateCards.updatedAt,
        })
        .from(partnerRateCards)
        .where(eq(partnerRateCards.orgContactId, orgContactId))
        .limit(1);
      if (!card) {
        return {
          kind: "rates" as const,
          version: "none" as const,
          currency: "USD",
          active: false,
          items: [],
        };
      }
      const items = await tx
        .select({
          id: partnerRateItems.id,
          serviceKey: partnerRateItems.serviceKey,
          tierKey: partnerRateItems.tierKey,
          label: partnerRateItems.label,
          amountCents: partnerRateItems.amountCents,
          sortOrder: partnerRateItems.sortOrder,
          createdAt: partnerRateItems.createdAt,
        })
        .from(partnerRateItems)
        .where(eq(partnerRateItems.rateCardId, card.id))
        .orderBy(
          asc(partnerRateItems.serviceKey),
          asc(partnerRateItems.sortOrder),
          asc(partnerRateItems.tierKey),
          asc(partnerRateItems.id),
        );
      return {
        kind: "rates" as const,
        version: card.updatedAt.toISOString(),
        currency: card.currency,
        active: card.active,
        items,
      };
    });
    if (result.kind === "missing") {
      return NextResponse.json(
        { ok: false, error: "partner_not_found" },
        { status: 404, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    if (result.kind === "not_partner") {
      return NextResponse.json(
        {
          ok: false,
          error: "partner_status_required",
          message: "Negotiated rates are available only for active partners.",
        },
        { status: 409, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    return NextResponse.json(
      {
        ok: true,
        orgContactId,
        currency: result.currency,
        active: result.active,
        version: result.version,
        precedence: {
          booking: "exact_partner_service_and_tier",
          missingRate: "no_quoted_amount",
        },
        items: result.items.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
        })),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("[partners] rate_read_failed", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return NextResponse.json(
      {
        ok: false,
        error: "partner_rates_failed",
        message: "Partner rates could not be loaded. Try again.",
      },
      { status: 500, headers: { "Cache-Control": "private, no-store" } },
    );
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["partners.rates"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "partner.rates_replaced",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  if (mutation.expectedVersion === null || mutation.expectedVersion === "*") {
    const error = new TeamMutationFailure(
      "invalid",
      "The current partner-rate version is required.",
      { fieldErrors: { version: "Reload rates before saving." } },
    );
    await recordTeamMutationFailure(mutation, {
      entityType: "partner_rate_card",
      code: error.code,
      metadata: { boundary: "expected_version" },
    });
    return teamMutationExceptionResponse(error, mutation);
  }

  let input: PartnerRateInput;
  try {
    input = parsePartnerRateMutationPayload(
      await readBoundedPartnerJson(request, MAX_RATE_REQUEST_BYTES),
    );
  } catch (error) {
    const failure = teamMutationExceptionResult(error);
    await recordTeamMutationFailure(mutation, {
      entityType: "partner_rate_card",
      code: failure.result.code,
      metadata: { boundary: "input" },
    });
    return teamMutationExceptionResponse(error, mutation);
  }

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "POST /api/admin/partners/rates",
      entityType: "partner_rate_card",
      entityId: input.orgContactId,
      payload: input,
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtextextended(${`partner-rates:${input.orgContactId}`}, 0))`,
      );
      const [organization] = await tx
        .select({
          id: contacts.id,
          partnerStatus: contacts.partnerStatus,
        })
        .from(contacts)
        .where(
          and(eq(contacts.id, input.orgContactId), isNull(contacts.deletedAt)),
        )
        .for("update")
        .limit(1);
      if (!organization) {
        throw new TeamMutationFailure("invalid", "The partner was not found.", {
          status: 404,
        });
      }
      if (organization.partnerStatus !== "partner") {
        throw new TeamMutationFailure(
          "conflict",
          "Negotiated rates can be saved only for an active partner.",
        );
      }

      const [existing] = await tx
        .select({
          id: partnerRateCards.id,
          currency: partnerRateCards.currency,
          active: partnerRateCards.active,
          updatedAt: partnerRateCards.updatedAt,
        })
        .from(partnerRateCards)
        .where(eq(partnerRateCards.orgContactId, input.orgContactId))
        .for("update")
        .limit(1);
      if (existing) {
        assertTeamMutationExpectedVersion(mutation, existing.updatedAt);
      } else if (mutation.expectedVersion !== "none") {
        throw new TeamMutationFailure(
          "conflict",
          "The partner rate card changed. Reload it before saving.",
        );
      }

      const beforeItems = existing
        ? await tx
            .select({ amountCents: partnerRateItems.amountCents })
            .from(partnerRateItems)
            .where(eq(partnerRateItems.rateCardId, existing.id))
        : [];
      const now = new Date(
        Math.max(Date.now(), (existing?.updatedAt.getTime() ?? 0) + 1),
      );
      const [card] = existing
        ? await tx
            .update(partnerRateCards)
            .set({ currency: "USD", active: true, updatedAt: now })
            .where(
              and(
                eq(partnerRateCards.id, existing.id),
                eq(partnerRateCards.updatedAt, existing.updatedAt),
              ),
            )
            .returning({ id: partnerRateCards.id })
        : await tx
            .insert(partnerRateCards)
            .values({
              orgContactId: input.orgContactId,
              currency: "USD",
              active: true,
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: partnerRateCards.id });
      if (!card) {
        throw new TeamMutationFailure(
          "conflict",
          "The rate card changed while it was being saved. Reload and try again.",
          { retryable: true },
        );
      }

      await tx
        .delete(partnerRateItems)
        .where(eq(partnerRateItems.rateCardId, card.id));
      await tx.insert(partnerRateItems).values(
        input.items.map((item) => ({
          rateCardId: card.id,
          ...item,
          createdAt: now,
        })),
      );

      const beforeTotalCents = beforeItems.reduce(
        (sum, item) => sum + item.amountCents,
        0,
      );
      const afterTotalCents = input.items.reduce(
        (sum, item) => sum + item.amountCents,
        0,
      );
      const version = now.toISOString();
      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "partner_rate_card",
        entityId: card.id,
        before: {
          existed: Boolean(existing),
          currency: existing?.currency ?? null,
          active: existing?.active ?? null,
          itemCount: beforeItems.length,
          totalCents: beforeTotalCents,
          version: existing?.updatedAt.toISOString() ?? "none",
        },
        after: {
          existed: true,
          currency: "USD",
          active: true,
          itemCount: input.items.length,
          totalCents: afterTotalCents,
          version,
        },
        metadata: {
          organizationContactId: input.orgContactId,
          precedence: "exact_partner_service_and_tier",
          missingRate: "no_quoted_amount",
        },
        committedAt: now,
      });
      const response = teamMutationSuccessResult(
        mutation,
        {
          orgContactId: input.orgContactId,
          currency: "USD" as const,
          active: true,
          itemCount: input.items.length,
          totalCents: afterTotalCents,
          version,
          precedence: {
            booking: "exact_partner_service_and_tier" as const,
            missingRate: "no_quoted_amount" as const,
          },
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "partner_rate_card",
          entityId: card.id,
          version,
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        response,
        200,
        now,
      );
      return response;
    });
    return teamMutationResultResponse(
      result as MutationResult<unknown>,
      200,
      mutation.correlationId,
    );
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[partners] rate_idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    const failure = teamMutationExceptionResult(error);
    await recordTeamMutationFailure(mutation, {
      entityType: "partner_rate_card",
      entityId: input.orgContactId,
      code: failure.result.code,
      metadata: { boundary: "operation" },
    });
    return teamMutationExceptionResponse(error, mutation);
  }
}
