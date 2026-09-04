import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { requireTeamPrincipal } from "../src/app/api/team/auth";
import {
  requireVerifiedTeamPrincipal,
  TeamPrincipalRequiredError,
  TeamSessionVerificationUnavailableError,
  verifyTeamSessionTokenResult,
} from "../src/lib/team-principal";

function sessionResponse(status: number, payload: unknown = null): Response {
  return new Response(payload === null ? null : JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function validSessionPayload() {
  return {
    ok: true,
    sessionId: "11111111-1111-4111-8111-111111111111",
    authMethod: "team_session",
    teamMember: {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Stonegate Owner",
      email: "owner@stonegate.example",
      roleSlug: "OWNER",
      passwordSet: true,
      permissions: ["appointments.update", "appointments.update", null],
    },
  };
}

async function withFetchStub<T>(
  fetcher: typeof fetch,
  operation: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    return await operation();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function teamMutationRequest(sessionToken: string): NextRequest {
  return new NextRequest(
    "https://stonegate.example/api/team/appointments/status",
    {
      method: "POST",
      headers: {
        accept: "application/json",
        cookie: `myst-team-session=${sessionToken}`,
        origin: "https://stonegate.example",
        "sec-fetch-site": "same-origin",
      },
    },
  );
}

void test("Team session verification accepts only a complete success payload", async () => {
  let calls = 0;
  const result = await verifyTeamSessionTokenResult(" valid-session ", {
    apiBaseUrl: "https://api.stonegate.example/",
    fetcher: ((input, init) => {
      calls += 1;
      assert.equal(
        input,
        "https://api.stonegate.example/api/public/team/session",
      );
      const headers = new Headers(init?.headers);
      assert.equal(headers.get("authorization"), "Bearer valid-session");
      assert.equal(headers.get("accept"), "application/json");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "manual");
      assert.ok(init?.signal);
      return Promise.resolve(sessionResponse(200, validSessionPayload()));
    }) as typeof fetch,
  });

  assert.equal(calls, 1);
  assert.equal(result.kind, "valid");
  if (result.kind !== "valid") return;
  assert.equal(result.principal.roleSlug, "owner");
  assert.deepEqual(result.principal.permissions, ["appointments.update"]);
  assert.equal(result.principal.sessionToken, "valid-session");

  for (const payload of [
    null,
    { ok: false },
    { ...validSessionPayload(), ok: "true" },
    { ...validSessionPayload(), sessionId: "" },
    { ...validSessionPayload(), authMethod: "service" },
    { ...validSessionPayload(), teamMember: { name: "Missing ID" } },
  ]) {
    assert.deepEqual(
      await verifyTeamSessionTokenResult(
        `malformed-${JSON.stringify(payload)}`,
        {
          fetcher: (() =>
            Promise.resolve(sessionResponse(200, payload))) as typeof fetch,
        },
      ),
      {
        kind: "unavailable",
        reason: "malformed_response",
        retryAfter: null,
      },
    );
  }
});

void test("only an API 401 or 403 marks a presented Team session invalid", async () => {
  assert.deepEqual(await verifyTeamSessionTokenResult("   "), {
    kind: "invalid",
  });

  for (const status of [401, 403]) {
    assert.deepEqual(
      await verifyTeamSessionTokenResult(`rejected-${status}`, {
        fetcher: (() =>
          Promise.resolve(sessionResponse(status))) as typeof fetch,
      }),
      { kind: "invalid" },
    );
  }

  for (const status of [400, 404, 409, 500, 503]) {
    assert.deepEqual(
      await verifyTeamSessionTokenResult(`unavailable-${status}`, {
        fetcher: (() =>
          Promise.resolve(sessionResponse(status))) as typeof fetch,
      }),
      {
        kind: "unavailable",
        reason: "upstream_error",
        retryAfter: null,
      },
    );
  }

  const rateLimited = await verifyTeamSessionTokenResult("rate-limited", {
    fetcher: (() =>
      Promise.resolve(
        new Response(null, {
          status: 429,
          headers: { "retry-after": "45" },
        }),
      )) as typeof fetch,
  });
  assert.deepEqual(rateLimited, {
    kind: "unavailable",
    reason: "rate_limited",
    retryAfter: "45",
  });
});

void test("network failures and the bounded timeout remain unavailable, not invalid", async () => {
  assert.deepEqual(
    await verifyTeamSessionTokenResult("network-error", {
      fetcher: (() =>
        Promise.reject(
          new TypeError("connection unavailable"),
        )) as typeof fetch,
    }),
    {
      kind: "unavailable",
      reason: "network_error",
      retryAfter: null,
    },
  );

  const timeoutFetcher = ((_input, init) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const rejectForAbort = () =>
        reject(new DOMException("The operation was aborted", "AbortError"));
      if (signal?.aborted) {
        rejectForAbort();
        return;
      }
      signal?.addEventListener("abort", rejectForAbort, { once: true });
    })) as typeof fetch;
  assert.deepEqual(
    await verifyTeamSessionTokenResult("timeout", {
      fetcher: timeoutFetcher,
      timeoutMs: 5,
    }),
    {
      kind: "unavailable",
      reason: "timeout",
      retryAfter: null,
    },
  );
});

