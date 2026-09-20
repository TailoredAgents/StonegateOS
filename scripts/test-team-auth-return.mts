import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import {
  safeTeamReturnPath,
  teamLoginHref,
  teamPasswordSetupHref,
} from "../packages/sdk/src/team-return-path";

const require = createRequire(import.meta.url);
const { build } = createRequire(require.resolve("tsx"))("esbuild");

const requestPath =
  "/team/partners?p_admin=requests&p_request=service%3A11111111-1111-4111-8111-111111111111&p_company=22222222-2222-4222-8222-222222222222&p_alert=33333333-3333-4333-8333-333333333333";
const state = {
  calls: [] as Array<{ path: string; init?: RequestInit }>,
  writes: [] as unknown[][],
  response: () =>
    Promise.resolve(Response.json({ sessionToken: "test-session" })),
};
const globalState = globalThis as typeof globalThis & {
  __teamAuthReturnTest?: typeof state;
};
let directory = "";
let runtime: {
  teamPasswordLoginAction: (data: FormData) => Promise<void>;
  requestTeamMagicLinkAction: (data: FormData) => Promise<void>;
  teamSetPasswordAction: (data: FormData) => Promise<void>;
  GET: (request: Request) => Promise<Response>;
};

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "stonegate-team-auth-return-"));
  globalState.__teamAuthReturnTest = state;
  const siteRequire = createRequire(resolve("apps/site/package.json"));
  const bundle = await build({
    stdin: {
      contents: `export { teamPasswordLoginAction, requestTeamMagicLinkAction, teamSetPasswordAction } from './apps/site/src/app/team/login/actions'; export { GET } from './apps/site/src/app/team/auth/route';`,
      resolveDir: process.cwd(),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    write: false,
    plugins: [
      {
        name: "auth-boundary-fixture",
        setup(builder) {
          builder.onResolve({ filter: /^@myst-os\/sdk$/ }, () => ({
            path: resolve("packages/sdk/src/team-return-path.ts"),
          }));
          builder.onResolve({ filter: /^next\/server$/ }, () => ({
            path: siteRequire.resolve("next/server"),
            external: true,
          }));
          builder.onResolve(
            {
              filter:
                /^(?:next\/(?:headers|navigation)|@\/lib\/(?:admin-session|crew-session|legacy-session-secret|team-session)|\.\/lib\/api|\.\.\/login\/lib\/api)$/,
            },
            (args) => ({ path: args.path, namespace: "auth-fixture" }),
          );
          builder.onLoad(
            { filter: /.*/, namespace: "auth-fixture" },
            (args) => {
              const prefix = "const state = globalThis.__teamAuthReturnTest;";
              const contents =
                args.path === "next/navigation"
                  ? `export function redirect(location) { throw Object.assign(new Error('redirect'), {location}); }`
                  : args.path === "next/headers"
                    ? `${prefix} export async function cookies() { return { get() { return null; }, delete(){}, set(...values) { state.writes.push(values); } }; } export async function headers(){ return new Headers(); }`
                    : args.path.includes("team-session")
                      ? `export const TEAM_SESSION_COOKIE='team_session'; export const teamSessionCookieOptions=()=>({httpOnly:true,path:'/'}); export const breakGlassTeamSessionCookieOptions=teamSessionCookieOptions;`
                      : args.path.includes("admin-session")
                        ? `export const ADMIN_SESSION_COOKIE='admin'; export const getAdminSessionSecret=()=>null;`
                        : args.path.includes("crew-session")
                          ? `export const CREW_SESSION_COOKIE='crew'; export const getCrewKey=()=>null;`
                          : args.path.includes("legacy-session-secret")
                            ? `export const legacySessionSecretMatches=()=>false;`
                            : `${prefix} export async function callTeamPublicApi(path,init) { state.calls.push({path,init}); return state.response(); } export const callTeamApi=callTeamPublicApi; export const callTeamBreakGlassExchange=callTeamPublicApi;`;
              return { contents, loader: "js" };
            },
          );
        },
      },
    ],
  });
  const path = join(directory, "auth.mjs");
  await writeFile(path, bundle.outputFiles[0]!.text);
  runtime = await import(pathToFileURL(path).href);
});
after(async () => {
  delete globalState.__teamAuthReturnTest;
  if (directory) await rm(directory, { recursive: true, force: true });
});
function reset(
  response: () => Promise<Response> = () =>
    Promise.resolve(Response.json({ sessionToken: "test-session" })),
) {
  state.calls = [];
  state.writes = [];
  state.response = response;
}
function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}
async function destination(run: Promise<void>): Promise<URL> {
  try {
    await run;
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "location" in error &&
      typeof error.location === "string"
    )
      return new URL(error.location, "https://staff.example.test");
    throw error;
  }
  throw new Error("Expected an authentication redirect");
}
function callback(params: Record<string, string>) {
  return new Request(
    `https://staff.example.test/team/auth?${new URLSearchParams(params)}`,
  );
}

