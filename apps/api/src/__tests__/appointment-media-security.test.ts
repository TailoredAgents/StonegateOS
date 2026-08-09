import { createServer } from "node:http";

import {
  assertSafeRemoteMediaUrl,
  createPinnedRemoteMediaAgent,
  fetchRemoteImage,
  isAllowedRemoteMediaProviderHost,
  REMOTE_MEDIA_FETCH_TIMEOUT_MS,
} from "@/lib/appointment-media";
import { MAX_APPOINTMENT_IMAGE_BYTES } from "@/lib/appointment-image";
import { fetch as undiciFetch } from "undici";

describe("remote appointment media URL policy", () => {
  const originalNodeEnv = process.env["NODE_ENV"];
  const originalFetch = globalThis.fetch;
  const originalTwilioEnvironment = {
    E2E_RUN_ID: process.env["E2E_RUN_ID"],
    TWILIO_ACCOUNT_SID: process.env["TWILIO_ACCOUNT_SID"],
    TWILIO_AUTH_TOKEN: process.env["TWILIO_AUTH_TOKEN"],
    TWILIO_API_BASE_URL: process.env["TWILIO_API_BASE_URL"],
  };

  beforeEach(() => {
    Object.defineProperty(process.env, "NODE_ENV", {
      configurable: true,
      value: "production",
      writable: true,
    });
    process.env["E2E_RUN_ID"] = "appointment-media-security";
    process.env["TWILIO_ACCOUNT_SID"] = `AC${"0".repeat(32)}`;
    process.env["TWILIO_AUTH_TOKEN"] = "synthetic-token";
    process.env["TWILIO_API_BASE_URL"] = "http://127.0.0.1";
  });

  afterEach(() => {
    jest.useRealTimers();
    globalThis.fetch = originalFetch;
    Object.defineProperty(process.env, "NODE_ENV", {
      configurable: true,
      value: originalNodeEnv,
      writable: true,
    });
    for (const [key, value] of Object.entries(originalTwilioEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("allows provider-owned media hosts without accepting deceptive suffixes", () => {
    expect(isAllowedRemoteMediaProviderHost("api.twilio.com", "twilio")).toBe(
      true,
    );
    expect(
      isAllowedRemoteMediaProviderHost("media.twiliocdn.com", "twilio"),
    ).toBe(true);
    expect(
      isAllowedRemoteMediaProviderHost("s3-external-1.amazonaws.com", "twilio"),
    ).toBe(true);
    expect(
      isAllowedRemoteMediaProviderHost("attacker.amazonaws.com", "twilio"),
    ).toBe(false);
    expect(
      isAllowedRemoteMediaProviderHost(
        "scontent-lga3-2.xx.fbcdn.net",
        "facebook",
      ),
    ).toBe(true);
    expect(
      isAllowedRemoteMediaProviderHost(
        "platform-lookaside.fbsbx.com",
        "facebook",
      ),
    ).toBe(true);
    expect(
      isAllowedRemoteMediaProviderHost(
        "api.twilio.com.attacker.example",
        "twilio",
      ),
    ).toBe(false);
    expect(
      isAllowedRemoteMediaProviderHost(
        "facebook.com.attacker.example",
        "facebook",
      ),
    ).toBe(false);
  });

  it("rejects a provider URL outside its allowlist before fetching", async () => {
    await expect(
      assertSafeRemoteMediaUrl(
        "https://api.twilio.com.attacker.example/photo.jpg",
        "twilio",
      ),
    ).rejects.toThrow("remote_media_provider_host_forbidden");
  });

  it("rejects insecure schemes and credential-bearing URLs", async () => {
    await expect(
      assertSafeRemoteMediaUrl("http://example.com/photo.jpg"),
    ).rejects.toThrow("remote_media_url_forbidden");
    await expect(
      assertSafeRemoteMediaUrl(
        "https://username:password@example.com/photo.jpg",
      ),
    ).rejects.toThrow("remote_media_url_forbidden");
  });

  it("rejects loopback and private-network targets", async () => {
    await expect(
      assertSafeRemoteMediaUrl("https://127.0.0.1/photo.jpg"),
    ).rejects.toThrow("remote_media_host_forbidden");
    await expect(
      assertSafeRemoteMediaUrl("https://10.10.1.4/photo.jpg"),
    ).rejects.toThrow("remote_media_host_forbidden");
    await expect(
      assertSafeRemoteMediaUrl("https://[::1]/photo.jpg"),
    ).rejects.toThrow("remote_media_host_forbidden");
    await expect(
      assertSafeRemoteMediaUrl("https://[::ffff:172.16.0.1]/photo.jpg"),
    ).rejects.toThrow("remote_media_host_forbidden");
    await expect(
      assertSafeRemoteMediaUrl("https://[ff02::1]/photo.jpg"),
    ).rejects.toThrow("remote_media_host_forbidden");
  });

  it.each([
    "192.0.2.1",
    "198.18.0.1",
    "198.51.100.7",
    "203.0.113.9",
    "240.0.0.1",
  ])("rejects reserved or documentation IPv4 target %s", async (address) => {
    await expect(
      assertSafeRemoteMediaUrl(`https://${address}/photo.jpg`),
    ).rejects.toThrow("remote_media_host_forbidden");
  });

  it.each([
    "2001:db8::1",
    "2002:c0a8:1::",
    "3fff::1",
    "5f00::1",
    "fec0::1",
    "64:ff9b::c0a8:1",
  ])(
    "rejects reserved, local, or transition IPv6 target %s",
    async (address) => {
      await expect(
        assertSafeRemoteMediaUrl(`https://[${address}]/photo.jpg`),
      ).rejects.toThrow("remote_media_host_forbidden");
    },
  );

  it("allows representative globally routed literal addresses", async () => {
    await expect(
      assertSafeRemoteMediaUrl("https://8.8.8.8/photo.jpg"),
    ).resolves.toBeInstanceOf(URL);
    await expect(
      assertSafeRemoteMediaUrl("https://[2606:4700:4700::1111]/photo.jpg"),
    ).resolves.toBeInstanceOf(URL);
  });

  it("uses a prevalidated scalar address with Node 20's real connector", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("pinned");
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error);
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP test server");
    }
    const dispatcher = createPinnedRemoteMediaAgent({
      address: "127.0.0.1",
      family: 4,
    });
    try {
      const response = await undiciFetch(
        `http://media-import.invalid:${address.port}/photo`,
        { dispatcher },
      );
      await expect(response.text()).resolves.toBe("pinned");
    } finally {
      await dispatcher.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("revalidates provider host policy after every redirect", async () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      configurable: true,
      value: "test",
      writable: true,
    });
    globalThis.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: {
            location: "https://media.attacker.example/photo.jpg",
          },
        }),
      ),
    ) as typeof fetch;

    await expect(
      fetchRemoteImage({
        url: "http://127.0.0.1/twilio-media",
        provider: "twilio",
      }),
    ).rejects.toThrow("remote_media_provider_host_forbidden");
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an oversized response before buffering it", async () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      configurable: true,
      value: "test",
      writable: true,
    });
    globalThis.fetch = jest.fn(() =>
      Promise.resolve(
        new Response(new Uint8Array([1]), {
          status: 200,
          headers: {
            "content-length": String(MAX_APPOINTMENT_IMAGE_BYTES + 1),
            "content-type": "image/jpeg",
          },
        }),
      ),
    ) as typeof fetch;

    await expect(
      fetchRemoteImage({
        url: "http://127.0.0.1/oversized-photo",
        provider: "twilio",
      }),
    ).rejects.toThrow("remote_media_too_large");
  });

  it("aborts a remote media request at the fixed timeout", async () => {
    Object.defineProperty(process.env, "NODE_ENV", {
      configurable: true,
      value: "test",
      writable: true,
    });
    jest.useFakeTimers();
    globalThis.fetch = jest.fn(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        }),
    ) as typeof fetch;

    const rejection = expect(
      fetchRemoteImage({
        url: "http://127.0.0.1/slow-photo",
        provider: "facebook",
      }),
    ).rejects.toThrow("remote_media_fetch_timeout");
    await jest.advanceTimersByTimeAsync(REMOTE_MEDIA_FETCH_TIMEOUT_MS);
    await rejection;
  });
});
