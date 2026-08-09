import type { NextRequest } from "next/server";
import {
  BoundedJsonRequestError,
  readBoundedJsonRequest,
} from "@/lib/bounded-json-request";

function jsonRequest(
  body: BodyInit | null,
  headers: HeadersInit = {},
): NextRequest {
  return new Request("https://api.test/public", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  }) as NextRequest;
}

describe("bounded public JSON request reader", () => {
  it("reads one complete JSON body", async () => {
    await expect(
      readBoundedJsonRequest(jsonRequest('{"email":"a@example.test"}'), {
        maximumBytes: 64,
      }),
    ).resolves.toEqual({ email: "a@example.test" });
  });

  it.each([
    ["text/plain", "{}", "unsupported_media_type", 415],
    ["application/json", "not-json", "invalid_body", 400],
    ["application/json", "{}", "body_too_large", 413],
  ])(
    "rejects %s payloads truthfully",
    async (contentType, body, code, status) => {
      const request = jsonRequest(body, {
        "content-type": contentType,
        ...(code === "body_too_large" ? { "content-length": "100" } : {}),
      });
      await expect(
        readBoundedJsonRequest(request, { maximumBytes: 16 }),
      ).rejects.toMatchObject({ code, status });
    },
  );

  it("rejects a streamed body once the actual byte limit is crossed", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"'));
        controller.enqueue(new TextEncoder().encode("x".repeat(100)));
        controller.close();
      },
    });
    const request = new Request("https://api.test/public", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit & { duplex: "half" }) as NextRequest;
    await expect(
      readBoundedJsonRequest(request, { maximumBytes: 32 }),
    ).rejects.toBeInstanceOf(BoundedJsonRequestError);
  });

  it.each([
    ['{"query":{},"query":{}}', "same spelling"],
    ['{"query":{"data":"first","data":"second"}}', "nested key"],
    ['{"query":1,"\\u0071uery":2}', "escaped-equivalent spelling"],
  ])("rejects duplicate object keys using %s (%s)", async (body) => {
    await expect(
      readBoundedJsonRequest(jsonRequest(body), {
        maximumBytes: 256,
        rejectDuplicateObjectKeys: true,
      }),
    ).rejects.toMatchObject({ code: "invalid_body", status: 400 });
  });

  it("preserves legacy last-key behavior unless strict duplicate rejection is requested", async () => {
    await expect(
      readBoundedJsonRequest(jsonRequest('{"value":1,"value":2}'), {
        maximumBytes: 64,
      }),
    ).resolves.toEqual({ value: 2 });
  });
});
