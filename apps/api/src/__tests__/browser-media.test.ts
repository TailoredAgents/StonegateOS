import type { BrowserMediaError } from "@/lib/browser-media";
import {
  buildSafeBrowserMediaResponse,
  detectSafeInlineMediaType,
  readBoundedBrowserMedia,
  sanitizeMediaFilename,
} from "@/lib/browser-media";

const png = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
]);

describe("browser media containment", () => {
  it("permits inline rendering only when an allowlisted MIME matches magic bytes", async () => {
    expect(detectSafeInlineMediaType(png)).toBe("image/png");
    const response = buildSafeBrowserMediaResponse({
      bytes: png,
      declaredContentType: "image/png; charset=binary",
      filename: "customer photo.png",
    });
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("content-disposition")).toBe(
      'inline; filename="customer_photo.png"',
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(png);
  });

  it.each([
    [new TextEncoder().encode("<svg onload=alert(1)></svg>"), "image/svg+xml"],
    [new TextEncoder().encode("<script>alert(1)</script>"), "image/png"],
    [png, "text/html"],
  ])("forces unknown or mismatched content to download", (bytes, declared) => {
    const response = buildSafeBrowserMediaResponse({
      bytes,
      declaredContentType: declared,
      filename: "unsafe.svg\r\nX-Injected: yes",
    });
    expect(response.headers.get("content-type")).toBe(
      "application/octet-stream",
    );
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="media.bin"',
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("bounds declared and streamed response bytes", async () => {
    await expect(
      readBoundedBrowserMedia(
        new Response("x", { headers: { "content-length": "11" } }),
        10,
      ),
    ).rejects.toMatchObject<BrowserMediaError>({
      code: "media_too_large",
      status: 413,
    });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3, 4, 5, 6]));
        controller.enqueue(Uint8Array.from([7, 8, 9, 10, 11]));
        controller.close();
      },
    });
    await expect(
      readBoundedBrowserMedia(new Response(stream), 10),
    ).rejects.toMatchObject<BrowserMediaError>({
      code: "media_too_large",
      status: 413,
    });
  });

  it("sanitizes untrusted filenames", () => {
    expect(sanitizeMediaFilename("../../evil\r\nname?.png")).toBe(
      "evil_name_.png",
    );
  });
});
