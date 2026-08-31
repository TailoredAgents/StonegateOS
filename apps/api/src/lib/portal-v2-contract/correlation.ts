import { randomUUID } from "node:crypto";

export const PORTAL_V2_CORRELATION_ID_HEADER = "x-correlation-id";
export const PORTAL_V2_CORRELATION_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

export function isPortalV2CorrelationId(value: unknown): value is string {
  return (
    typeof value === "string" && PORTAL_V2_CORRELATION_ID_PATTERN.test(value)
  );
}

/**
 * Reuses a bounded caller correlation ID when it is safe, otherwise creates a
 * server-owned ID. Invalid caller values are never reflected in a response.
 */
export function resolvePortalV2CorrelationId(
  rawValue: string | null | undefined,
  generate: () => string = randomUUID,
): string {
  const candidate = rawValue?.trim() ?? "";
  if (isPortalV2CorrelationId(candidate)) return candidate;

  const generated = generate();
  if (!isPortalV2CorrelationId(generated)) {
    throw new TypeError("The correlation ID generator returned an invalid ID.");
  }
  return generated;
}

export function readPortalV2CorrelationId(
  headers: Pick<Headers, "get">,
  generate: () => string = randomUUID,
): string {
  return resolvePortalV2CorrelationId(
    headers.get(PORTAL_V2_CORRELATION_ID_HEADER),
    generate,
  );
}
