export type ToolName = "booking_suggest";

export type BookingSuggestResult = {
  suggestions: Array<{
    start: string;
    end: string;
    reason: string;
  }>;
};

export async function fetchBookingSuggestions(
  adminKey: string,
  apiBase: string
): Promise<BookingSuggestResult | null> {
  try {
    const res = await fetch(`${apiBase.replace(/\/$/, "")}/api/admin/booking/assist`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": adminKey
      },
      body: JSON.stringify({})
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { suggestions?: Array<{ startAt?: string; endAt?: string; reason?: string }> };
    const suggestions =
      data.suggestions
        ?.slice(0, 3)
        .map((s) => ({
          start: s.startAt ? new Date(s.startAt).toLocaleString() : "TBD",
          end: s.endAt ? new Date(s.endAt).toLocaleString() : "TBD",
          reason: s.reason ?? "No conflicts"
        })) ?? [];
    return { suggestions };
  } catch (error) {
    console.warn("[chat] booking_suggest_failed", { error: String(error) });
    return null;
  }
}
