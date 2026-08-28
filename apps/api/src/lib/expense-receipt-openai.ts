import { resolveOpenAiApiEndpoint } from "@myst-os/sdk";
import {
  ExpenseReceiptExtractionSchema,
  MAX_DUMP_BILLED_WEIGHT_MILLI_TONS,
  MAX_DUMP_UNIT_RATE_CENTS_PER_TON,
  MAX_DUMP_WEIGHT_POUNDS,
  MAX_RECEIPT_MONEY_CENTS,
  type ExpenseReceiptExtraction,
} from "@/lib/expense-receipt-domain";
import type { ExpenseReceiptContentType } from "@/lib/expense-receipt-storage";

const DEFAULT_EXPENSE_RECEIPT_MODEL = "gpt-4.1-mini";
const DEFAULT_TIMEOUT_MS = 60_000;

export const EXPENSE_RECEIPT_CATEGORY_IDS = [
  "dump_fees",
  "fuel",
  "meals",
  "equipment",
  "vehicle",
  "insurance",
  "software",
  "advertising",
  "supplies",
  "tolls_parking",
  "subcontractors",
  "office_admin",
  "other",
] as const;

type ExpenseOpenAiEnvironment = Readonly<Record<string, string | undefined>>;

export type ExpenseReceiptOpenAiConfig = {
  apiKey: string;
  model: string;
  timeoutMs: number;
};

export class ExpenseReceiptAnalysisProviderError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
    message = code,
  ) {
    super(message);
    this.name = "ExpenseReceiptAnalysisProviderError";
  }
}

function readEnvString(
  environment: ExpenseOpenAiEnvironment,
  key: string,
): string | null {
  const value = environment[key]?.trim();
  return value ? value : null;
}

export function resolveExpenseReceiptOpenAiConfig(
  environment: ExpenseOpenAiEnvironment = process.env,
): ExpenseReceiptOpenAiConfig {
  const apiKey = readEnvString(environment, "OPENAI_API_KEY");
  if (!apiKey) {
    throw new ExpenseReceiptAnalysisProviderError(
      "openai_expense_api_key_missing",
      true,
    );
  }
  const rawTimeout = readEnvString(environment, "OPENAI_EXPENSE_TIMEOUT_MS");
  const parsedTimeout = rawTimeout ? Number(rawTimeout) : DEFAULT_TIMEOUT_MS;
  const timeoutMs =
    Number.isSafeInteger(parsedTimeout) &&
    parsedTimeout >= 5_000 &&
    parsedTimeout <= 120_000
      ? parsedTimeout
      : DEFAULT_TIMEOUT_MS;

  return {
    apiKey,
    model:
      readEnvString(environment, "OPENAI_EXPENSE_MODEL") ??
      readEnvString(environment, "OPENAI_MODEL") ??
      DEFAULT_EXPENSE_RECEIPT_MODEL,
    timeoutMs,
  };
}

const nullableConfidenceJsonSchema = {
  type: ["number", "null"],
  minimum: 0,
  maximum: 1,
} as const;

