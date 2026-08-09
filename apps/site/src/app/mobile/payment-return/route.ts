import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { callAdminApiAs } from "@/app/team/lib/api";
import { resolveTeamPrincipalFromCookies } from "@/lib/team-principal";
import {
  parseSquareReturnQueryForForwarding,
  parseSquareReturnResult,
  shouldRedirectToSquareSetup,
  type SquareReturnData,
} from "./routing";

const MAXIMUM_UPSTREAM_RESPONSE_BYTES = 32 * 1024;
const UPSTREAM_BODY_DEADLINE_MS = 5_000;
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;

function noStoreRedirect(destination: URL): Response {
  const response = NextResponse.redirect(destination, 303);
  response.headers.set("Cache-Control", "private, no-store, max-age=0");
  response.headers.set("Referrer-Policy", "no-referrer");
  return response;
}

function mobileDestination(
  origin: string,
  input: {
    status: SquareReturnData["status"];
    attemptId?: string;
    errorCode?: string;
  },
): URL {
  const destination = new URL("/mobile", origin);
  destination.searchParams.set("screen", "myday");
  destination.searchParams.set("payment", input.status);
  if (input.attemptId) {
    destination.searchParams.set("paymentAttempt", input.attemptId);
  }
  if (input.errorCode) {
    destination.searchParams.set("paymentError", input.errorCode);
  }
  return destination;
}

function loginDestination(origin: string): URL {
  const destination = new URL("/mobile/login", origin);
  destination.searchParams.set(
    "error",
    "Your session expired while returning from Square. Sign in, then review the payment attempt before collecting again.",
  );
  return destination;
}

type UpstreamBodyRead =
  | { ok: true; value: unknown }
  | { ok: false; reason: "malformed" | "timeout" | "too_large" };

async function readBoundedUpstreamJson(
  response: Response,
): Promise<UpstreamBodyRead> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (/^\d{1,10}$/u.test(declaredLength) === false ||
      Number(declaredLength) > MAXIMUM_UPSTREAM_RESPONSE_BYTES)
  ) {
    return { ok: false, reason: "too_large" };
  }
  const reader = response.body?.getReader();
  if (!reader) return { ok: false, reason: "malformed" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  const deadlineAt = Date.now() + UPSTREAM_BODY_DEADLINE_MS;
  try {
    while (true) {
      const remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        await reader.cancel("square_return_response_timeout");
        return { ok: false, reason: "timeout" };
      }
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new Error("square_return_response_timeout")),
            remainingMs,
          );
        }),
      ]).finally(() => {
        if (timeout) clearTimeout(timeout);
      });
      if (next.done) break;
      if (!next.value) continue;
      total += next.value.byteLength;
      if (total > MAXIMUM_UPSTREAM_RESPONSE_BYTES) {
        await reader.cancel("square_return_response_too_large");
        return { ok: false, reason: "too_large" };
      }
      chunks.push(next.value);
    }
  } catch (error) {
    await reader.cancel("square_return_response_failed").catch(() => undefined);
    return {
      ok: false,
      reason:
        error instanceof Error &&
        error.message === "square_return_response_timeout"
          ? "timeout"
          : "malformed",
    };
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return {
      ok: true,
      value: JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      ) as unknown,
    };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

function upstreamFailureDestination(origin: string, status: number): URL {
  if (status === 403) {
    return mobileDestination(origin, {
      status: "needs_review",
      errorCode: "square_return_permission_denied",
    });
  }
  if (status === 409) {
    return mobileDestination(origin, {
      status: "needs_review",
      errorCode: "square_return_conflict",
    });
  }
  if ([400, 404, 413, 415, 422].includes(status)) {
    return mobileDestination(origin, {
      status: "needs_review",
      errorCode: "invalid_square_callback",
    });
  }
  if (status === 429) {
    return mobileDestination(origin, {
      status: "pending_verification",
      errorCode: "square_return_rate_limited",
    });
  }
  if (status >= 500) {
    return mobileDestination(origin, {
      status: "pending_verification",
      errorCode: "square_return_service_unavailable",
    });
  }
  return mobileDestination(origin, {
    status: "needs_review",
    errorCode: "square_return_failed",
  });
}

export async function GET(request: Request): Promise<Response> {
  // Resolve the opaque team session before reading or forwarding any callback
  // credential from the URL.
  const principal = await resolveTeamPrincipalFromCookies();
  const requestUrl = new URL(request.url);
  if (!principal) return noStoreRedirect(loginDestination(requestUrl.origin));

  const forwarding = parseSquareReturnQueryForForwarding(
    requestUrl.searchParams,
  );
  if (!forwarding.ok) {
    return noStoreRedirect(
      mobileDestination(requestUrl.origin, {
        status: "needs_review",
        errorCode: forwarding.errorCode,
      }),
    );
  }

  const correlationId = randomUUID();
  const idempotencyKey = `square-return:${createHash("sha256")
    .update(forwarding.state, "utf8")
    .digest("hex")}`;
  let upstream: Response;
  try {
    upstream = await callAdminApiAs(principal, "/api/payments/square/return", {
      method: "POST",
      redirect: "error",
      headers: {
        "Idempotency-Key": idempotencyKey,
        "x-correlation-id": correlationId,
      },
      body: JSON.stringify({ query: forwarding.query }),
      timeoutMs: 30_000,
    });
  } catch {
    return noStoreRedirect(
      mobileDestination(requestUrl.origin, {
        status: "pending_verification",
        errorCode: "square_return_service_unavailable",
      }),
    );
  }

  if (upstream.status === 401) {
    return noStoreRedirect(loginDestination(requestUrl.origin));
  }
  const responseCorrelationId =
    upstream.headers.get("x-correlation-id")?.trim() ?? "";
  const replayed = upstream.headers.get("idempotency-replayed") === "true";
  const correlationIsValid =
    CORRELATION_ID_PATTERN.test(responseCorrelationId) &&
    (replayed || responseCorrelationId === correlationId);
  const bodyRead = await readBoundedUpstreamJson(upstream);
  const result =
    correlationIsValid && bodyRead.ok
      ? parseSquareReturnResult(bodyRead.value, responseCorrelationId)
      : null;

  if (!upstream.ok) {
    // A non-2xx response is never converted into a successful return result,
    // even if its body happens to resemble one.
    return noStoreRedirect(
      upstreamFailureDestination(requestUrl.origin, upstream.status),
    );
  }
  if (!bodyRead.ok && bodyRead.reason === "timeout") {
    return noStoreRedirect(
      mobileDestination(requestUrl.origin, {
        status: "pending_verification",
        errorCode: "square_return_service_unavailable",
      }),
    );
  }
  if (!result?.ok) {
    return noStoreRedirect(
      mobileDestination(requestUrl.origin, {
        status: "needs_review",
        errorCode: "invalid_square_return_receipt",
      }),
    );
  }

  if (shouldRedirectToSquareSetup(result.data)) {
    const setup = new URL("/mobile/square-setup", requestUrl.origin);
    setup.searchParams.set("reason", result.data.errorCode!);
    setup.searchParams.set("paymentAttempt", result.data.attemptId);
    return noStoreRedirect(setup);
  }
  return noStoreRedirect(
    mobileDestination(requestUrl.origin, {
      status: result.data.status,
      attemptId: result.data.attemptId,
      ...(result.data.errorCode ? { errorCode: result.data.errorCode } : {}),
    }),
  );
}
