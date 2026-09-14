import type { Browser } from "@playwright/test";

export type ProbeTransportMode = "native" | "chromium";
export type ProbeHttpResponse = { status: number; text: string | null };
type RequestOptions = {
  headers: Headers;
  timeoutMs: number;
  readBody: boolean;
};

export class ProbeTransportError extends Error {
  constructor(
    readonly code:
      | "probe_transport_timeout"
      | "unexpected_response_size"
      | "unexpected_browser_request"
      | "browser_forwarding_headers_not_applied"
      | "missing_response_body",
  ) {
    super(code);
    this.name = "ProbeTransportError";
  }
}

export type ProbeTransport = {
  request(url: URL, options: RequestOptions): Promise<ProbeHttpResponse>;
  close(): Promise<void>;
};

const BODY_LIMIT = 8192;

async function boundedText(response: Response): Promise<string> {
  if (!response.body) throw new ProbeTransportError("missing_response_body");
  const reader = response.body.getReader();
  const buffers: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > BODY_LIMIT)
        throw new ProbeTransportError("unexpected_response_size");
      buffers.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(buffers).toString("utf8");
}

async function browserRequest(
  browser: Browser,
  url: URL,
  options: RequestOptions,
): Promise<ProbeHttpResponse> {
  // No existing profile, cookies, authentication, recordings, or service worker.
  // A new context for every request also prevents trace cookies reaching probes.
  const requestHeaders: Record<string, string> = {};
  options.headers.forEach((value, key) => {
    requestHeaders[key] = value;
  });
  const context = await browser.newContext({
    serviceWorkers: "block",
    extraHTTPHeaders: {
      ...requestHeaders,
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
    },
  });
  let unexpectedRequest = false;
  let requested = false;
  await context.route("**/*", async (route) => {
    const request = route.request();
    if (
      request.url() !== url.href ||
      request.method() !== "GET" ||
      request.redirectedFrom() ||
      !request.isNavigationRequest() ||
      requested
    ) {
      unexpectedRequest = true;
      await route.abort("blockedbyclient");
      return;
    }
    requested = true;
    await route.continue({
      headers: { ...request.headers(), ...requestHeaders },
    });
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const page = await context.newPage();
        const response = await page.goto(url.href, {
          waitUntil: "commit",
          timeout: options.timeoutMs,
        });
        if (!response || unexpectedRequest || response.url() !== url.href)
          throw new ProbeTransportError("unexpected_browser_request");
        const sentHeaders = await response.request().allHeaders();
        for (const [key, value] of Object.entries(requestHeaders)) {
          if (sentHeaders[key.toLowerCase()] !== value)
            throw new ProbeTransportError(
              "browser_forwarding_headers_not_applied",
            );
        }
        let text: string | null = null;
        if (options.readBody) {
          const length = Number(response.headers()["content-length"]);
          if (Number.isFinite(length) && length > BODY_LIMIT)
            throw new ProbeTransportError("unexpected_response_size");
          const body = await response.body();
          if (body.length > BODY_LIMIT)
            throw new ProbeTransportError("unexpected_response_size");
          text = body.toString("utf8");
        }
        return { status: response.status(), text };
      })(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new ProbeTransportError("probe_transport_timeout")),
          options.timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    await context.close();
  }
}

export async function createProbeTransport(
  mode: ProbeTransportMode,
  chromiumHeadless = false,
): Promise<ProbeTransport> {
  if (mode === "chromium") {
    const { chromium } = await import("@playwright/test");
    const browser = await chromium.launch({ headless: chromiumHeadless });
    return {
      request: (url, options) => browserRequest(browser, url, options),
      close: () => browser.close(),
    };
  }
  return {
    async request(url, options) {
      const response = await fetch(url, {
        method: "GET",
        headers: options.headers,
        redirect: "error",
        cache: "no-store",
        credentials: "omit",
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      const text = options.readBody ? await boundedText(response) : null;
      if (!options.readBody) await response.body?.cancel();
      return { status: response.status, text };
    },
    close: () => Promise.resolve(),
  };
}
