import { z } from "zod";
import {
  leadIntakeRequestSchema,
  leadIntakeResponseSchema,
  quoteRequestSchema,
  quoteResponseSchema,
  payDepositRequestSchema,
  payDepositResponseSchema,
  type LeadIntakeRequest,
  type LeadIntakeResponse,
  type QuoteRequest,
  type QuoteResponse,
  type PayDepositRequest,
  type PayDepositResponse
} from "../schemas";

export interface MystClientConfig {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  defaultHeaders?: Record<string, string>;
}

const defaultConfig: Required<MystClientConfig> = {
  baseUrl: "/api/web",
  fetchImpl: globalThis.fetch.bind(globalThis),
  defaultHeaders: {
    "Content-Type": "application/json",
    Accept: "application/json"
  }
};

async function request<T>({
  endpoint,
  payload,
  schema,
  config
}: {
  endpoint: string;
  payload: unknown;
  schema: z.ZodType<T>;
  config: Required<MystClientConfig>;
}): Promise<T> {
  const response = await config.fetchImpl(config.baseUrl + endpoint, {
    method: "POST",
    headers: config.defaultHeaders,
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Stonegate SDK request failed (${response.status}): ${errorBody}`);
  }

  const data = await response.json();
  const parsed = schema.safeParse(data);

  if (!parsed.success) {
    throw parsed.error;
  }

  return parsed.data;
}

export class MystSDK {
  private readonly config: Required<MystClientConfig>;

  constructor(config: MystClientConfig = {}) {
    this.config = {
      ...defaultConfig,
      ...config,
      defaultHeaders: { ...defaultConfig.defaultHeaders, ...config.defaultHeaders }
    };
  }

  async leadIntake(input: LeadIntakeRequest): Promise<LeadIntakeResponse> {
    const payload = leadIntakeRequestSchema.parse(input);
    return request({
      endpoint: "/lead-intake",
      payload,
      schema: leadIntakeResponseSchema,
      config: this.config
    });
  }

  async quoteRequest(input: QuoteRequest): Promise<QuoteResponse> {
    const payload = quoteRequestSchema.parse(input);
    return request({
      endpoint: "/quote-request",
      payload,
      schema: quoteResponseSchema,
      config: this.config
    });
  }

  async payDeposit(input: PayDepositRequest): Promise<PayDepositResponse> {
    const payload = payDepositRequestSchema.parse(input);
    return request({
      endpoint: "/pay-deposit",
      payload,
      schema: payDepositResponseSchema,
      config: this.config
    });
  }
}

