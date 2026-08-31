import {
  getQuoteV2FeatureState,
  isQuoteV2FeatureEnabled,
  QUOTE_V2_FEATURE_FLAGS,
} from "@/lib/feature-flags";

describe("quote V2 feature flags", () => {
  const originalNodeEnv = process.env["NODE_ENV"];
  const originalValues = Object.fromEntries(
    Object.values(QUOTE_V2_FEATURE_FLAGS).map((name) => [
      name,
      process.env[name],
    ]),
  );

  afterEach(() => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: originalNodeEnv,
      writable: true,
      configurable: true,
    });
    for (const [name, value] of Object.entries(originalValues)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("defaults every rollout surface off in production", () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      writable: true,
      configurable: true,
    });
    for (const name of Object.values(QUOTE_V2_FEATURE_FLAGS)) {
      delete process.env[name];
    }
    expect(getQuoteV2FeatureState()).toEqual({
      dualWrite: false,
      staff: false,
      sender: false,
      public: false,
      mutations: false,
      deposits: false,
      booking: false,
    });
  });

  it("allows each side-effect boundary to be enabled independently", () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      value: "production",
      writable: true,
      configurable: true,
    });
    process.env[QUOTE_V2_FEATURE_FLAGS.public] = "true";
    process.env[QUOTE_V2_FEATURE_FLAGS.booking] = "false";
    expect(isQuoteV2FeatureEnabled("public")).toBe(true);
    expect(isQuoteV2FeatureEnabled("booking")).toBe(false);
  });
});
