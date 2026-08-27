import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  expenseCategories,
  expenseVendorCategoryRules,
  getDb,
} from "@/db";
import { normalizeReceiptVendor } from "@/lib/expense-receipt-domain";
import { requirePermission } from "@/lib/permissions";
import {
  claimTeamMutationIdempotency,
  completeTeamMutationIdempotency,
  settleTeamMutationIdempotencyFailure,
  type TeamMutationIdempotencyClaim,
  teamMutationIdempotencyReplayResponse,
} from "@/lib/team-mutation-idempotency";
import {
  beginTeamMutation,
  TeamMutationFailure,
  teamMutationExceptionResponse,
  teamMutationResultResponse,
  teamMutationSuccessResult,
} from "@/lib/team-mutation";

export const dynamic = "force-dynamic";

const VendorRuleInputSchema = z
  .object({
    vendor: z.string().trim().min(2).max(240),
    categoryId: z.string().trim().regex(/^[a-z][a-z0-9_]{1,63}$/u),
    ownerLocked: z.boolean(),
  })
  .strict();

export async function GET(request: NextRequest): Promise<Response> {
  const permissionError = await requirePermission(request, "expenses.approve");
  if (permissionError) return permissionError;

  const rows = await getDb()
    .select({
      id: expenseVendorCategoryRules.id,
      normalizedVendor: expenseVendorCategoryRules.normalizedVendor,
      categoryId: expenseVendorCategoryRules.categoryId,
      category: expenseCategories.name,
      confirmationCount: expenseVendorCategoryRules.confirmationCount,
      disagreementCount: expenseVendorCategoryRules.disagreementCount,
      ownerLocked: expenseVendorCategoryRules.ownerLocked,
      lockedBy: expenseVendorCategoryRules.lockedBy,
      lockedAt: expenseVendorCategoryRules.lockedAt,
      updatedAt: expenseVendorCategoryRules.updatedAt,
    })
    .from(expenseVendorCategoryRules)
    .innerJoin(
      expenseCategories,
      eq(expenseVendorCategoryRules.categoryId, expenseCategories.id),
    )
    .orderBy(
      sql`${expenseVendorCategoryRules.ownerLocked} desc`,
      asc(expenseVendorCategoryRules.normalizedVendor),
      asc(expenseCategories.sortOrder),
    )
    .limit(500);

  return NextResponse.json(
    {
      ok: true,
      rules: rows.map((row) => ({
        ...row,
        lockedAt: row.lockedAt?.toISOString() ?? null,
        updatedAt: row.updatedAt.toISOString(),
      })),
    },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function PUT(request: NextRequest): Promise<Response> {
  const boundary = await beginTeamMutation(request, {
    principalTypes: ["human"],
    requiredPermissions: ["expenses.approve"],
    risk: "financial",
    requiresIdempotency: true,
    auditAction: "expense.vendor_rule.updated",
  });
  if (!boundary.ok) return boundary.response;
  const { mutation } = boundary;

  let db: ReturnType<typeof getDb> | null = null;
  let claim: TeamMutationIdempotencyClaim | null = null;
  try {
    const parsed = VendorRuleInputSchema.safeParse(
      await request.json().catch(() => null),
    );
    if (!parsed.success) {
      throw new TeamMutationFailure(
        "invalid",
        "Choose a vendor, category, and lock setting.",
        {
          fieldErrors: Object.fromEntries(
            parsed.error.issues.map((issue) => [
              String(issue.path[0] ?? "request"),
              issue.message,
            ]),
          ),
        },
      );
    }
    const normalizedVendor = normalizeReceiptVendor(parsed.data.vendor);
    if (!normalizedVendor) {
      throw new TeamMutationFailure("invalid", "Enter a valid vendor name.");
    }
    const actorId = mutation.actor.id;
    if (!actorId) {
      throw new TeamMutationFailure(
        "internal",
        "The verified rule owner is incomplete.",
      );
    }

    db = getDb();
    const claimed = await claimTeamMutationIdempotency(db, mutation, {
      route: "PUT /api/admin/expenses/vendor-rules",
      entityType: "expense_vendor_category_rule",
      entityId: normalizedVendor,
      payload: { ...parsed.data, normalizedVendor },
    });
    if (claimed.kind === "replay") {
      return teamMutationIdempotencyReplayResponse(claimed.replay);
    }
    claim = claimed.claim;

    const result = await db.transaction(async (tx) => {
      const [category] = await tx
        .select({ id: expenseCategories.id, name: expenseCategories.name })
        .from(expenseCategories)
        .where(
          and(
            eq(expenseCategories.id, parsed.data.categoryId),
            eq(expenseCategories.isActive, true),
          ),
        )
        .limit(1);
      if (!category) {
        throw new TeamMutationFailure(
          "invalid",
          "The selected category is unavailable.",
          { fieldErrors: { categoryId: "Choose an active category." } },
        );
      }

      const now = new Date();
      await tx
        .update(expenseVendorCategoryRules)
        .set({
          ownerLocked: false,
          lockedBy: null,
          lockedAt: null,
          updatedAt: now,
        })
        .where(
          eq(
            expenseVendorCategoryRules.normalizedVendor,
            normalizedVendor,
          ),
        );

      const [rule] = await tx
        .insert(expenseVendorCategoryRules)
        .values({
          normalizedVendor,
          categoryId: category.id,
          confirmationCount: 0,
          disagreementCount: 0,
          ownerLocked: parsed.data.ownerLocked,
          lockedBy: parsed.data.ownerLocked ? actorId : null,
          lockedAt: parsed.data.ownerLocked ? now : null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: [
            expenseVendorCategoryRules.normalizedVendor,
            expenseVendorCategoryRules.categoryId,
          ],
          set: {
            ownerLocked: parsed.data.ownerLocked,
            lockedBy: parsed.data.ownerLocked ? actorId : null,
            lockedAt: parsed.data.ownerLocked ? now : null,
            updatedAt: now,
          },
        })
        .returning({ id: expenseVendorCategoryRules.id });
      if (!rule) {
        throw new TeamMutationFailure(
          "internal",
          "The vendor rule could not be saved.",
          { retryable: true },
        );
      }

      const audit = await mutation.audit.insertSuccess(tx, {
        entityType: "expense_vendor_category_rule",
        entityId: rule.id,
        after: {
          normalizedVendor,
          categoryId: category.id,
          ownerLocked: parsed.data.ownerLocked,
        },
        metadata: { category: category.name },
        committedAt: now,
      });
      const mutationResult = teamMutationSuccessResult(
        mutation,
        {
          id: rule.id,
          normalizedVendor,
          categoryId: category.id,
          category: category.name,
          ownerLocked: parsed.data.ownerLocked,
        },
        {
          auditEventId: audit.auditEventId,
          committedAt: audit.committedAt,
          entityType: "expense_vendor_category_rule",
          entityId: rule.id,
        },
      );
      await completeTeamMutationIdempotency(
        tx,
        mutation,
        claimed.claim,
        mutationResult,
        200,
      );
      return mutationResult;
    });
    return teamMutationResultResponse(result, 200, mutation.correlationId);
  } catch (error) {
    if (db && claim) {
      try {
        await settleTeamMutationIdempotencyFailure(db, mutation, claim, error);
      } catch (settlementError) {
        console.error("[expenses] vendor_rule_idempotency_settlement_failed", {
          operationId: mutation.operationId,
          correlationId: mutation.correlationId,
          errorName:
            settlementError instanceof Error
              ? settlementError.name
              : "UnknownError",
        });
      }
    }
    return teamMutationExceptionResponse(error, mutation);
  }
}
