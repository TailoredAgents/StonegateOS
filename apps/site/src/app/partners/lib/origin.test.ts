import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { resolvePublicOrigin } from "./origin";
import { POST as portalPost } from "../../api/partners/portal/[...segments]/route";
import { POST as nativeFormPost } from "../form/route";
import { middleware } from "../../../middleware";

void test("preserves the configured browser loopback origin without trusting forwarding headers", () => {
  const request = new NextRequest("http://127.0.0.1:3100/partners", {
    headers: {
      host: "127.0.0.1:3100",
      origin: "http://127.0.0.1:3100",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    },
  });
  assert.equal(
    request.nextUrl.origin,
    "http://localhost:3100",
    "Exercise NextURL's actual normalization",
  );
  assert.equal(
    resolvePublicOrigin(request, {
      configuredSiteUrls: ["http://127.0.0.1:3100"],
    }),
    "http://127.0.0.1:3100",
  );
  assert.equal(
    resolvePublicOrigin(request, {
      configuredSiteUrls: ["http://127.0.0.1:3200"],
    }),
    "http://localhost:3100",
  );
  const ordinary = new NextRequest("https://stonegate.example/partners", {
    headers: { host: "stonegate.example", "x-forwarded-host": "evil.example" },
  });
  assert.equal(
    resolvePublicOrigin(ordinary, {
      configuredSiteUrls: ["https://stonegate.example"],
    }),
    "https://stonegate.example",
  );
  for (const host of [
    "stonegate.example.evil.example",
    "stonegate.example@evil.example",
    "stonegate.example,evil.example",
    "stonegate.example/path",
  ]) {
    const malformed = new NextRequest("https://safe.example/partners", {
      headers: { host, origin: "https://stonegate.example" },
    });
    assert.equal(
      resolvePublicOrigin(malformed, {
        configuredSiteUrls: ["https://stonegate.example"],
      }),
      "https://safe.example",
    );
  }
});

void test("local mutations retain strict Origin checks and purpose redirects stay on the cookie host", async () => {
  const previous = process.env["SITE_URL"];
  process.env["SITE_URL"] = "http://127.0.0.1:3100";
  try {
    for (const origin of [
      "http://127.0.0.1:3100",
      "http://127.0.0.1:3200",
      "https://127.0.0.1:3100",
      "null",
      "https://evil.example",
    ]) {
      const request = new NextRequest(
        "http://127.0.0.1:3100/api/partners/portal/bad",
        {
          method: "POST",
          headers: {
            host: "127.0.0.1:3100",
            origin,
            "sec-fetch-site": "same-origin",
          },
        },
      );
      const response = await portalPost(request, {
        params: Promise.resolve({ segments: ["invalid/path"] }),
      });
      assert.equal(
        response.status,
        origin === "http://127.0.0.1:3100" ? 400 : 403,
        "Reject spoofed origins even with same-origin fetch metadata",
      );
    }
    const native = await nativeFormPost(
      new NextRequest("http://127.0.0.1:3100/partners/form", {
        method: "POST",
        headers: {
          host: "127.0.0.1:3100",
          origin: "http://127.0.0.1:3100",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
    assert.equal(
      native.status,
      415,
      "Origin accepted; intentionally invalid content type rejected before credentials",
    );
    const redirect = await middleware(
      new NextRequest(
        "http://127.0.0.1:3100/partners/activate?token=" + "A".repeat(43),
        { headers: { host: "127.0.0.1:3100" } },
      ),
    );
    assert.equal(
      redirect.headers.get("location"),
      "http://127.0.0.1:3100/partners/activate",
    );
    assert.equal(redirect.headers.get("referrer-policy"), "no-referrer");
  } finally {
    if (previous === undefined) delete process.env["SITE_URL"];
    else process.env["SITE_URL"] = previous;
  }
});
