import {
  MAX_TWILIO_INBOUND_MEDIA_URLS,
  parseTwilioInboundMedia,
} from "@/lib/twilio-inbound-media";

function form(entries: Array<[string, string]>): FormData {
  const data = new FormData();
  for (const [key, value] of entries) data.append(key, value);
  return data;
}

describe("bounded Twilio inbound media", () => {
  it("accepts absent, zero, and exactly ten declared media URLs", () => {
    expect(parseTwilioInboundMedia(new FormData())).toEqual({
      ok: true,
      count: 0,
      mediaUrls: [],
    });
    expect(parseTwilioInboundMedia(form([["NumMedia", "0"]]))).toEqual({
      ok: true,
      count: 0,
      mediaUrls: [],
    });
    const entries: Array<[string, string]> = [
      ["NumMedia", String(MAX_TWILIO_INBOUND_MEDIA_URLS)],
    ];
    for (let index = 0; index < MAX_TWILIO_INBOUND_MEDIA_URLS; index += 1) {
      entries.push([`MediaUrl${index}`, `https://media.example/${index}`]);
    }
    expect(parseTwilioInboundMedia(form(entries))).toEqual({
      ok: true,
      count: MAX_TWILIO_INBOUND_MEDIA_URLS,
      mediaUrls: Array.from(
        { length: MAX_TWILIO_INBOUND_MEDIA_URLS },
        (_, index) => `https://media.example/${index}`,
      ),
    });
  });

  it.each(["", "-1", "+1", "01", "1.0", "1e1", "NaN", "Infinity"])(
    "rejects noncanonical NumMedia %j",
    (value) => {
      expect(parseTwilioInboundMedia(form([["NumMedia", value]]))).toEqual({
        ok: false,
        code: "twilio_num_media_invalid",
      });
    },
  );

  it("rejects an over-limit count without iterating provider media fields", () => {
    expect(
      parseTwilioInboundMedia(
        form([
          ["NumMedia", String(MAX_TWILIO_INBOUND_MEDIA_URLS + 1)],
          ["MediaUrl0", "https://media.example/0"],
        ]),
      ),
    ).toEqual({
      ok: false,
      code: "twilio_num_media_exceeds_limit",
    });
  });

  it("requires exactly one nonempty URL for every declared index", () => {
    expect(parseTwilioInboundMedia(form([["NumMedia", "1"]]))).toEqual({
      ok: false,
      code: "twilio_media_url_missing",
    });
    expect(
      parseTwilioInboundMedia(
        form([
          ["NumMedia", "1"],
          ["MediaUrl0", "https://media.example/a"],
          ["MediaUrl0", "https://media.example/b"],
        ]),
      ),
    ).toEqual({
      ok: false,
      code: "twilio_media_url_missing",
    });
  });
});
