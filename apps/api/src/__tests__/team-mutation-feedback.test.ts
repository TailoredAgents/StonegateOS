import {
  readTeamMutationSuccess,
  readTeamMutationError,
  resolveTeamMutationFeedback,
} from "../../../site/src/app/team/lib/mutation-feedback";

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("Team mutation feedback", () => {
  const validReceipt = {
    operationId: "operation-123",
    correlationId: "correlation-123",
    actorId: "member-123",
    committedAt: "2026-08-08T12:00:00.000Z",
  };

  it("reports success only after a successful response", async () => {
    await expect(
      resolveTeamMutationFeedback(Promise.resolve(new Response(null)), {
        success: "Saved",
        failure: "Unable to save",
      }),
    ).resolves.toEqual({ ok: true, message: "Saved" });
  });

  it.each([
    [401, "session expired"],
    [403, "do not have permission"],
    [409, "changed since the page loaded"],
    [422, "Check the entered values"],
    [429, "Wait a moment"],
    [500, "could not confirm the change"],
    [504, "refresh before retrying"],
  ])(
    "never reports HTTP %i as success and gives recovery guidance",
    async (status, expectedText) => {
      const feedback = await resolveTeamMutationFeedback(
        Promise.resolve(jsonResponse(status, { error: "provider_failed" })),
        { success: "Saved", failure: "Unable to save" },
      );

      expect(feedback.ok).toBe(false);
      expect(feedback.message).toContain(expectedText);
      expect(feedback.message).not.toBe("Saved");
    },
  );

  it("keeps useful validation detail and adds a next step", async () => {
    await expect(
      readTeamMutationError(
        jsonResponse(422, { message: "Final total is required" }),
        "Unable to update appointment",
      ),
    ).resolves.toBe(
      "Final total is required. Check the entered values and try again. No change was confirmed.",
    );
  });

  it("reports an aborted request as unconfirmed instead of successful", async () => {
    const aborted = Object.assign(new Error("aborted"), {
      name: "AbortError",
    });
    const feedback = await resolveTeamMutationFeedback(
      Promise.reject(aborted),
      { success: "Saved", failure: "Unable to save" },
    );

    expect(feedback).toEqual({
      ok: false,
      message:
        "Unable to save timed out. The result could not be confirmed; refresh before retrying to avoid a duplicate.",
    });
  });

  it("reports a network failure as unconfirmed instead of successful", async () => {
    const feedback = await resolveTeamMutationFeedback(
      Promise.reject(new TypeError("fetch failed")),
      { success: "Saved", failure: "Unable to save" },
    );

    expect(feedback).toEqual({
      ok: false,
      message:
        "Unable to save. The service could not be reached. Check your connection and retry; no change was confirmed.",
    });
  });

  it.each([
    ["HTML", new Response("<html>gateway</html>", { status: 200 })],
    ["invalid JSON", new Response("{", { status: 200 })],
    ["ok false", jsonResponse(200, { ok: false })],
    ["missing receipt", jsonResponse(200, { ok: true, data: {} })],
    [
      "malformed receipt",
      jsonResponse(200, {
        ok: true,
        data: {},
        receipt: { ...validReceipt, committedAt: "not-a-date" },
      }),
    ],
  ])("rejects a 2xx %s quote response", async (_label, response) => {
    await expect(readTeamMutationSuccess(response)).resolves.toBeNull();
  });

  it("accepts a valid replay envelope and receipt", async () => {
    const response = jsonResponse(200, {
      ok: true,
      data: { quoteId: "quote-123" },
      receipt: validReceipt,
    });
    response.headers.set("idempotency-replayed", "true");

    await expect(readTeamMutationSuccess(response)).resolves.toEqual({
      ok: true,
      data: { quoteId: "quote-123" },
      receipt: validReceipt,
    });
  });

  it("does not claim success when a required receipt is absent", async () => {
    const feedback = await resolveTeamMutationFeedback(
      Promise.resolve(jsonResponse(200, { ok: true, data: {} })),
      {
        success: "Sent",
        failure: "Unable to send",
        requireReceipt: true,
      },
    );

    expect(feedback.ok).toBe(false);
    expect(feedback.message).toContain("unreadable success receipt");
  });
});
