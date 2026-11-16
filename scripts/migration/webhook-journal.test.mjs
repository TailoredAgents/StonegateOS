import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifiedForm,
  maxBytes,
} from "../../infra/cloudflare/webhook-journal/auth.mjs";
const origin = "https://example.com";
// Published independent vector from https://www.twilio.com/docs/usage/security.
const path = "/myapp.php?foo=1&bar=2";
const body = new URLSearchParams({
  Digits: "1234",
  To: "+18005551212",
  From: "+14158675310",
  Caller: "+14158675310",
  CallSid: "CA1234567890ABCDE",
}).toString();
function request(
  text = body,
  route = path,
  signature = "L/OH5YylLD5NRKLltdqwSvS0BnU=",
) {
  return new Request("https://private-worker.invalid" + route, {
    method: "POST",
    body: text,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-twilio-signature": signature,
    },
  });
}
test("official Twilio vector authenticates with exact original external URL and preserved bytes", async () => {
  const result = await verifiedForm(request(), origin, "12345");
  assert.equal(result.error, undefined);
  assert.equal(result.externalUrl, origin + path);
  assert.equal(result.body.toString(), body);
  assert.equal((await verifiedForm(request(), origin, "12345")).id, result.id);
});
test("changed query, body, token and missing signature never enter the journal", async () => {
  for (const [r, token] of [
    [request(body, path + "x"), "12345"],
    [request(body + "&Unknown=changed"), "12345"],
    [request(), "wrong"],
    [request(body, path, ""), "12345"],
  ])
    assert.equal((await verifiedForm(r, origin, token)).error, 403);
});
test("oversized chunked forms and unsupported content types are bounded before persistence", async () => {
  assert.equal(
    (await verifiedForm(request("x".repeat(maxBytes + 1)), origin, "12345"))
      .error,
    413,
  );
  const r = request();
  r.headers.set("content-type", "application/json");
  assert.equal((await verifiedForm(r, origin, "12345")).error, 415);
});
