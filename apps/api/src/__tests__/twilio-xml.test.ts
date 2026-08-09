import {
  escapeTwilioXmlText,
  stripXml10InvalidCharacters,
} from "@/lib/twilio-xml";

describe("TwiML XML 1.0 encoding", () => {
  it("removes forbidden controls and lone surrogates while retaining legal Unicode", () => {
    const value = `A\u0000B\tC\u000bD\u001fE😀\ud800\ufffe\uffff`;
    expect(stripXml10InvalidCharacters(value)).toBe("AB\tCDE😀");
  });

  it("escapes all XML text and quoted-attribute metacharacters after sanitizing", () => {
    expect(escapeTwilioXmlText(`A\u0000&B<C>D"E'F`)).toBe(
      "A&amp;B&lt;C&gt;D&quot;E&apos;F",
    );
  });

  it("retains the only legal C0 whitespace characters", () => {
    expect(escapeTwilioXmlText("tab\there\nline\rreturn")).toBe(
      "tab\there\nline\rreturn",
    );
  });
});
