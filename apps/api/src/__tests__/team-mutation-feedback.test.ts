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
    [409, "Refresh to review the latest details"],
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

  it("reports partner scheduling conflicts without claiming the record is stale", async () => {
    const message =
      "The selected crew or equipment cannot cover this job, or its daily limit is reached. Choose another resource or time.";
    const response = jsonResponse(409, {
      ok: false,
      error: "slot_unavailable",
      message,
    });

    await expect(
      resolveTeamMutationFeedback(Promise.resolve(response), {
        success: "Request confirmed",
        failure: "Unable to confirm request",
      }),
    ).resolves.toEqual({ ok: false, message });
    await expect(response.json()).resolves.toMatchObject({
      error: "slot_unavailable",
      message,
    });
  });

  it("preserves actual stale-record recovery instructions", async () => {
    const message =
      "This appointment changed on another screen. Refresh it and review the latest status, total, crew, and time before retrying.";

    await expect(
      readTeamMutationError(
        jsonResponse(409, { error: "appointment_changed", message }),
        "Unable to update appointment",
      ),
    ).resolves.toBe(message);
  });

  it("keeps other business-conflict guidance without adding stale-record advice", async () => {
    const message =
      "This request is already being processed. Wait for it to finish before trying again.";

    await expect(
      readTeamMutationError(
        jsonResponse(409, { error: "idempotency_in_progress", message }),
        "Unable to confirm request",
      ),
    ).resolves.toBe(message);
  });

  it.each([
    ["missing body", new Response(null, { status: 409 })],
    ["invalid JSON", new Response("{", { status: 409 })],
    ["empty message", jsonResponse(409, { message: " " })],
  ])("gives neutral conflict guidance for %s", async (_label, response) => {
    await expect(
      readTeamMutationError(response, "Unable to confirm request"),
    ).resolves.toBe(
      "Unable to confirm request. Refresh to review the latest details before trying again. No change was confirmed.",
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
