-- Permit immutable linked correction/void workflows for V2 expenses while
-- keeping reimbursement and payout evidence coherent.

CREATE OR REPLACE FUNCTION enforce_expense_v2_evidence_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."submitted_by" IS NOT NULL OR OLD."receipt_capture_id" IS NOT NULL THEN
      RAISE EXCEPTION 'expense v2 ledger entries cannot be deleted'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."lifecycle_status" <> 'draft' AND (
    NEW."category_id" IS DISTINCT FROM OLD."category_id"
    OR NEW."category_needs_review" IS DISTINCT FROM OLD."category_needs_review"
    OR NEW."submitted_by" IS DISTINCT FROM OLD."submitted_by"
    OR NEW."payer_type" IS DISTINCT FROM OLD."payer_type"
    OR NEW."paid_by_member_id" IS DISTINCT FROM OLD."paid_by_member_id"
    OR NEW."review_status" IS DISTINCT FROM OLD."review_status"
    OR NEW."reviewed_by" IS DISTINCT FROM OLD."reviewed_by"
    OR NEW."reviewed_at" IS DISTINCT FROM OLD."reviewed_at"
    OR NEW."review_reason" IS DISTINCT FROM OLD."review_reason"
    OR NEW."receipt_capture_id" IS DISTINCT FROM OLD."receipt_capture_id"
    OR NEW."appointment_id" IS DISTINCT FROM OLD."appointment_id"
  ) THEN
    RAISE EXCEPTION 'posted expense v2 evidence is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."lifecycle_status" IS DISTINCT FROM OLD."lifecycle_status"
     AND NEW."lifecycle_status" IN ('voided', 'corrected')
     AND EXISTS (
       SELECT 1
       FROM "expense_reimbursement_claims" AS claim
       WHERE claim."expense_id" = OLD."id"
         AND claim."status" <> 'rejected'::"expense_reimbursement_status"
     ) THEN
    RAISE EXCEPTION 'active reimbursements require the linked correction workflow'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE FUNCTION enforce_reimbursement_claim_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  financial_correction boolean;
  correction_is_valid boolean;
  attached_run_is_draft boolean;
  adjustment_is_current boolean;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reimbursement claims cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'reimbursement claim version must increase by exactly one'
      USING ERRCODE = '40001';
  END IF;
  IF NEW."member_id" IS DISTINCT FROM OLD."member_id" THEN
    RAISE EXCEPTION 'reimbursement payer is immutable'
      USING ERRCODE = '55000';
  END IF;

  financial_correction :=
    NEW."expense_id" IS DISTINCT FROM OLD."expense_id"
    OR NEW."amount_cents" IS DISTINCT FROM OLD."amount_cents";

  IF financial_correction THEN
    SELECT EXISTS (
      SELECT 1
      FROM "expenses" AS replacement
      JOIN "expenses" AS original
        ON original."id" = replacement."correction_of_expense_id"
      WHERE replacement."id" = NEW."expense_id"
        AND original."id" = OLD."expense_id"
        AND original."lifecycle_status" = 'posted'::"expense_lifecycle_status"
        AND replacement."lifecycle_status" = 'posted'::"expense_lifecycle_status"
        AND replacement."source" = 'manual_correction'
        AND replacement."payer_type" = 'personal'::"expense_payer_type"
        AND replacement."paid_by_member_id" = NEW."member_id"
        AND replacement."amount_cents" = NEW."amount_cents"
        AND NEW."status" = OLD."status"
        AND OLD."status" IN (
          'approved'::"expense_reimbursement_status",
          'attached'::"expense_reimbursement_status"
        )
    ) INTO correction_is_valid;
    IF NOT correction_is_valid THEN
      RAISE EXCEPTION 'reimbursement financial evidence may only follow a linked expense correction'
        USING ERRCODE = '55000';
    END IF;

    IF OLD."status" = 'attached'::"expense_reimbursement_status" THEN
      IF NEW."payout_run_id" IS DISTINCT FROM OLD."payout_run_id"
         OR NEW."payout_adjustment_id" IS DISTINCT FROM OLD."payout_adjustment_id"
         OR NEW."attached_at" IS DISTINCT FROM OLD."attached_at" THEN
        RAISE EXCEPTION 'attached reimbursement identity is immutable during correction'
          USING ERRCODE = '55000';
      END IF;
      SELECT EXISTS (
        SELECT 1
        FROM "payout_runs" AS run
        WHERE run."id" = OLD."payout_run_id"
          AND run."status" = 'draft'::"payout_run_status"
      ) INTO attached_run_is_draft;
      SELECT EXISTS (
        SELECT 1
        FROM "payout_run_adjustments" AS adjustment
        WHERE adjustment."id" = OLD."payout_adjustment_id"
          AND adjustment."payout_run_id" = OLD."payout_run_id"
          AND adjustment."kind" = 'reimbursement'
          AND adjustment."expense_id" = NEW."expense_id"
          AND adjustment."amount_cents" = NEW."amount_cents"
      ) INTO adjustment_is_current;
      IF NOT attached_run_is_draft OR NOT adjustment_is_current THEN
        RAISE EXCEPTION 'attached reimbursement correction requires its editable payout adjustment'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  END IF;

  IF NOT (
    (financial_correction AND NEW."status" = OLD."status")
    OR (OLD."status" = 'pending' AND NEW."status" IN ('approved', 'rejected'))
    OR (OLD."status" = 'approved' AND NEW."status" IN ('attached', 'rejected'))
    OR (OLD."status" = 'attached' AND NEW."status" = 'paid')
    OR (
      OLD."status" = 'attached'
      AND NEW."status" = 'rejected'
      AND NEW."payout_run_id" IS NULL
      AND NEW."payout_adjustment_id" IS NULL
      AND NEW."attached_at" IS NULL
      AND NEW."paid_at" IS NULL
      AND EXISTS (
        SELECT 1
        FROM "payout_runs" AS run
        WHERE run."id" = OLD."payout_run_id"
          AND run."status" = 'draft'::"payout_run_status"
      )
    )
  ) THEN
    RAISE EXCEPTION 'invalid reimbursement claim transition'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
