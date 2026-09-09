import assert from "node:assert/strict";
import test from "node:test";
import {
  recurringOccurrenceNeedsAttention,
  recurringOccurrenceStatus,
} from "./recurring-occurrence-status";

void test("recurring dates reflect linked job changes without rewriting evaluator outcome", () => {
  const review = { state: "review", currentJobStatus: "confirmed" };
  assert.equal(recurringOccurrenceStatus(review), "confirmed");
  assert.equal(review.state, "review");
  assert.equal(recurringOccurrenceNeedsAttention(review), false);
  for (const currentJobStatus of ["completed", "canceled", "declined"])
    assert.equal(
      recurringOccurrenceStatus({ state: "confirmed", currentJobStatus }),
      currentJobStatus,
    );
  assert.equal(
    recurringOccurrenceNeedsAttention({
      state: "confirmed",
      currentJobStatus: "approval_needed",
    }),
    true,
  );
  assert.equal(
    recurringOccurrenceNeedsAttention({
      state: "failed",
      currentJobStatus: null,
    }),
    true,
  );
  assert.equal(
    recurringOccurrenceStatus({ state: "tentative", currentJobStatus: null }),
    "tentative",
  );
});
