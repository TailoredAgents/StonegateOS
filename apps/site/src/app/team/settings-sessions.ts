export type PersonalSessionSummary = {
  current: boolean;
  authMethod: "team_session" | "break_glass";
  assuranceLevel: "aal1" | "aal2";
  mfaVerifiedAt: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  status: "active" | "expired" | "revoked";
};

export type PersonalSessionInventory = {
  version: string;
  total: number;
  limit: number;
  truncated: boolean;
  activeOtherCount: number;
  sessions: PersonalSessionSummary[];
};

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) {
    return false;
  }
  const timestamp = Date.parse(value);
  return (
    !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value
  );
}

function parseSession(value: unknown): PersonalSessionSummary | null {
  if (!value || typeof value !== "object") return null;
  const session = value as Record<string, unknown>;
  if (
    typeof session["current"] !== "boolean" ||
    (session["authMethod"] !== "team_session" &&
      session["authMethod"] !== "break_glass") ||
    (session["assuranceLevel"] !== "aal1" &&
      session["assuranceLevel"] !== "aal2") ||
    (session["mfaVerifiedAt"] !== null &&
      !isIsoDate(session["mfaVerifiedAt"])) ||
    !isIsoDate(session["createdAt"]) ||
    !isIsoDate(session["lastSeenAt"]) ||
    !isIsoDate(session["expiresAt"]) ||
    (session["revokedAt"] !== null && !isIsoDate(session["revokedAt"])) ||
    !["active", "expired", "revoked"].includes(String(session["status"]))
  ) {
    return null;
  }
  const parsed = session as PersonalSessionSummary;
  if (
    (parsed.assuranceLevel === "aal2") !== (parsed.mfaVerifiedAt !== null) ||
    (parsed.authMethod === "break_glass" && parsed.assuranceLevel !== "aal1") ||
    (parsed.status === "revoked") !== (parsed.revokedAt !== null) ||
    (parsed.status !== "revoked" && parsed.revokedAt !== null)
  ) {
    return null;
  }
  return parsed;
}

export function parsePersonalSessionInventory(
  value: unknown,
): PersonalSessionInventory | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  if (
    payload["ok"] !== true ||
    typeof payload["version"] !== "string" ||
    !/^[a-f0-9]{64}$/u.test(payload["version"]) ||
    !Number.isInteger(payload["total"]) ||
    Number(payload["total"]) < 1 ||
    !Number.isInteger(payload["limit"]) ||
    Number(payload["limit"]) < 1 ||
    typeof payload["truncated"] !== "boolean" ||
    !Number.isInteger(payload["activeOtherCount"]) ||
    Number(payload["activeOtherCount"]) < 0 ||
    !Array.isArray(payload["sessions"])
  ) {
    return null;
  }

  const sessions = payload["sessions"].map(parseSession);
  const current = sessions.find((session) => session?.current);
  const visibleActiveOtherCount = sessions.filter(
    (session) => session && !session.current && session.status === "active",
  ).length;
  const total = Number(payload["total"]);
  const truncated = payload["truncated"];
  const activeOtherCount = Number(payload["activeOtherCount"]);
  if (
    sessions.some((session) => session === null) ||
    sessions.filter((session) => session?.current).length !== 1 ||
    !current ||
    current.status !== "active" ||
    total < sessions.length ||
    Number(payload["limit"]) < sessions.length ||
    activeOtherCount > total - 1 ||
    (truncated
      ? total <= sessions.length || visibleActiveOtherCount > activeOtherCount
      : total !== sessions.length ||
        visibleActiveOtherCount !== activeOtherCount)
  ) {
    return null;
  }

  return {
    version: payload["version"],
    total,
    limit: Number(payload["limit"]),
    truncated,
    activeOtherCount,
    sessions: sessions as PersonalSessionSummary[],
  };
}