void test("server actions distinguish an invalid session from a verification outage", () => {
  assert.throws(
    () => requireVerifiedTeamPrincipal({ kind: "invalid" }),
    TeamPrincipalRequiredError,
  );

  assert.throws(
    () =>
      requireVerifiedTeamPrincipal({
        kind: "unavailable",
        reason: "upstream_error",
        retryAfter: "30",
      }),
    (error: unknown) => {
      assert.ok(error instanceof TeamSessionVerificationUnavailableError);
      assert.equal(error.status, 503);
      assert.equal(error.code, "session_verification_unavailable");
      assert.equal(error.retryAfter, "30");
      assert.match(error.message, /temporarily unavailable/iu);
      assert.doesNotMatch(error.message, /sign in/iu);
      return true;
    },
  );
});

void test("the Team mutation boundary returns retryable 503 without clearing the session", async () => {
  await withFetchStub(
    (() => Promise.resolve(sessionResponse(500))) as typeof fetch,
    async () => {
      const result = await requireTeamPrincipal(
        teamMutationRequest("boundary-upstream-error"),
        { permissions: "appointments.update", returnJson: true },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.response.status, 503);
      assert.match(
        result.response.headers.get("cache-control") ?? "",
        /private.*no-store/u,
      );
      assert.doesNotMatch(
        result.response.headers.get("set-cookie") ?? "",
        /myst-team-session/u,
      );
      assert.deepEqual(await result.response.json(), {
        ok: false,
        error: "session_verification_unavailable",
        message:
          "Team services could not verify your session right now. Your sign-in is unchanged; wait a moment and try again.",
        retryable: true,
      });
    },
  );

  await withFetchStub(
    (() =>
      Promise.resolve(
        new Response(null, {
          status: 429,
          headers: { "retry-after": "45" },
        }),
      )) as typeof fetch,
    async () => {
      const result = await requireTeamPrincipal(
        teamMutationRequest("boundary-rate-limited"),
        { permissions: "appointments.update", returnJson: true },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.response.status, 503);
      assert.equal(result.response.headers.get("retry-after"), "45");
      assert.doesNotMatch(
        result.response.headers.get("set-cookie") ?? "",
        /myst-team-session/u,
      );
    },
  );

  await withFetchStub(
    (() => Promise.resolve(sessionResponse(401))) as typeof fetch,
    async () => {
      const result = await requireTeamPrincipal(
        teamMutationRequest("boundary-rejected"),
        { permissions: "appointments.update", returnJson: true },
      );
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.response.status, 401);
      assert.deepEqual(await result.response.json(), { error: "unauthorized" });
      assert.doesNotMatch(
        result.response.headers.get("set-cookie") ?? "",
        /myst-team-session/u,
      );
    },
  );
});