test("return paths preserve encoded request/group state while rejecting external, malformed and auth-loop targets", () => {
  assert.equal(safeTeamReturnPath(requestPath), requestPath);
  assert.equal(
    new URL(
      teamLoginHref(requestPath),
      "https://staff.example.test",
    ).searchParams.get("returnTo"),
    requestPath,
  );
  for (const target of [
    undefined,
    "",
    "https://attacker.example/team",
    "//attacker.example/team",
    "/\\attacker.example/team",
    "/team/../outside",
    "/team/%2e%2e/outside",
    "/teammate",
    "/partners/overview",
    "/team/login",
    "/team/auth?token=private",
    "/team/%61uth",
    "/team/%2flogin",
    "/team/%5clogin",
    "/team/%0a",
    "/team/%",
    "/team\n",
    "/team#private",
    "/team?" + "a".repeat(4100),
  ]) {
    assert.equal(safeTeamReturnPath(target), null, String(target));
    assert.equal(teamLoginHref(target), "/team/login");
  }
});

test("password login authorizes normally and returns to the exact request; errors retain it without setting a cookie", async () => {
  reset();
  const result = await destination(
    runtime.teamPasswordLoginAction(
      form({
        email: "staff@example.test",
        password: "test-password",
        returnTo: requestPath,
      }),
    ),
  );
  assert.equal(result.pathname + result.search, requestPath);
  assert.equal(state.calls[0]!.path, "/api/public/team/login-password");
  assert.deepEqual(JSON.parse(String(state.calls[0]!.init!.body)), {
    email: "staff@example.test",
    password: "test-password",
  });
  assert.equal(state.writes.length, 1);
  for (const response of [
    () =>
      Promise.resolve(
        Response.json({ error: "invalid_credentials" }, { status: 401 }),
      ),
    () =>
      Promise.resolve(
        Response.json(
          { error: "rate_limited" },
          { status: 429, headers: { "Retry-After": "60" } },
        ),
      ),
    () => Promise.reject(new Error("unavailable")),
    () => Promise.resolve(Response.json({})),
    () => Promise.resolve(Response.json(null)),
    () => Promise.resolve(Response.json({ sessionToken: "   " })),
  ]) {
    reset(response);
    const error = await destination(
      runtime.teamPasswordLoginAction(
        form({
          email: "staff@example.test",
          password: "wrong",
          returnTo: requestPath,
        }),
      ),
    );
    assert.equal(error.pathname, "/team/login");
    assert.equal(error.searchParams.get("returnTo"), requestPath);
    assert.ok(error.searchParams.get("error"));
    assert.equal(state.writes.length, 0);
  }
  reset();
  const unsafe = await destination(
    runtime.teamPasswordLoginAction(
      form({
        email: "staff@example.test",
        password: "test-password",
        returnTo: "//attacker.example/team",
      }),
    ),
  );
  assert.equal(unsafe.pathname + unsafe.search, "/team");
});

