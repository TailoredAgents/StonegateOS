const SAFE_ERROR_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u;
const SAFE_ERROR_CODE = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;

function readProperty(value: unknown, property: string): unknown {
  if ((typeof value !== "object" && typeof value !== "function") || !value) {
    return undefined;
  }
  try {
    return (value as Record<string, unknown>)[property];
  } catch {
    return undefined;
  }
}

function safeName(value: unknown): string | null {
  const name = readProperty(value, "name");
  return typeof name === "string" && SAFE_ERROR_NAME.test(name) ? name : null;
}

function safeCode(value: unknown): string | null {
  const code = readProperty(value, "code");
  return typeof code === "string" && SAFE_ERROR_CODE.test(code) ? code : null;
}

/**
 * Return only low-cardinality diagnostics that are safe for authentication
 * logs. In particular, never expose Error.message, SQL, bound parameters,
 * provider responses, or arbitrary properties supplied by a thrown value.
 */
export function describeTeamAuthInfrastructureError(error: unknown): {
  errorName: string;
  errorCode: string | null;
  causeName: string | null;
  causeCode: string | null;
} {
  const cause = readProperty(error, "cause");
  return {
    errorName: safeName(error) ?? "UnknownError",
    errorCode: safeCode(error),
    causeName: safeName(cause),
    causeCode: safeCode(cause),
  };
}
