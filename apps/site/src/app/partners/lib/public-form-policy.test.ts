import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server";
import { formEntryText } from "../../../lib/form-entry-text";
import { POST } from "../form/route";
import {
  parsePartnerPublicForm,
  partnerPublicFormErrorMessage,
} from "./public-form-policy";

const KEY = "11111111-1111-4111-8111-111111111111";
const PASSWORD = "a private test passphrase";

void test("text form entries preserve passphrases and never stringify uploaded files", () => {
  assert.equal(formEntryText("  a partner passphrase  "), "  a partner passphrase  ");
  assert.equal(formEntryText("0"), "0");
  assert.equal(formEntryText(null), "");
  assert.equal(formEntryText(new File(["not a text field"], "document.pdf")), "");
});

function form(operation = "reset") {
  return new URLSearchParams({
    operation,
    operationKey: KEY,
    password: PASSWORD,
    confirmPassword: PASSWORD,
  });
}
function request(body: URLSearchParams, headers: Record<string, string> = {}) {
  return new NextRequest("https://stonegate.example/partners/form", {
    method: "POST",
    headers: {
      origin: "https://stonegate.example",
      "content-type": "application/x-www-form-urlencoded",
      ...headers,
    },
    body: body.toString(),
  });
}
async function withFetch<T>(fetcher: typeof fetch, run: () => Promise<T>) {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

void test("native form parsing is bounded, purpose-allowlisted, and excludes redirect input", () => {
  assert.deepEqual(parsePartnerPublicForm(form())?.body, {
    newPassword: PASSWORD,
    confirmPassword: PASSWORD,
  });
  for (const operation of [
    "__proto__",
    "constructor",
    "signup",
    "resend",
    "https://evil.example",
  ])
    assert.equal(parsePartnerPublicForm(form(operation)), null);
  for (const [name, value] of [
    ["returnTo", "https://evil.example"],
    ["password", "second password"],
    ["operation", "activation"],
  ]) {
    const input = form();
    input.append(name!, value!);
    assert.equal(parsePartnerPublicForm(input), null);
  }
  for (const password of ["short", "A".repeat(129)]) {
    const input = form();
    input.set("password", password);
    input.set("confirmPassword", password);
    assert.equal(parsePartnerPublicForm(input), null);
  }
  const mismatch = form();
  mismatch.set("confirmPassword", "a different passphrase");
  assert.equal(parsePartnerPublicForm(mismatch), null);
  assert.equal(partnerPublicFormErrorMessage("attacker@example.com"), null);
});

void test("native reset posts credentials only in the API body and clears the purpose cookie", async () => {
  let calls = 0;
  await withFetch(
    ((input, init) => {
      calls += 1;
      assert.ok(typeof input === "string");
      assert.ok(
        input.endsWith(
          "/api/portal/v2/onboarding/password-recovery/complete",
        ),
      );
      assert.ok(!input.includes(PASSWORD));
      assert.equal(init?.method, "POST");
      const body = JSON.parse(
        new TextDecoder().decode(init?.body as ArrayBuffer),
      ) as Record<string, unknown>;
      assert.equal(body["newPassword"], PASSWORD);
      assert.equal(body["token"], "T".repeat(43));
      return Promise.resolve(Response.json({ ok: true }));
    }) as typeof fetch,
    async () => {
      const response = await POST(
        request(form(), {
          cookie: "myst-partner-password-reset-token=" + "T".repeat(43),
        }),
      );
      assert.equal(response.status, 303);
      assert.equal(
        response.headers.get("location"),
        "https://stonegate.example/partners/login?reset=1",
      );
      assert.match(
        response.headers.get("cache-control") ?? "",
        /private, no-store/u,
      );
      assert.match(
        response.headers.get("set-cookie") ?? "",
        /myst-partner-password-reset-token=;/u,
      );
      assert.ok(!(await response.text()).includes(PASSWORD));
    },
  );
  assert.equal(calls, 1);
});

void test("native activation forwards only HttpOnly session cookies, not credentials in HTML or URL", async () => {
  const session = "S".repeat(43);
  await withFetch(
    (() => Promise.resolve(
      Response.json({
        ok: true,
        sessionToken: session,
        expiresAt: "2099-01-01T00:00:00.000Z",
      }))) as typeof fetch,
    async () => {
      const response = await POST(
        request(form("activation"), {
          cookie: "myst-partner-activation-token=" + "T".repeat(43),
        }),
      );
      assert.equal(response.status, 303);
      assert.equal(
        response.headers.get("location"),
        "https://stonegate.example/partners/overview",
      );
      assert.match(
        response.headers.get("set-cookie") ?? "",
        /myst-partner-session=S+;/u,
      );
      assert.match(response.headers.get("set-cookie") ?? "", /HttpOnly/iu);
      assert.ok(!(await response.text()).includes(session));
    },
  );
});

void test("native forms reject cross-origin and oversized requests before any API call", async () => {
  await withFetch(
    (() => {
      throw new Error("unexpected API call");
    }) as typeof fetch,
    async () => {
      assert.equal(
        (await POST(request(form(), { origin: "https://evil.example" })))
          .status,
        403,
      );
      const oversized = form();
      oversized.set("password", "A".repeat(5_000));
      assert.equal((await POST(request(oversized))).status, 413);
      const invalid = form();
      invalid.set("confirmPassword", "no");
      const response = await POST(request(invalid));
      assert.equal(response.status, 303);
      assert.equal(
        response.headers.get("location"),
        "https://stonegate.example/partners/reset-password?error=invalid_fields",
      );
    },
  );
});

void test("native form outages preserve credentials and give a safe retry destination", async () => {
  for (const status of [429, 503]) {
    await withFetch(
      (() => Promise.resolve(
        Response.json(
          { ok: false, message: "provider-private-error" },
          { status },
        ))) as typeof fetch,
      async () => {
        const response = await POST(request(form()));
        assert.equal(response.status, 303);
        assert.equal(
          response.headers.get("location"),
          "https://stonegate.example/partners/reset-password?error=" +
            (status === 429 ? "rate_limited" : "temporarily_unavailable"),
        );
        assert.equal(response.headers.get("set-cookie"), null);
        assert.ok(!(await response.text()).includes("provider-private-error"));
      },
    );
  }
});

void test("every public credential/email form has a real POST fallback without JavaScript", () => {
  for (const filename of [
    "PartnerCredentialSetupForm.tsx",
    "PartnerPasswordRecoveryForm.tsx",
    "PartnerEmailChangeConfirmation.tsx",
  ]) {
    const source = readFileSync(
      new URL("../components/" + filename, import.meta.url),
      "utf8",
    );
    assert.match(
      source,
      /<form[\s\S]*?method="post"[\s\S]*?action="\/partners\/form"/u,
    );
    assert.doesNotMatch(source, /name="token"/u);
  }
});
