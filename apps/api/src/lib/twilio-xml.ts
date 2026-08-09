/** Remove code points forbidden by the XML 1.0 Char production. */
export function stripXml10InvalidCharacters(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint === 0x09 ||
      codePoint === 0x0a ||
      codePoint === 0x0d ||
      (typeof codePoint === "number" &&
        ((codePoint >= 0x20 && codePoint <= 0xd7ff) ||
          (codePoint >= 0xe000 && codePoint <= 0xfffd) ||
          (codePoint >= 0x10000 && codePoint <= 0x10ffff)))
    ) {
      safe += character;
    }
  }
  return safe;
}

/** Encode untrusted text for both TwiML text nodes and quoted attributes. */
export function escapeTwilioXmlText(value: string): string {
  return stripXml10InvalidCharacters(value)
    .replace(/&/gu, "&amp;")
    .replace(/</gu, "&lt;")
    .replace(/>/gu, "&gt;")
    .replace(/"/gu, "&quot;")
    .replace(/'/gu, "&apos;");
}
