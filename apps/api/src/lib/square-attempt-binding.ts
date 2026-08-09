import { createHash } from "node:crypto";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type SquareAttemptLaunchBinding = {
  platform: "ios" | "android";
  amountCents: number;
  appointmentId: string;
  attemptId: string;
  expiresAt: string;
  appointmentVersion: string;
  clientRequestId: string;
  memberId: string;
  sessionId: string;
  authMethod: "team_session" | "break_glass";
};

function isCanonicalIsoDate(value: string): boolean {
  return (
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function isSquareAttemptLaunchBinding(
  value: unknown,
): value is SquareAttemptLaunchBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const exactKeys = [
    "amountCents",
    "appointmentId",
    "appointmentVersion",
    "attemptId",
    "authMethod",
    "clientRequestId",
    "expiresAt",
    "memberId",
    "platform",
    "sessionId",
  ];
  if (
    Object.keys(record).length !== exactKeys.length ||
    !exactKeys.every((key) => Object.hasOwn(record, key))
  ) {
    return false;
  }
  return (
    (record["platform"] === "ios" || record["platform"] === "android") &&
    typeof record["amountCents"] === "number" &&
    Number.isSafeInteger(record["amountCents"]) &&
    record["amountCents"] > 0 &&
    record["amountCents"] <= 2_147_483_647 &&
    typeof record["appointmentId"] === "string" &&
    UUID_PATTERN.test(record["appointmentId"]) &&
    typeof record["attemptId"] === "string" &&
    UUID_PATTERN.test(record["attemptId"]) &&
    typeof record["clientRequestId"] === "string" &&
    UUID_PATTERN.test(record["clientRequestId"]) &&
    typeof record["memberId"] === "string" &&
    UUID_PATTERN.test(record["memberId"]) &&
    typeof record["sessionId"] === "string" &&
    UUID_PATTERN.test(record["sessionId"]) &&
    (record["authMethod"] === "team_session" ||
      record["authMethod"] === "break_glass") &&
    typeof record["expiresAt"] === "string" &&
    isCanonicalIsoDate(record["expiresAt"]) &&
    typeof record["appointmentVersion"] === "string" &&
    isCanonicalIsoDate(record["appointmentVersion"])
  );
}

export function hashSquareAttemptLaunchBinding(
  binding: SquareAttemptLaunchBinding,
): string {
  if (!isSquareAttemptLaunchBinding(binding)) {
    throw new Error("invalid_square_attempt_launch_binding");
  }
  return createHash("sha256")
    .update(
      JSON.stringify({
        amountCents: binding.amountCents,
        appointmentId: binding.appointmentId,
        appointmentVersion: binding.appointmentVersion,
        attemptId: binding.attemptId,
        authMethod: binding.authMethod,
        clientRequestId: binding.clientRequestId,
        expiresAt: binding.expiresAt,
        memberId: binding.memberId,
        platform: binding.platform,
        sessionId: binding.sessionId,
      }),
      "utf8",
    )
    .digest("hex");
}
