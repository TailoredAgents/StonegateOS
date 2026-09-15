import { isControlledProviderTestRuntime } from "@myst-os/sdk";
import { z } from "zod";

type Environment = Readonly<Record<string, string | undefined>>;

const hashList = z
  .array(z.string().regex(/^[a-f0-9]{64}$/u))
  .min(1)
  .max(3);
const placeList = z.array(z.string().trim().min(1).max(128)).min(1).max(3);
const userSchema = z
  .object({
    obref: z.string().min(1).max(1024).optional(),
    phone_numbers_sha256: hashList.optional(),
    emails_sha256: hashList.optional(),
    external_ids_sha256: hashList.optional(),
    first_names_sha256: hashList.optional(),
    last_names_sha256: hashList.optional(),
    regions: placeList.optional(),
    postal_codes: placeList.optional(),
    cities: placeList.optional(),
    countries: z
      .array(z.string().regex(/^[A-Z]{2}$/u))
      .min(1)
      .max(3)
      .optional(),
    ip_address: z.string().ip().optional(),
    user_agent: z.string().min(1).max(2048).optional(),
  })
  .strict();

const sourceUrlSchema = z
  .string()
  .max(2048)
  .url()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["https:", "http:"].includes(url.protocol) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  });

const eventSchema = z
  .object({
    id: z.string().min(1).max(256),
    type: z.enum(["appointment_scheduled", "lead_created", "custom"]),
    timestamp_ms: z.number().int().positive(),
    action_source: z.enum([
      "web",
      "phone_call",
      "offline",
      "physical_store",
      "email",
      "other",
    ]),
    source_url: sourceUrlSchema.optional(),
    oppref: z.string().min(1).max(4096).optional(),
    custom_event_name: z
      .string()
      .regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9_-]{0,62}[a-zA-Z0-9])?$/u)
      .optional(),
    user: userSchema.optional(),
    opt_out: z.boolean().optional(),
    data: z
      .object({
        type: z.enum(["customer_action", "custom"]),
        amount: z.number().int().nonnegative().optional(),
        currency: z
          .string()
          .regex(/^[A-Z]{3}$/u)
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((event, context) => {
    if (event.action_source === "web" && !event.source_url) {
      context.addIssue({ code: "custom", message: "web_source_url_required" });
    }
    if (event.data.amount !== undefined && !event.data.currency) {
      context.addIssue({ code: "custom", message: "currency_required" });
    }
    if (event.type === "custom") {
      if (!event.custom_event_name || event.data.type !== "custom") {
        context.addIssue({
          code: "custom",
          message: "custom_event_shape_invalid",
        });
      }
    } else if (
      event.data.type !== "customer_action" ||
      event.custom_event_name
    ) {
      context.addIssue({
        code: "custom",
        message: "customer_action_shape_invalid",
      });
    }
  });

export type OpenAiAdsUser = z.infer<typeof userSchema>;
export type OpenAiAdsEvent = z.infer<typeof eventSchema>;
export const OPENAI_ADS_OUTBOX_EVENT = "ads.openai.conversion";
export const OPENAI_ADS_MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const OPENAI_ADS_TIMEOUT_MS = 8_000;

export function parseOpenAiAdsEvent(value: unknown): OpenAiAdsEvent | null {
  const result = eventSchema.safeParse(value);
  return result.success ? result.data : null;
}

function enabled(value: string | undefined): boolean {
  return ["1", "true", "on"].includes(value?.trim().toLowerCase() ?? "");
}

/** Safe for status responses: includes names and public Pixel ID, never secrets. */
export function inspectOpenAiAdsConfiguration(
  environment: Environment = process.env,
) {
  const pixelId = environment["OPENAI_ADS_PIXEL_ID"]?.trim() ?? "";
  const apiKey = environment["OPENAI_ADS_CONVERSIONS_API_KEY"]?.trim() ?? "";
  const missing = [
    ...(!pixelId ? ["OPENAI_ADS_PIXEL_ID"] : []),
    ...(!apiKey ? ["OPENAI_ADS_CONVERSIONS_API_KEY"] : []),
  ];
  const invalid =
    pixelId && !/^[a-zA-Z0-9_-]{1,128}$/u.test(pixelId)
      ? ["OPENAI_ADS_PIXEL_ID"]
      : [];
  let testRuntimeBlocked = false;
  try {
    testRuntimeBlocked = isControlledProviderTestRuntime(environment);
  } catch {
    testRuntimeBlocked = true;
  }
  return {
    enabled: enabled(environment["OPENAI_ADS_ENABLED"]),
    configured: missing.length === 0 && invalid.length === 0,
    pixelId: invalid.length === 0 ? pixelId || null : null,
    missing,
    invalid,
    testRuntimeBlocked,
  };
}

export type OpenAiAdsDeliveryResult =
  | { ok: true }
  | { ok: false; retryable: boolean; code: string; retryAfterMs?: number };

/**
 * Only this fixed provider origin receives credentials. No endpoint override or
 * redirect is allowed. In audit/E2E runtimes real conversions are never sent.
 * Response bodies and thrown fetch errors may contain PII; never persist them.
 */
export async function sendOpenAiAdsConversion(
  event: OpenAiAdsEvent,
  options: {
    environment?: Environment;
    fetchImpl?: typeof fetch;
    validateOnly?: boolean;
  } = {},
): Promise<OpenAiAdsDeliveryResult> {
  const environment = options.environment ?? process.env;
  const configuration = inspectOpenAiAdsConfiguration(environment);
  if (!configuration.enabled) {
    return { ok: false, retryable: true, code: "openai_ads_disabled" };
  }
  if (
    enabled(environment["TEAM_KILL_EXTERNAL_SENDS"]) ||
    enabled(environment["TEAM_KILL_OUTBOX_DISPATCH"])
  ) {
    return { ok: false, retryable: true, code: "openai_ads_dispatch_disabled" };
  }
  if (configuration.testRuntimeBlocked) {
    return {
      ok: false,
      retryable: true,
      code: "openai_ads_test_runtime_blocked",
    };
  }
  if (!configuration.configured) {
    return {
      ok: false,
      retryable: true,
      code: "openai_ads_configuration_missing",
    };
  }
  const parsed = parseOpenAiAdsEvent(event);
  if (!parsed) {
    return { ok: false, retryable: false, code: "openai_ads_event_invalid" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), OPENAI_ADS_TIMEOUT_MS);
  try {
    const url = new URL("https://bzr.openai.com/v1/events");
    url.searchParams.set("pid", configuration.pixelId!);
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: "POST",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${environment["OPENAI_ADS_CONVERSIONS_API_KEY"]!.trim()}`,
        "Content-Type": "application/json",
        "User-Agent": "StonegateOS-Ads/1.0",
      },
      body: JSON.stringify({
        validate_only: options.validateOnly === true,
        integration_source: "stonegateos",
        events: [parsed],
      }),
    });
    if (response.ok) {
      const acknowledgement: unknown = await response.json().catch(() => null);
      if (
        acknowledgement &&
        typeof acknowledgement === "object" &&
        "accepted_events" in acknowledgement &&
        acknowledgement.accepted_events === 1
      ) {
        return { ok: true };
      }
      // Retrying an ambiguous acknowledgement is safe with the same event ID.
      return {
        ok: false,
        retryable: true,
        code: controller.signal.aborted
          ? "openai_ads_timeout"
          : "openai_ads_acknowledgement_invalid",
      };
    }
    // Discard error bodies: they can contain request data and are not useful
    // for classification. Only the HTTP status is retained for diagnostics.
    void response.body?.cancel().catch(() => undefined);
    const retryable =
      [401, 403, 408, 425, 429].includes(response.status) ||
      response.status >= 500;
    const rawRetryAfter = response.headers.get("retry-after");
    const retryAfterSeconds =
      rawRetryAfter && /^\d+$/u.test(rawRetryAfter)
        ? Number(rawRetryAfter)
        : null;
    const retryAfterMs =
      retryAfterSeconds === null
        ? undefined
        : Math.min(60 * 60_000, Math.max(60_000, retryAfterSeconds * 1000));
    return {
      ok: false,
      retryable,
      code: `openai_ads_http_${response.status}`,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  } catch {
    return {
      ok: false,
      retryable: true,
      code: controller.signal.aborted
        ? "openai_ads_timeout"
        : "openai_ads_transport_error",
    };
  } finally {
    clearTimeout(timeout);
  }
}