export const EXPENSE_RECEIPT_EXTRACTION_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    documentType: {
      type: "string",
      enum: ["standard_receipt", "scale_ticket", "unknown"],
    },
    dumpTicket: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          properties: {
            facilityName: { type: ["string", "null"], maxLength: 240 },
            ticketNumber: { type: ["string", "null"], maxLength: 120 },
            material: { type: ["string", "null"], maxLength: 240 },
            grossWeightPounds: {
              type: ["integer", "null"],
              minimum: 1,
              maximum: MAX_DUMP_WEIGHT_POUNDS,
            },
            tareWeightPounds: {
              type: ["integer", "null"],
              minimum: 0,
              maximum: MAX_DUMP_WEIGHT_POUNDS,
            },
            netWeightPounds: {
              type: ["integer", "null"],
              minimum: 1,
              maximum: MAX_DUMP_WEIGHT_POUNDS,
            },
            billedWeightMilliTons: {
              type: ["integer", "null"],
              minimum: 0,
              maximum: MAX_DUMP_BILLED_WEIGHT_MILLI_TONS,
            },
            unitRateCentsPerTon: {
              type: ["integer", "null"],
              minimum: 0,
              maximum: MAX_DUMP_UNIT_RATE_CENTS_PER_TON,
            },
            fieldConfidence: {
              type: "object",
              additionalProperties: false,
              properties: {
                facilityName: nullableConfidenceJsonSchema,
                ticketNumber: nullableConfidenceJsonSchema,
                material: nullableConfidenceJsonSchema,
                grossWeightPounds: nullableConfidenceJsonSchema,
                tareWeightPounds: nullableConfidenceJsonSchema,
                netWeightPounds: nullableConfidenceJsonSchema,
                billedWeightMilliTons: nullableConfidenceJsonSchema,
                unitRateCentsPerTon: nullableConfidenceJsonSchema,
              },
              required: [
                "facilityName",
                "ticketNumber",
                "material",
                "grossWeightPounds",
                "tareWeightPounds",
                "netWeightPounds",
                "billedWeightMilliTons",
                "unitRateCentsPerTon",
              ],
            },
          },
          required: [
            "facilityName",
            "ticketNumber",
            "material",
            "grossWeightPounds",
            "tareWeightPounds",
            "netWeightPounds",
            "billedWeightMilliTons",
            "unitRateCentsPerTon",
            "fieldConfidence",
          ],
        },
        { type: "null" },
      ],
    },
    vendor: { type: ["string", "null"], maxLength: 240 },
    transactionDate: {
      type: ["string", "null"],
      format: "date",
      pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
    },
    totalCents: {
      type: ["integer", "null"],
      minimum: 1,
      maximum: MAX_RECEIPT_MONEY_CENTS,
    },
    taxCents: {
      type: ["integer", "null"],
      minimum: 0,
      maximum: MAX_RECEIPT_MONEY_CENTS,
    },
    paymentLastFour: {
      type: ["string", "null"],
      pattern: "^[0-9]{4}$",
    },
    suggestedCategoryId: {
      anyOf: [
        { type: "string", enum: EXPENSE_RECEIPT_CATEGORY_IDS },
        { type: "null" },
      ],
    },
    lineItems: {
      anyOf: [
        {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              description: { type: "string", minLength: 1, maxLength: 240 },
              amountCents: {
                type: "integer",
                minimum: -MAX_RECEIPT_MONEY_CENTS,
                maximum: MAX_RECEIPT_MONEY_CENTS,
              },
            },
            required: ["description", "amountCents"],
          },
        },
        { type: "null" },
      ],
    },
    warnings: {
      type: "array",
      maxItems: 20,
      items: { type: "string", minLength: 1, maxLength: 500 },
    },
    fieldConfidence: {
      type: "object",
      additionalProperties: false,
      properties: {
        documentType: nullableConfidenceJsonSchema,
        vendor: nullableConfidenceJsonSchema,
        transactionDate: nullableConfidenceJsonSchema,
        totalCents: nullableConfidenceJsonSchema,
        taxCents: nullableConfidenceJsonSchema,
        paymentLastFour: nullableConfidenceJsonSchema,
        suggestedCategoryId: nullableConfidenceJsonSchema,
        lineItems: nullableConfidenceJsonSchema,
      },
      required: [
        "documentType",
        "vendor",
        "transactionDate",
        "totalCents",
        "taxCents",
        "paymentLastFour",
        "suggestedCategoryId",
        "lineItems",
      ],
    },
  },
  required: [
    "documentType",
    "dumpTicket",
    "vendor",
    "transactionDate",
    "totalCents",
    "taxCents",
    "paymentLastFour",
    "suggestedCategoryId",
    "lineItems",
    "warnings",
    "fieldConfidence",
  ],
} as const;

const SYSTEM_PROMPT = `You extract accounting facts from receipt evidence for human review.

Rules:
- Inspect the entire document at any portrait, landscape, sideways, or camera-rotated orientation.
- documentType is scale_ticket for landfill, transfer-station, disposal, or weigh-scale tickets; standard_receipt for ordinary receipts; otherwise unknown.
- For a scale ticket, return dumpTicket even when some values are unreadable. For other document types, dumpTicket must be null.
- facilityName is the named landfill, transfer station, or scale site, which may differ from the billing company/vendor.
- ticketNumber is the scale-ticket identifier, not a site ID, payment reference, customer number, or PO number.
- Copy material exactly as printed when readable. If several descriptions appear, prefer the explicitly labeled MATERIAL field over a charge-line description.
- grossWeightPounds, tareWeightPounds, and netWeightPounds are whole pounds. Prefer explicitly labeled Gross, Tare, and Net values.
- billedWeightMilliTons is the printed billed or charge quantity in US tons multiplied by 1000. Example: 1.45 tons is 1450. Do not use an unrelated item quantity.
- unitRateCentsPerTon is the printed per-ton rate in cents. Example: $50.00 per ton is 5000.
- netWeightPounds is only the explicitly printed net weight in pounds. Never derive or convert it from billed tons; preserve that separate evidence in billedWeightMilliTons.
- suggestedCategoryId should normally be dump_fees for a scale ticket unless visible evidence clearly supports another allowed category.
- vendor is the billing or operating company shown on the ticket; do not replace it with facilityName when those names differ.
- If printed gross minus tare disagrees with printed net, preserve the visibly labeled values and add a warning. Do not silently repair them.
- Never guess or infer a value that is not visibly supported by the receipt.
- Use null for missing, ambiguous, obscured, or unreadable values.
- The total is the final amount paid, in integer USD cents. Do not use subtotal.
- The transaction date is YYYY-MM-DD only when visible and unambiguous.
- Return only the merchant/vendor shown on the receipt, not a card issuer.
- paymentLastFour is null unless four payment-card digits are explicitly shown.
- suggestedCategoryId must be one allowed category ID or null.
- Confidence is 0 through 1 and must be null whenever its field is null.
- Put glare, cropping, uncertain orientation, conflicting weights, duplicate totals, uncertain currency, handwritten changes, and other review risks in warnings.
- This extraction never authorizes or posts an expense. A human must confirm it.`;