test("magic-link request passes a safe navigation hint and preserves it through delivery and rate-limit errors", async () => {
  for (const status of [200, 429, 503]) {
    reset(() =>
      Promise.resolve(
        Response.json(
          { ok: status === 200 },
          { status, headers: { "Retry-After": "120" } },
        ),
      ),
    );
    const result = await destination(
      runtime.requestTeamMagicLinkAction(
        form({ identifier: "staff@example.test", returnTo: requestPath }),
      ),
    );
    assert.equal(result.pathname, "/team/login");
    assert.equal(result.searchParams.get("returnTo"), requestPath);
    assert.equal(state.writes.length, 0);
    assert.deepEqual(JSON.parse(String(state.calls[0]!.init!.body)), {
      email: "staff@example.test",
      returnTo: requestPath,
    });
  }
});

test("magic-link callback requires a successful exchange, clears stale sessions on failure and retains the exact return link", async () => {
  reset();
  const success = await runtime.GET(
    callback({ token: "one-time-token", returnTo: requestPath }),
  );
  assert.equal(success.status, 303);
  assert.equal(success.headers.get("location"), requestPath);
  assert.match(
    success.headers.get("set-cookie") ?? "",
    /team_session=test-session/,
  );
  assert.deepEqual(JSON.parse(String(state.calls[0]!.init!.body)), {
    token: "one-time-token",
  });
  for (const response of [
    () =>
      Promise.resolve(
        Response.json({ error: "invalid_or_expired" }, { status: 401 }),
      ),
    () => Promise.reject(new Error("unavailable")),
    () => Promise.resolve(Response.json({})),
    () => Promise.resolve(Response.json(null)),
    () => Promise.resolve(Response.json({ sessionToken: "   " })),
  ]) {
    reset(response);
    const failed = await runtime.GET(
      callback({ token: "invalid", returnTo: requestPath }),
    );
    const result = new URL(
      failed.headers.get("location")!,
      "https://staff.example.test",
    );
    assert.equal(result.pathname, "/team/login");
    assert.equal(result.searchParams.get("returnTo"), requestPath);
    assert.match(failed.headers.get("set-cookie") ?? "", /Max-Age=0/i);
  }
  reset();
  const missing = await runtime.GET(callback({ returnTo: requestPath }));
  assert.equal(state.calls.length, 0);
  assert.match(missing.headers.get("location")!, /missing_token/);
  reset();
  const unsafe = await runtime.GET(
    callback({ token: "valid", returnTo: "https://attacker.example/team" }),
  );
  assert.equal(unsafe.headers.get("location"), "/team");
});

test("optional password setup preserves the request through validation, service failure, session expiry and successful save", async () => {
  reset(() =>
    Promise.resolve(
      Response.json({ sessionToken: "test-session", needsPasswordSetup: true }),
    ),
  );
  const callbackResponse = await runtime.GET(
    callback({ token: "one-time", returnTo: requestPath }),
  );
  assert.equal(
    callbackResponse.headers.get("location"),
    teamPasswordSetupHref(requestPath),
  );
  reset();
  const invalid = await destination(
    runtime.teamSetPasswordAction(
      form({ password: "short", returnTo: requestPath }),
    ),
  );
  assert.equal(invalid.searchParams.get("returnTo"), requestPath);
  assert.equal(invalid.searchParams.get("setup"), "1");
  assert.equal(state.calls.length, 0);
  for (const status of [503, 401, 200]) {
    reset(() =>
      Promise.resolve(
        Response.json({ ok: status === 200, error: "save_failed" }, { status }),
      ),
    );
    const result = await destination(
      runtime.teamSetPasswordAction(
        form({ password: "safe-test-password", returnTo: requestPath }),
      ),
    );
    if (status === 200)
      assert.equal(result.pathname + result.search, requestPath);
    else if (status === 401)
      assert.equal(
        result.searchParams.get("returnTo"),
        teamPasswordSetupHref(requestPath),
      );
    else assert.equal(result.searchParams.get("returnTo"), requestPath);
  }
});
