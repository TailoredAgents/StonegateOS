import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {
  readTeamMutationError,
  readTeamMutationException,
} from "../../../site/src/app/team/lib/mutation-feedback";

const CONTACT_ID = "11111111-1111-4111-8111-111111111111";
const TASK_ID = "22222222-2222-4222-8222-222222222222";
const THREAD_ID = "33333333-3333-4333-8333-333333333333";
const MESSAGE_ID = "44444444-4444-4444-8444-444444444444";
const ACTIONS = [
  "draftOutboundFirstTouchAction",
  "draftOutboundFollowupAction",
  "openContactThreadAction",
] as const;
type ActionName = (typeof ACTIONS)[number];

const source = ts.createSourceFile(
  "actions.ts",
  readFileSync(join(process.cwd(), "../site/src/app/team/actions.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function declaration(name: string): string {
  const node = source.statements.find(
    (statement) =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!node) throw new Error(`Missing actual server action: ${name}`);
  return node.getText(source);
}

/** Execute the real action bodies with isolated framework/network boundaries. */
function harness(name: ActionName) {
  const principal = { memberId: "test-owner" };
  const callAdminApiAs = jest.fn<Promise<Response>, unknown[]>();
  const setCookie = jest.fn<
    void,
    [{ name: string; value: string; path: string }]
  >();
  const revalidatePath = jest.fn<void, [string]>();
  const redirectSentinel = new Error("NEXT_REDIRECT");
  const redirect = jest.fn<never, [string]>(() => {
    throw redirectSentinel;
  });
  const requireCurrentTeamPrincipal = jest
    .fn<Promise<typeof principal>, []>()
    .mockResolvedValue(principal);
  const exports: Record<string, unknown> = {};
  const javascript = ts.transpileModule(
    `${declaration("isUuid")}\n${declaration(name)}`,
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.CommonJS,
      },
    },
  ).outputText;
  runInNewContext(javascript, {
    exports,
    callAdminApiAs,
    requireCurrentTeamPrincipal,
    cookies: () => Promise.resolve({ set: setCookie }),
    revalidatePath,
    redirect,
    readTeamMutationException,
    readErrorMessage: readTeamMutationError,
    teamSurfaceHref: (
      surface: string,
      options: { query: Record<string, string> },
    ) => `/team/${surface}?${new URLSearchParams(options.query).toString()}`,
  });
  const action = exports[name] as (form: FormData) => Promise<void>;
  return {
    action,
    callAdminApiAs,
    setCookie,
    revalidatePath,
    redirect,
    redirectSentinel,
    requireCurrentTeamPrincipal,
  };
}

function form(): FormData {
  const value = new FormData();
  value.set("contactId", CONTACT_ID);
  value.set("taskId", TASK_ID);
  value.set("channel", "email");
  value.set("recap", "Keep this operator note.");
  return value;
}

function receipt(patch: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    contactId: CONTACT_ID,
    threadId: THREAD_ID,
    messageId: MESSAGE_ID,
    channel: "email",
    ...patch,
  };
}

function expectNoSuccess(test: ReturnType<typeof harness>): void {
  expect(test.redirect).not.toHaveBeenCalled();
  expect(
    test.setCookie.mock.calls.every(
      ([cookie]) => cookie.name === "myst-flash-error",
    ),
  ).toBe(true);
  expect(test.revalidatePath).toHaveBeenCalledWith("/team");
}

describe.each(ACTIONS)("%s recovery", (name) => {
  it.each([
    ["network", new TypeError("fetch failed")],
    ["timeout", Object.assign(new Error("timed out"), { name: "AbortError" })],
    ["configuration", new Error("PRIVATE_CONFIG_VALUE must not be exposed")],
  ])(
    "recovers from %s failure without replaying or claiming success",
    async (_label, error) => {
      const test = harness(name);
      const input = form();
      test.callAdminApiAs.mockRejectedValue(error);
      await expect(test.action(input)).resolves.toBeUndefined();
      expect(test.callAdminApiAs).toHaveBeenCalledTimes(1);
      expectNoSuccess(test);
      const message = test.setCookie.mock.calls[0]![0].value;
      expect(message).not.toContain("PRIVATE_CONFIG_VALUE");
      if (name !== "openContactThreadAction")
        expect(message).toContain(
          "Check Inbox before creating another suggestion",
        );
      expect(input.get("recap")).toBe("Keep this operator note.");
    },
  );

  it("handles broken response JSON without crashing or claiming success", async () => {
    const test = harness(name);
    test.callAdminApiAs.mockResolvedValue(
      new Response("not JSON", { status: 200 }),
    );
    await expect(test.action(form())).resolves.toBeUndefined();
    expectNoSuccess(test);
  });

  it("retains safe HTTP failure feedback", async () => {
    const test = harness(name);
    test.callAdminApiAs.mockResolvedValue(
      Response.json({ error: "forbidden" }, { status: 403 }),
    );
    await expect(test.action(form())).resolves.toBeUndefined();
    expectNoSuccess(test);
  });

  it("does not swallow the successful Next.js redirect control flow", async () => {
    const test = harness(name);
    test.callAdminApiAs.mockResolvedValue(Response.json(receipt()));
    await expect(test.action(form())).rejects.toBe(test.redirectSentinel);
    expect(test.redirect).toHaveBeenCalledWith(
      `/team/inbox?threadId=${THREAD_ID}&contactId=${CONTACT_ID}&channel=email`,
    );
    expect(
      test.setCookie.mock.calls.every(
        ([cookie]) => cookie.name !== "myst-flash-error",
      ),
    ).toBe(true);
  });

  it("does not swallow authentication control flow", async () => {
    const test = harness(name);
    const authenticationRedirect = new Error("NEXT_REDIRECT_LOGIN");
    test.requireCurrentTeamPrincipal.mockRejectedValue(authenticationRedirect);
    await expect(test.action(form())).rejects.toBe(authenticationRedirect);
    expect(test.callAdminApiAs).not.toHaveBeenCalled();
    expect(test.setCookie).not.toHaveBeenCalled();
  });
});

describe.each(ACTIONS.slice(0, 2))("%s truthful draft receipt", (name) => {
  it.each([
    { ok: false },
    { contactId: TASK_ID },
    { messageId: undefined },
    { channel: undefined },
    { threadId: "not-a-thread" },
  ])(
    "rejects an incomplete or mismatched success receipt %j",
    async (patch) => {
      const test = harness(name);
      test.callAdminApiAs.mockResolvedValue(Response.json(receipt(patch)));
      await expect(test.action(form())).resolves.toBeUndefined();
      expectNoSuccess(test);
      expect(test.setCookie.mock.calls[0]![0].value).toContain(
        "could not be confirmed",
      );
    },
  );
});
