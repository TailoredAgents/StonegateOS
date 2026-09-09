import { createServer } from "node:net";
import { hasPartnerPdfSignature, scanPartnerPdfBytes } from "@/lib/partner-document-scan";

const pdf = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
describe("private partner document scan protocol", () => {
  it("rejects invalid signatures, incomplete PDFs, and oversized files", () => {
    expect(hasPartnerPdfSignature(pdf)).toBe(true);
    expect(hasPartnerPdfSignature(Buffer.from("<html>not a PDF</html>"))).toBe(false);
    expect(hasPartnerPdfSignature(Buffer.from("%PDF-1.7\ntruncated"))).toBe(false);
    expect(hasPartnerPdfSignature(Buffer.alloc(10 * 1024 * 1024 + 1))).toBe(false);
  });
  for (const [reply, expected] of [["stream: OK\0", "clean"], ["stream: Eicar-Test-Signature FOUND\0", "infected"], ["stream: size limit exceeded ERROR\0", "error"], ["unrecognized\0", "error"]] as const) {
    it(`frames bounded INSTREAM bytes and fails closed for ${expected}`, async () => {
      const previous = { host: process.env["PARTNER_CLAMAV_HOST"], port: process.env["PARTNER_CLAMAV_PORT"], socket: process.env["PARTNER_CLAMAV_SOCKET"] };
      let received = Buffer.alloc(0);
      const server = createServer((socket) => {
        socket.on("data", (chunk) => {
          received = Buffer.concat([received, chunk]);
          const expectedLength = Buffer.byteLength("zINSTREAM\0") + 4 + pdf.length + 4;
          if (received.length >= expectedLength) socket.end(reply);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const address = server.address(); if (!address || typeof address === "string") throw new Error("listen_failed");
      process.env["PARTNER_CLAMAV_HOST"] = "127.0.0.1"; process.env["PARTNER_CLAMAV_PORT"] = String(address.port); delete process.env["PARTNER_CLAMAV_SOCKET"];
      try {
        if (expected === "error") await expect(scanPartnerPdfBytes(pdf)).rejects.toThrow("partner_document_scan_not_clean");
        else await expect(scanPartnerPdfBytes(pdf)).resolves.toBe(expected);
        expect(received.subarray(0, 10).toString()).toBe("zINSTREAM\0");
        expect(received.readUInt32BE(10)).toBe(pdf.length);
        expect(received.subarray(14, 14 + pdf.length)).toEqual(pdf);
        expect(received.readUInt32BE(received.length - 4)).toBe(0);
      } finally {
        for (const [key, value] of Object.entries({ PARTNER_CLAMAV_HOST: previous.host, PARTNER_CLAMAV_PORT: previous.port, PARTNER_CLAMAV_SOCKET: previous.socket })) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
  }
});
