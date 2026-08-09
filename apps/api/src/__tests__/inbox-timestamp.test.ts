import { toInboxIso } from "@/lib/inbox-timestamp";

describe("Inbox timestamp normalization", () => {
  it("normalizes Date objects and PostgreSQL timestamp strings", () => {
    expect(toInboxIso(new Date("2026-08-09T10:57:00.125Z"))).toBe(
      "2026-08-09T10:57:00.125Z",
    );
    expect(toInboxIso("2026-08-09T06:57:00.125-04:00")).toBe(
      "2026-08-09T10:57:00.125Z",
    );
    expect(toInboxIso("2026-08-09 10:57:00.125+00")).toBe(
      "2026-08-09T10:57:00.125Z",
    );
  });

  it("preserves nullable fields and rejects malformed database values", () => {
    expect(toInboxIso(null)).toBeNull();
    expect(toInboxIso(undefined)).toBeNull();
    expect(() => toInboxIso("not-a-timestamp")).toThrow(
      "Inbox timestamp is not a valid database timestamp.",
    );
    expect(() => toInboxIso(new Date(Number.NaN))).toThrow(
      "Inbox timestamp is not a valid database timestamp.",
    );
  });
});
