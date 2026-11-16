// Shared by the live gateway and its transport regression tests. Never retry a
// forwarded request: a lost response can follow a successfully committed write.
const hopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];
export function upstreamRequest(request) {
  const original = new URL(request.url);
  const target = new URL(request.url);
  target.protocol = "http:";
  // The port Fetcher already selects the Container. Keep the external host in
  // its URL: the native transport derives Host from the URL and overrides an
  // explicit Host header when the URL instead says "container".
  const headers = new Headers(request.headers);
  const nominated = (headers.get("connection") ?? "")
    .split(",")
    .map((x) => x.trim());
  for (const name of [...hopHeaders, ...nominated])
    if (name) headers.delete(name);
  for (const name of [...headers.keys()]) {
    if (/^(?:x-forwarded-|x-migration-|x-stonegate-gateway-)/i.test(name))
      headers.delete(name);
  }
  headers.delete("forwarded");
  headers.delete("x-real-ip");
  headers.set("host", original.host);
  headers.set("x-forwarded-host", original.host);
  headers.set("x-forwarded-proto", original.protocol.slice(0, -1));
  const ip = headers.get("cf-connecting-ip");
  if (ip) headers.set("x-forwarded-for", ip);
  // Origin, cookies, Authorization, Next-Action, content bytes and query string
  // are preserved. In particular, do not rewrite Origin to bypass Next's CSRF.
  return new Request(target, {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
    signal: request.signal,
    ...(request.body ? { duplex: "half" } : {}),
  });
}

export function trackedResponse(response, complete) {
  const headers = new Headers(response.headers);
  for (const name of hopHeaders) headers.delete(name);
  if (!response.body) {
    complete();
    return new Response(null, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  const reader = response.body.getReader();
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      complete();
    }
  };
  const body = new ReadableStream({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finish();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        finish();
      }
    },
  });
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
