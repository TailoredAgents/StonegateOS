import {
  sanitizeAnalyticsProviderEventName,
  sanitizeAnalyticsProviderParams,
} from "./analytics-privacy";

const GA_ENDPOINT = "https://www.google-analytics.com/mp/collect";

interface ConversionPayload {
  params?: Record<string, unknown>;
}

export async function sendConversion(
  eventName: string,
  payload: ConversionPayload = {},
): Promise<void> {
  const measurementId = process.env["GA4_MEASUREMENT_ID"];
  const apiSecret = process.env["GA4_API_SECRET"];

  if (!measurementId || !apiSecret) {
    return;
  }
  const safeEventName = sanitizeAnalyticsProviderEventName(eventName);
  if (!safeEventName) return;

  try {
    const body = {
      // This constant satisfies GA's transport contract without identifying a
      // visitor, customer, contact, conversation, or CRM record.
      client_id: "stonegate-public-web-aggregate",
      events: [
        {
          name: safeEventName,
          params: {
            engagement_time_msec: 1,
            ...sanitizeAnalyticsProviderParams(payload.params),
          },
        },
      ],
    };

    await fetch(
      `${GA_ENDPOINT}?measurement_id=${measurementId}&api_secret=${apiSecret}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
  } catch (error) {
    console.warn("GA4 conversion tracking failed", error);
  }
}
