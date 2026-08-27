import {
  buildExpenseReceiptOpenAiRequest,
  ExpenseReceiptAnalysisProviderError,
  extractExpenseReceiptWithOpenAi,
  resolveExpenseReceiptOpenAiConfig,
} from "@/lib/expense-receipt-openai";

const validExtraction = {
  vendor: "Fuel Stop",
  transactionDate: "2026-08-26",
  totalCents: 5_432,
  taxCents: 432,
  paymentLastFour: "4242",
  suggestedCategoryId: "fuel",
  lineItems: [{ description: "Fuel", amountCents: 5_432 }],
  warnings: [],
  fieldConfidence: {
    vendor: 0.99,
    transactionDate: 0.98,
    totalCents: 0.99,
    taxCents: 0.9,
    paymentLastFour: 0.8,
    suggestedCategoryId: 0.88,
    lineItems: 0.8,
  },
};

describe("expense receipt Responses API adapter", () => {
  it("uses the expense model first, then the existing model, with a safe default", () => {
    expect(
      resolveExpenseReceiptOpenAiConfig({
        OPENAI_API_KEY: "test-key",
        OPENAI_EXPENSE_MODEL: "expense-model",
        OPENAI_MODEL: "shared-model",
      }).model,
    ).toBe("expense-model");
    expect(
      resolveExpenseReceiptOpenAiConfig({
        OPENAI_API_KEY: "test-key",
        OPENAI_MODEL: "shared-model",
      }).model,
    ).toBe("shared-model");
    expect(
      resolveExpenseReceiptOpenAiConfig({ OPENAI_API_KEY: "test-key" }).model,
    ).toBe("gpt-4.1-mini");
  });

  it("always disables provider storage and requests strict structured output", () => {
    const payload = buildExpenseReceiptOpenAiRequest({
      model: "gpt-4.1-mini",
      filename: "receipt.jpg",
      contentType: "image/jpeg",
      bytes: Buffer.from("jpeg-bytes"),
    }) as {
      store?: unknown;
      input?: Array<{ content?: Array<Record<string, unknown>> }>;
      text?: { format?: { strict?: unknown; name?: unknown } };
    };
    expect(payload.store).toBe(false);
    expect(payload.text?.format).toMatchObject({
      strict: true,
      name: "expense_receipt_extraction",
    });
    expect(payload.input?.[1]?.content?.[1]).toMatchObject({
      type: "input_image",
      detail: "high",
    });
  });

  it("uses the supported file-input form for PDFs", () => {
    const payload = buildExpenseReceiptOpenAiRequest({
      model: "gpt-4.1-mini",
      filename: "receipt.pdf",
      contentType: "application/pdf",
      bytes: Buffer.from("%PDF-1.7", "ascii"),
    }) as { input?: Array<{ content?: Array<Record<string, unknown>> }> };
    expect(payload.input?.[1]?.content?.[1]).toMatchObject({
      type: "input_file",
      filename: "receipt.pdf",
    });
    expect(payload.input?.[1]?.content?.[1]?.["file_data"]).toMatch(
      /^data:application\/pdf;base64,/u,
    );
  });

  it("returns only output that passes the no-invention extraction schema", async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve(
        Response.json({ output_text: JSON.stringify(validExtraction) }),
      ),
    );
    const result = await extractExpenseReceiptWithOpenAi({
      filename: "receipt.jpg",
      contentType: "image/jpeg",
      bytes: Buffer.from("receipt"),
      environment: {
        OPENAI_API_KEY: "test-key",
        OPENAI_EXPENSE_MODEL: "expense-model",
      },
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(result).toEqual({
      extraction: validExtraction,
      model: "expense-model",
    });
    const request = fetchMock.mock.calls[0];
    expect(String(request?.[0])).toBe("https://api.openai.com/v1/responses");
    const body = JSON.parse(String(request?.[1]?.body)) as { store?: unknown };
    expect(body.store).toBe(false);
  });

  it("rejects malformed success output instead of filling missing values", async () => {
    const fetchMock = jest.fn(() =>
      Promise.resolve(
        Response.json({
          output_text: JSON.stringify({
            ...validExtraction,
            totalCents: null,
            fieldConfidence: {
              ...validExtraction.fieldConfidence,
              totalCents: 0.2,
            },
          }),
        }),
      ),
    );

    await expect(
      extractExpenseReceiptWithOpenAi({
        filename: "receipt.jpg",
        contentType: "image/jpeg",
        bytes: Buffer.from("receipt"),
        environment: { OPENAI_API_KEY: "test-key" },
        fetchImpl: fetchMock as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({
      code: "openai_expense_schema_mismatch",
      retryable: true,
    });
  });

  it("marks rate limits as retryable and client errors as terminal", async () => {
    const rateLimited = jest.fn(() =>
      Promise.resolve(new Response("slow down", { status: 429 })),
    );
    await expect(
      extractExpenseReceiptWithOpenAi({
        filename: "receipt.jpg",
        contentType: "image/jpeg",
        bytes: Buffer.from("receipt"),
        environment: { OPENAI_API_KEY: "test-key" },
        fetchImpl: rateLimited as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ retryable: true });

    const invalid = jest.fn(() =>
      Promise.resolve(new Response("bad input", { status: 400 })),
    );
    let thrown: unknown;
    try {
      await extractExpenseReceiptWithOpenAi({
        filename: "receipt.jpg",
        contentType: "image/jpeg",
        bytes: Buffer.from("receipt"),
        environment: { OPENAI_API_KEY: "test-key" },
        fetchImpl: invalid as unknown as typeof fetch,
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(ExpenseReceiptAnalysisProviderError);
    expect(thrown).toMatchObject({ retryable: false });
  });
});
