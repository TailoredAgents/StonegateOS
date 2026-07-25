import { shouldRedirectToSquareSetup } from "../../../site/src/app/mobile/payment-return/routing";

describe("mobile Square return routing", () => {
  it("opens setup only for an explicitly retryable setup failure", () => {
    expect(
      shouldRedirectToSquareSetup({
        status: "failed",
        errorCode: "ILLEGAL_LOCATION_ID",
        retryable: true,
      }),
    ).toBe(true);
  });

  it("keeps a setup-looking error in verification unless the API says it is retryable", () => {
    expect(
      shouldRedirectToSquareSetup({
        status: "pending_verification",
        errorCode: "ILLEGAL_LOCATION_ID",
        retryable: false,
      }),
    ).toBe(false);
    expect(
      shouldRedirectToSquareSetup({
        status: "pending_verification",
        errorCode: "ILLEGAL_LOCATION_ID",
      }),
    ).toBe(false);
  });

  it("does not route provider or transaction errors to setup", () => {
    expect(
      shouldRedirectToSquareSetup({
        status: "failed",
        errorCode: "UNEXPECTED_PROVIDER_ERROR",
        retryable: true,
      }),
    ).toBe(false);
  });
});