export function buildExpenseReceiptOpenAiRequest(input: {
  model: string;
  filename: string;
  contentType: ExpenseReceiptContentType | "image/jpeg";
  bytes: Buffer;
}): Record<string, unknown> {
  const encoded = input.bytes.toString("base64");
  const evidence =
    input.contentType === "application/pdf"
      ? {
          type: "input_file",
          filename: input.filename.toLowerCase().endsWith(".pdf")
            ? input.filename
            : `${input.filename}.pdf`,
          file_data: `data:application/pdf;base64,${encoded}`,
        }
      : {
          type: "input_image",
          image_url: `data:${input.contentType};base64,${encoded}`,
          detail: "high",
        };

  return {
    model: input.model,
    store: false,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: SYSTEM_PROMPT }],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: "Extract this receipt into the required schema. Leave uncertain fields null.",
          },
          evidence,
        ],
      },
    ],
    max_output_tokens: 1_800,
    text: {
      verbosity: "low",
      format: {
        type: "json_schema",
        name: "expense_receipt_extraction",
        strict: true,
        schema: EXPENSE_RECEIPT_EXTRACTION_JSON_SCHEMA,
      },
    },
  };
}

function readOutputText(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const response = payload as {
    output_text?: unknown;
    output?: Array<{ content?: Array<{ text?: unknown }> }>;
  };
  if (typeof response.output_text === "string") return response.output_text;
  const outputText = response.output
    ?.flatMap((item) => item.content ?? [])
    .find((item) => typeof item.text === "string")?.text;
  return typeof outputText === "string" ? outputText : null;
}

function compactProviderError(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, 300);
}

export async function extractExpenseReceiptWithOpenAi(input: {
  filename: string;
  contentType: ExpenseReceiptContentType | "image/jpeg";
  bytes: Buffer;
  environment?: ExpenseOpenAiEnvironment;
  fetchImpl?: typeof fetch;
}): Promise<{ extraction: ExpenseReceiptExtraction; model: string }> {
  const environment = input.environment ?? process.env;
  const config = resolveExpenseReceiptOpenAiConfig(environment);
  const fetchImpl = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetchImpl(
      resolveOpenAiApiEndpoint("responses", environment),
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(
          buildExpenseReceiptOpenAiRequest({
            model: config.model,
            filename: input.filename,
            contentType: input.contentType,
            bytes: input.bytes,
          }),
        ),
        signal: AbortSignal.timeout(config.timeoutMs),
      },
    );
  } catch (error) {
    const code =
      error instanceof Error && error.name === "TimeoutError"
        ? "openai_expense_timeout"
        : "openai_expense_network_failed";
    throw new ExpenseReceiptAnalysisProviderError(code, true);
  }

  if (!response.ok) {
    const detail = compactProviderError(await response.text().catch(() => ""));
    throw new ExpenseReceiptAnalysisProviderError(
      `openai_expense_http_${response.status}`,
      response.status === 408 ||
        response.status === 409 ||
        response.status === 429 ||
        response.status >= 500,
      detail || `OpenAI receipt analysis returned HTTP ${response.status}.`,
    );
  }

  const payload = (await response.json().catch(() => null)) as unknown;
  const raw = readOutputText(payload);
  if (!raw?.trim()) {
    throw new ExpenseReceiptAnalysisProviderError(
      "openai_expense_empty_output",
      true,
    );
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    throw new ExpenseReceiptAnalysisProviderError(
      "openai_expense_invalid_json",
      true,
    );
  }
  const parsed = ExpenseReceiptExtractionSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ExpenseReceiptAnalysisProviderError(
      "openai_expense_schema_mismatch",
      true,
      parsed.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.join(".")}:${issue.code}`)
        .join(" | "),
    );
  }

  return { extraction: parsed.data, model: config.model };
}
