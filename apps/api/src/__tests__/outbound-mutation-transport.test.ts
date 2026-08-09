import { retryOutboundMutationOnce } from "../../../site/src/app/team/lib/outbound-mutation-transport";

describe("outbound Site mutation transport recovery", () => {
  it("retries one unreachable request with the same request closure", async () => {
    const receipt = { ok: true, operationId: "operation-1" };
    const request = jest
      .fn<Promise<typeof receipt>, []>()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(receipt);

    await expect(retryOutboundMutationOnce(request)).resolves.toBe(receipt);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retries one timeout and does not hide a second failure", async () => {
    const timeout = Object.assign(new Error("timed out"), {
      name: "AbortError",
    });
    const finalFailure = new TypeError("still unreachable");
    const request = jest
      .fn<Promise<Response>, []>()
      .mockRejectedValueOnce(timeout)
      .mockRejectedValueOnce(finalFailure);

    await expect(retryOutboundMutationOnce(request)).rejects.toBe(finalFailure);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not replay programming or configuration failures", async () => {
    const failure = new Error("ADMIN_API_KEY must be set");
    const request = jest.fn<Promise<Response>, []>().mockRejectedValue(failure);

    await expect(retryOutboundMutationOnce(request)).rejects.toBe(failure);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
