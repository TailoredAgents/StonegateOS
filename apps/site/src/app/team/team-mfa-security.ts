export type TeamMfaSecurityStatus = {
  required: boolean;
  enrolled: boolean;
  assuranceLevel: "aal1" | "aal2";
  recentlyVerified: boolean;
  mfaVerifiedAt: string | null;
  recentVerificationExpiresAt: string | null;
  configurationAllowed: boolean;
  recentMfaMaximumAgeSeconds: number;
  methods: Array<{
    id: string;
    type: "totp";
    label: string | null;
    enrolledAt: string;
    lastUsedAt: string | null;
    recoveryCodesRemaining: number;
  }>;
};

function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

export function parseTeamMfaSecurityStatus(
  value: unknown,
): TeamMfaSecurityStatus | null {
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  const security = payload["security"] as Record<string, unknown> | undefined;
  if (
    payload["ok"] !== true ||
    !security ||
    typeof security["required"] !== "boolean" ||
    typeof security["enrolled"] !== "boolean" ||
    (security["assuranceLevel"] !== "aal1" &&
      security["assuranceLevel"] !== "aal2") ||
    typeof security["recentlyVerified"] !== "boolean" ||
    (security["mfaVerifiedAt"] !== null &&
      !isIsoDate(security["mfaVerifiedAt"])) ||
    (security["recentVerificationExpiresAt"] !== null &&
      !isIsoDate(security["recentVerificationExpiresAt"])) ||
    typeof security["configurationAllowed"] !== "boolean" ||
    security["recentMfaMaximumAgeSeconds"] !== 900 ||
    !Array.isArray(security["methods"])
  ) {
    return null;
  }
  const methods = security["methods"].map((entry) => {
    if (!entry || typeof entry !== "object") return null;
    const method = entry as Record<string, unknown>;
    const id = method["id"];
    const label = method["label"];
    const enrolledAt = method["enrolledAt"];
    const lastUsedAt = method["lastUsedAt"];
    const recoveryCodesRemaining = method["recoveryCodesRemaining"];
    if (
      typeof id !== "string" ||
      method["type"] !== "totp" ||
      (label !== null && typeof label !== "string") ||
      !isIsoDate(enrolledAt) ||
      (lastUsedAt !== null && !isIsoDate(lastUsedAt)) ||
      typeof recoveryCodesRemaining !== "number" ||
      !Number.isInteger(recoveryCodesRemaining) ||
      recoveryCodesRemaining < 0
    ) {
      return null;
    }
    return {
      id,
      type: "totp" as const,
      label,
      enrolledAt,
      lastUsedAt,
      recoveryCodesRemaining,
    };
  });
  const parsedMethods = methods.filter(
    (method): method is NonNullable<typeof method> => method !== null,
  );
  if (
    parsedMethods.length !== methods.length ||
    security["enrolled"] !== parsedMethods.length > 0 ||
    (security["assuranceLevel"] === "aal2") !==
      (security["mfaVerifiedAt"] !== null)
  ) {
    return null;
  }
  return {
    required: security["required"],
    enrolled: security["enrolled"],
    assuranceLevel: security["assuranceLevel"],
    recentlyVerified: security["recentlyVerified"],
    mfaVerifiedAt: security["mfaVerifiedAt"],
    recentVerificationExpiresAt: security["recentVerificationExpiresAt"],
    configurationAllowed: security["configurationAllowed"],
    recentMfaMaximumAgeSeconds: 900,
    methods: parsedMethods,
  };
}
