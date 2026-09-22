import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import ts from "typescript";

const repo = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const warning = {
  code: "schedule_capacity_exceeded",
  message: "This time exceeds schedule capacity. Review the overlapping jobs.",
};

async function selectedFunctions(path: string, names: string[]) {
  const source = await readFile(`${repo}/${path}`, "utf8");
  const parsed = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  return names
    .map((name) => {
      const declaration = parsed.statements.find(
        (statement) =>
          ts.isFunctionDeclaration(statement) && statement.name?.text === name,
      );
      assert.ok(declaration, `Missing action ${name}`);
      return declaration.getText(parsed);
    })
    .join("\n");
}

void test("staff scheduling actions save successfully and retain capacity warnings", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "stonegate-capacity-actions-"),
  );
  try {
    const team = await selectedFunctions("apps/site/src/app/team/actions.ts", [
      "readFormString",
      "formatInboxAppointmentTime",
      "rescheduleAppointmentAction",
      "bookInboxAppointmentAction",
      "rescheduleInboxAppointmentAction",
    ]);
    const mobile = await selectedFunctions(
      "apps/site/src/app/mobile/actions.ts",
      [
        "mobileReturnTo",
        "mobileReturnWithParam",
        "mobileReturnWithScheduleWarning",
        "bookMobileAppointmentAction",
        "rescheduleMobileAppointmentAction",
      ],
    );
    await build({
      stdin: {
        contents: `
          import { readScheduleWarning } from './apps/site/src/app/team/lib/schedule-warning';
          const requireCurrentTeamPrincipal = async () => ({memberId:'member'});
          const requireMobilePermission = async () => ({teamMember:{id:'member'}});
          const callAdminApiAs = async (_principal,path,init) => globalThis.__capacityApi(path,init);
          const callAdminApiForCurrentSession = async (path,init) => globalThis.__capacityApi(path,init);
          const revalidatePath = path => globalThis.__capacityRevalidations.push(path);
          const cookies = async () => ({set:value => globalThis.__capacityFlashes.push(value)});
          const redirect = url => {const error = new Error('redirect'); error.url = url; throw error;};
          const readErrorMessage = async response => (await response.json()).message;
          const formatActionError = error => error.message;
          const resolveBookingSelection = value => value;
          const parseAppointmentBookingFormData = () => ({ok:true,bookingDetails:null,quotedTotalCents:null});
          const buildLocalStartAt = form => form.get('startAt');
          const parseMobileAppointmentVersion = value => typeof value === 'string' && value;
          const mobileBookingHref = (screen,date,id) => '/mobile?screen='+screen+'&date='+date+'&booking='+id;
          ${team}
          ${mobile}
        `,
        resolveDir: repo,
        loader: "ts",
      },
      outfile: `${directory}/actions.mjs`,
      bundle: true,
      platform: "node",
      format: "esm",
    });
    const actions = await import(
      pathToFileURL(`${directory}/actions.mjs`).href
    );
    const state = globalThis as any;
    let responseBody: Record<string, unknown>;
    let responseStatus = 200;
    function reset(scheduleWarning: unknown = warning) {
      state.__capacityRevalidations = [];
      state.__capacityFlashes = [];
      state.__capacityCalls = [];
      responseStatus = 200;
      responseBody = {
        ok: true,
        appointmentId: "appointment",
        startAt: "2026-09-22T14:00:00.000Z",
        preferredDate: "2026-09-22",
        version: "2026-09-21T12:00:00.000Z",
        scheduleWarning,
      };
      state.__capacityApi = async (path: string, init: RequestInit) => {
        state.__capacityCalls.push({ path, init });
        return Response.json(responseBody, { status: responseStatus });
      };
    }
    function form() {
      const value = new FormData();
      Object.entries({
        contactId: "contact",
        propertyId: "property",
        appointmentId: "appointment",
        appointmentType: "in_person_quote",
        startAt: "2026-09-22T14:00:00.000Z",
        preferredDate: "2026-09-22",
        startTime: "10:00",
        currentDate: "2026-09-21",
        screen: "calendar",
      }).forEach(([key, entry]) => value.set(key, entry));
      return value;
    }
    async function redirected(
      action: (value: FormData) => Promise<unknown>,
      value = form(),
    ) {
      try {
        await action(value);
      } catch (error) {
        assert.equal((error as Error).message, "redirect");
        return new URL((error as { url: string }).url, "https://example.test");
      }
      assert.fail("Expected successful navigation");
    }
    for (const action of [
      actions.bookInboxAppointmentAction,
      actions.rescheduleInboxAppointmentAction,
    ]) {
      reset();
      const result = await action(form());
      assert.equal(result.ok, true);
      assert.equal(result.warning, warning.message);
      assert.doesNotMatch(result.draftText, /capacity|overlapping/);
      assert.deepEqual(state.__capacityRevalidations, ["/team"]);
      reset(null);
      assert.equal((await action(form())).warning, undefined);
    }
    reset();
    await actions.rescheduleAppointmentAction(form());
    assert.deepEqual(state.__capacityFlashes, [
      {
        name: "myst-flash",
        value: `Appointment rescheduled. Warning: ${warning.message}`,
        path: "/",
      },
    ]);
    for (const action of [
      actions.bookMobileAppointmentAction,
      actions.rescheduleMobileAppointmentAction,
    ]) {
      reset();
      const url = await redirected(action);
      assert.equal(url.searchParams.get("scheduleWarning"), warning.message);
      assert.equal(url.searchParams.has("error"), false);
      assert.deepEqual(state.__capacityRevalidations, ["/mobile"]);
      reset(null);
      assert.equal(
        (await redirected(action)).searchParams.has("scheduleWarning"),
        false,
      );
    }
    reset({ ...warning, message: "x".repeat(1000) });
    const returning = form();
    returning.set("returnTo", "/mobile?screen=inbox&threadId=thread");
    const returnUrl = await redirected(
      actions.bookMobileAppointmentAction,
      returning,
    );
    assert.equal(returnUrl.searchParams.get("booked"), "1");
    assert.equal(returnUrl.searchParams.get("threadId"), "thread");
    assert.equal(returnUrl.searchParams.get("scheduleWarning")?.length, 500);
    reset();
    responseStatus = 400;
    responseBody = {
      message: "Invalid appointment details",
      scheduleWarning: warning,
    };
    const failure = await redirected(actions.bookMobileAppointmentAction);
    assert.equal(
      failure.searchParams.get("error"),
      "Invalid appointment details",
    );
    assert.equal(failure.searchParams.has("booked"), false);
    assert.equal(failure.searchParams.has("scheduleWarning"), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
