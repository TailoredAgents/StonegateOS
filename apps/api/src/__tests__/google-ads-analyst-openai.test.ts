import {
  callOpenAIAnalystJson,
  GOOGLE_ADS_ANALYST_OPENAI_TIMEOUT_MS,
} from "@/lib/google-ads-analyst";

const validReport = {
  summary:
    "The account has several practical opportunities to improve results.",
  top_actions: [
    "Review expensive search terms with no conversions.",
    "Exclude locations outside the current service area.",
    "Test one new benefit-focused advertisement.",
  ],
  negatives_to_review: [],
  pause_candidates_to_review: [],
  notes: "Review every proposed change before applying it.",
};

function analystInput(fetchImpl: typeof fetch) {
  return {
    apiKey: "test-openai-key",
    model: "gpt-5-mini",
    systemPrompt: "Analyze this account.",
    userPrompt: "The account data is empty.",
    fetchImpl,
  };
}

describe("Google Ads analyst OpenAI request safety", () => {
  it("attaches a bounded timeout signal to the Responses API request", async () => {
    const fetchMock = jest.fn(
      (_request: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal);
        expect(init?.signal?.aborted).toBe(false);
        return Promise.resolve(
          new Response(
            JSON.stringify({ output_text: JSON.stringify(validReport) }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
        );
      },
    ) as unknown as typeof fetch;

    const result = await callOpenAIAnalystJson(analystInput(fetchMock));

    expect(result).toEqual({ ok: true, report: validReport });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(GOOGLE_ADS_ANALYST_OPENAI_TIMEOUT_MS).toBe(90_000);
  });

  it.each(["TimeoutError", "AbortError"])(
    "turns %s rejections into a stable timeout result after bounded attempts",
    async (errorName) => {
      const timeout = Object.assign(new Error("request timed out"), {
        name: errorName,
      });
      const fetchMock = jest
        .fn<Promise<Response>, []>()
        .mockRejectedValue(timeout);

      const result = await callOpenAIAnalystJson(
        analystInput(fetchMock as unknown as typeof fetch),
      );

      expect(result).toMatchObject({
        ok: false,
        error: "openai_request_timeout",
      });
      expect(fetchMock).toHaveBeenCalledTimes(3);
    },
  );

  it("turns other transport failures into a stable request failure", async () => {
    const fetchMock = jest
      .fn<Promise<Response>, []>()
      .mockRejectedValue(new TypeError("network unavailable"));

    const result = await callOpenAIAnalystJson(
      analystInput(fetchMock as unknown as typeof fetch),
    );

    expect(result).toMatchObject({
      ok: false,
      error: "openai_request_failed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
