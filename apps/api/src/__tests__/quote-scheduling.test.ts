import { runBestEffortQuoteHoldCleanup } from "@/lib/quote-scheduling";

describe("runBestEffortQuoteHoldCleanup", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("allows a successful booking response when expired-hold cleanup fails", async () => {
    const warning = jest.spyOn(console, "warn").mockImplementation(() => {});
    const cleanup = jest
      .fn<Promise<void>, []>()
      .mockRejectedValue(new Error("cleanup unavailable"));

    await expect(
      runBestEffortQuoteHoldCleanup(cleanup, {
        quoteId: "quote-123",
        appointmentId: "appointment-456",
      }),
    ).resolves.toBeUndefined();

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      "[quote-scheduling] expired_hold_cleanup_failed",
      {
        quoteId: "quote-123",
        appointmentId: "appointment-456",
        error: "cleanup unavailable",
      },
    );
  });
});
