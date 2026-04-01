import crypto from "node:crypto";

type NormalizeMemberIdInput = string | null | undefined;

function timingSafeEqualString(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

export function normalizeSoldByMemberId(
  value: NormalizeMemberIdInput,
): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function resolveSoldByBaseline(input: {
  currentSoldByMemberId?: NormalizeMemberIdInput;
  assignedSalespersonMemberId?: NormalizeMemberIdInput;
}): string | null {
  return (
    normalizeSoldByMemberId(input.currentSoldByMemberId) ??
    normalizeSoldByMemberId(input.assignedSalespersonMemberId)
  );
}

export function soldByChangeRequiresOverride(input: {
  nextSoldByMemberId?: NormalizeMemberIdInput;
  currentSoldByMemberId?: NormalizeMemberIdInput;
  assignedSalespersonMemberId?: NormalizeMemberIdInput;
}): boolean {
  const next = normalizeSoldByMemberId(input.nextSoldByMemberId);
  const baseline = resolveSoldByBaseline(input);
  if (!next || !baseline) return false;
  return next !== baseline;
}

export function isValidSoldByOverrideCode(
  providedCode: string | null | undefined,
): boolean {
  const expected = process.env["SOLD_BY_OVERRIDE_CODE"]?.trim() ?? "";
  const provided =
    typeof providedCode === "string" ? providedCode.trim() : "";
  if (!expected || !provided) return false;
  return timingSafeEqualString(provided, expected);
}
