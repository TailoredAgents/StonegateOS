import { createHash } from "node:crypto";
import {
  createPortalV2ErrorResponse,
  type PortalV2ErrorHttpResponse,
} from "./errors";

export type PortalV2StrongEtag = `"portal-v2-${string}"`;

export type PortalV2IfMatchResult =
  | Readonly<{ ok: true; kind: "wildcard" }>
  | Readonly<{
      ok: true;
      kind: "tags";
      tags: readonly PortalV2StrongEtag[];
    }>
  | Readonly<{ ok: false; reason: "missing" | "invalid" }>;

export type PortalV2RevisionPreconditionResult =
  | Readonly<{ ok: true; currentEtag: PortalV2StrongEtag }>
  | Readonly<{
      ok: false;
      currentEtag: PortalV2StrongEtag;
      response: PortalV2ErrorHttpResponse;
    }>;

const STRONG_ETAG_PATTERN = /^"portal-v2-[A-Za-z0-9_-]{43}"$/u;
const MAX_IF_MATCH_LENGTH = 1_024;
const MAX_IF_MATCH_TAGS = 8;

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
}

/** Builds a non-reversible, quoted strong entity tag from an exact revision. */
export function createPortalV2StrongEtag(revision: string): PortalV2StrongEtag {
  if (
    typeof revision !== "string" ||
    revision.length === 0 ||
    revision.length > 2_048 ||
    hasControlCharacter(revision)
  ) {
    throw new TypeError("The portal record revision is invalid.");
  }
  const digest = createHash("sha256")
    .update("portal-v2-etag\u0000", "utf8")
    .update(revision, "utf8")
    .digest("base64url");
  return `"portal-v2-${digest}"`;
}

export function parsePortalV2IfMatch(
  rawValue: string | null | undefined,
): PortalV2IfMatchResult {
  if (rawValue === null || rawValue === undefined) {
    return Object.freeze({ ok: false, reason: "missing" });
  }
  const value = rawValue.trim();
  if (value.length === 0 || value.length > MAX_IF_MATCH_LENGTH) {
    return Object.freeze({ ok: false, reason: "invalid" });
  }
  if (value === "*") return Object.freeze({ ok: true, kind: "wildcard" });
  const values = value.split(",").map((tag) => tag.trim());
  if (
    values.length === 0 ||
    values.length > MAX_IF_MATCH_TAGS ||
    values.some((tag) => !STRONG_ETAG_PATTERN.test(tag))
  ) {
    return Object.freeze({ ok: false, reason: "invalid" });
  }
  const tags = [...new Set(values)] as PortalV2StrongEtag[];
  return Object.freeze({
    ok: true,
    kind: "tags",
    tags: Object.freeze(tags),
  });
}

export function createPortalV2RevisionMismatchResponse(
  correlationId: string,
  currentEtag: PortalV2StrongEtag,
): PortalV2ErrorHttpResponse {
  if (!STRONG_ETAG_PATTERN.test(currentEtag)) {
    throw new TypeError("The current portal ETag is invalid.");
  }
  return createPortalV2ErrorResponse("revision_mismatch", correlationId, {
    fieldErrors: {
      revision: "Refresh this item and review the latest changes.",
    },
    alternatives: [{ action: "refresh", label: "Refresh current data" }],
    additionalHeaders: { ETag: currentEtag },
  });
}

/**
 * Applies a strong If-Match precondition. Wildcards are disabled by default so
 * mutations cannot silently bypass optimistic concurrency.
 */
export function evaluatePortalV2RevisionPrecondition(input: {
  ifMatch: string | null | undefined;
  currentRevision: string;
  correlationId: string;
  allowWildcard?: boolean;
}): PortalV2RevisionPreconditionResult {
  const currentEtag = createPortalV2StrongEtag(input.currentRevision);
  const parsed = parsePortalV2IfMatch(input.ifMatch);
  if (!parsed.ok && parsed.reason === "missing") {
    return Object.freeze({
      ok: false,
      currentEtag,
      response: createPortalV2ErrorResponse(
        "if_match_required",
        input.correlationId,
        {
          fieldErrors: {
            revision: "Refresh this item before submitting changes.",
          },
          alternatives: [{ action: "refresh", label: "Refresh current data" }],
          additionalHeaders: { ETag: currentEtag },
        },
      ),
    });
  }
  if (
    !parsed.ok ||
    (parsed.kind === "wildcard" && input.allowWildcard !== true)
  ) {
    return Object.freeze({
      ok: false,
      currentEtag,
      response: createPortalV2ErrorResponse(
        "invalid_if_match",
        input.correlationId,
        {
          fieldErrors: {
            revision: "Use the latest strong ETag for this item.",
          },
          alternatives: [{ action: "refresh", label: "Refresh current data" }],
          additionalHeaders: { ETag: currentEtag },
        },
      ),
    });
  }
  if (
    parsed.kind === "wildcard" ||
    parsed.tags.some((tag) => tag === currentEtag)
  ) {
    return Object.freeze({ ok: true, currentEtag });
  }
  return Object.freeze({
    ok: false,
    currentEtag,
    response: createPortalV2RevisionMismatchResponse(
      input.correlationId,
      currentEtag,
    ),
  });
}
