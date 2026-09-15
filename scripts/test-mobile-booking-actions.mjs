import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
const repo = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/u, "");
const require = createRequire(`${repo}/package.json`);
const { build } = createRequire(require.resolve("tsx"))("esbuild");
const stubs = {
  "next/headers": "export const cookies=async()=>({});",
  "next/navigation":
    "export function redirect(url){const e=new Error(url);e.redirect=url;throw e;}",
  "next/cache":
    "export function revalidatePath(path){globalThis.__revalidated.push(path);}",
  "@/lib/team-session": 'export const TEAM_SESSION_COOKIE="test";',
  "../team/lib/api":
    "export async function callAdminApiForCurrentSession(path,init){globalThis.__calls.push({path,init});return globalThis.__answer(path,init);}",
  "../team/login/lib/api":
    "export const callTeamApi=()=>null;export const callTeamPublicApi=()=>null;",
  "../team/lib/manual-call-result":
    "export const readManualCallAttemptResponseMetadata=()=>null;export const readManualCallMutationSuccess=()=>null;",
  "@/lib/manual-call-attempt-store":
    'export const MANUAL_CALL_ATTEMPT_COOKIE="test";export const findManualCallAttempt=()=>null;export const manualCallAttemptScope=()=>null;export const parseManualCallAttemptStore=()=>null;export const removeManualCallAttempt=()=>null;export const storeManualCallAttempt=()=>null;',
  "../team/lib/team-mutation-transport":
    "export const callAdminMutationWithSafeReplay=()=>null;",
  "@/lib/team-principal": "export const requireCurrentTeamPrincipal=()=>null;",
  "./lib/session":
    'export const resolveMobileSessionFromCookies=async()=>globalThis.__session;export const hasMobilePermission=(permissions,key)=>permissions.includes("*")||permissions.includes(key);',
};
void test("mobile booking actions preserve request identity, receipts and navigation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "stonegate-mobile-actions-"));
  try {
    await build({
      entryPoints: [`${repo}/apps/site/src/app/mobile/actions.ts`],
      outfile: `${directory}/actions.mjs`,
      bundle: true,
      format: "esm",
      platform: "node",
      plugins: [
        {
          name: "mocks",
          setup(b) {
            b.onResolve({ filter: /.*/ }, (a) =>
              a.path in stubs ? { path: a.path, namespace: "mock" } : null,
            );
            b.onLoad({ filter: /.*/, namespace: "mock" }, (a) => ({
              contents: stubs[a.path],
              loader: "js",
            }));
          },
        },
      ],
    });
    const actions = await import(
      pathToFileURL(`${directory}/actions.mjs`).href
    );
    const id = "11111111-1111-4111-8111-111111111111",
      member = "22222222-2222-4222-8222-222222222222",
      version = "2026-09-12T14:00:00.000Z",
      nextVersion = "2026-09-12T15:00:00.000Z",
      key = "mobile-status:test-request-123";
    function form(note = false) {
      const f = new FormData();
      for (const [k, v] of Object.entries({
        appointmentId: id,
        status: "completed",
        date: "2026-09-12",
        screen: "calendar",
        expectedVersion: version,
        idempotencyKey: key,
        appointmentType: "job",
        finalTotal: "0",
        expectedFinalTotalCents: "null",
        crewMemberId: member,
        ...(note ? { body: "Keep donation bins in place." } : {}),
      }))
        f.set(k, v);
      return f;
    }
    function success(note = false) {
      return Response.json({
        ok: true,
        data: note
          ? { note: { id: "note-1", appointmentId: id }, version: nextVersion }
          : {
              appointmentId: id,
              status: "completed",
              version: nextVersion,
              calendarSync: "requested",
              customerNotification: "not_requested",
              reviewRequest: "not_requested",
            },
        receipt: {
          operationId: "op-1",
          correlationId: "correlation-1",
          actorId: "actor-1",
          committedAt: nextVersion,
          entityType: note ? "appointment_note" : "appointment",
          entityId: note ? "note-1" : id,
          version: nextVersion,
        },
      });
    }
    function reset(answer = () => success()) {
      globalThis.__calls = [];
      globalThis.__revalidated = [];
      globalThis.__session = {
        teamMember: { permissions: ["appointments.update"] },
      };
      globalThis.__answer = answer;
    }
    let checks = 0;
    reset();
    assert.equal(
      (await actions.saveMobileAppointmentCompletionAction(form())).ok,
      true,
    );
    assert.equal(__calls.length, 1);
    assert.deepEqual(JSON.parse(__calls[0].init.body), {
      status: "completed",
      expectedVersion: version,
      sendCustomerNotification: false,
      sendReviewRequest: false,
      finalTotalCents: 0,
      expectedFinalTotalCents: null,
      crewMembers: [{ memberId: member, splitBps: 1 }],
    });
    assert.equal(__calls[0].init.headers["Idempotency-Key"], key);
    assert.equal(__calls[0].init.headers["If-Match"], `"${version}"`);
    checks++;
    reset();
    const moving = form();
    moving.set("crewCompensationMode", "hourly");
    moving.set(`crewHourlyRate:${member}`, "25.50");
    moving.set(`crewHours:${member}`, "2.5");
    assert.equal(
      (await actions.saveMobileAppointmentCompletionAction(moving)).ok,
      true,
    );
    assert.deepEqual(JSON.parse(__calls[0].init.body).crewMembers, [
      { memberId: member, hourlyRateCents: 2550, workedMinutes: 150 },
    ]);
    checks++;
    for (const field of [
      "finalTotal",
      "crewMemberId",
      "expectedVersion",
      "idempotencyKey",
    ]) {
      reset();
      const f = form();
      f.delete(field);
      const r = await actions.saveMobileAppointmentCompletionAction(f);
      assert.equal(r.ok, false);
      assert.equal(r.submitted, false);
      assert.equal(__calls.length, 0);
      checks++;
    }
    reset();
    const msg = form();
    msg.set("sendReviewRequest", "on");
    assert.equal(
      (await actions.saveMobileAppointmentCompletionAction(msg)).submitted,
      false,
    );
    assert.equal(__calls.length, 0);
    checks++;
    reset();
    __session = null;
    assert.equal(
      (await actions.saveMobileAppointmentCompletionAction(form())).submitted,
      false,
    );
    assert.equal(__calls.length, 0);
    checks++;
    for (const status of [409, 422, 500, 503, 408]) {
      reset(() => Response.json({ error: "saved API error" }, { status }));
      const r = await actions.saveMobileAppointmentCompletionAction(form());
      assert.equal(r.ok, false);
      assert.equal(r.submitted, true);
      assert.equal(r.uncertain, status >= 500 || status === 408);
      assert.equal(__revalidated.length, 0);
      checks++;
    }
    reset(() => {
      throw new TypeError("lost response");
    });
    const retryForm = form();
    assert.equal(
      (await actions.saveMobileAppointmentCompletionAction(retryForm))
        .uncertain,
      true,
    );
    __answer = () => success();
    assert.equal(
      (await actions.saveMobileAppointmentCompletionAction(retryForm)).ok,
      true,
    );
    assert.deepEqual(__calls[0], __calls[1]);
    checks++;
    reset(() => Response.json({ ok: true }));
    assert.equal(
      (await actions.saveMobileAppointmentCompletionAction(form())).uncertain,
      true,
    );
    assert.equal(__revalidated.length, 0);
    checks++;
    reset(() => success(true));
    assert.deepEqual(
      await actions.saveMobileAppointmentNoteAction(form(true)),
      {
        ok: true,
        appointmentId: id,
        version: nextVersion,
        message: "Note saved.",
      },
    );
    assert.deepEqual(JSON.parse(__calls[0].init.body), {
      body: "Keep donation bins in place.",
    });
    checks++;
    reset();
    const empty = form(true);
    empty.set("body", "");
    assert.equal(
      (await actions.saveMobileAppointmentNoteAction(empty)).submitted,
      false,
    );
    assert.equal(__calls.length, 0);
    checks++;
    reset(() => {
      throw new TypeError("lost note response");
    });
    assert.equal(
      (await actions.saveMobileAppointmentNoteAction(form(true))).uncertain,
      true,
    );
    checks++;
    reset(() => Response.json({ ok: true }));
    assert.equal(
      (await actions.saveMobileAppointmentNoteAction(form(true))).uncertain,
      true,
    );
    checks++;
    for (const note of [false, true]) {
      const action = note
        ? actions.saveMobileAppointmentNoteAction
        : actions.saveMobileAppointmentCompletionAction;
      for (const answer of [
        () =>
          Response.json(
            { code: "conflict" },
            { status: 409, headers: { "Retry-After": "2" } },
          ),
        () => Response.json({ code: "request_in_progress" }, { status: 409 }),
        () =>
          Response.json(
            {
              code: "conflict",
              message:
                "This operation is already in progress. Retry after the indicated delay.",
            },
            { status: 409 },
          ),
      ]) {
        reset(answer);
        const data = form(note);
        const pendingResult = await action(data);
        assert.equal(pendingResult.ok, false);
        assert.equal(pendingResult.submitted, true);
        assert.equal(pendingResult.uncertain, true);
        __answer = () => success(note);
        assert.equal((await action(data)).ok, true);
        assert.deepEqual(__calls[0], __calls[1]);
        checks++;
      }
      reset(() =>
        Response.json(
          {
            code: "conflict",
            message: "This appointment changed on another screen.",
            retryable: false,
          },
          { status: 409 },
        ),
      );
      const staleResult = await action(form(note));
      assert.equal(staleResult.ok, false);
      assert.equal(staleResult.uncertain, false);
      assert.equal(staleResult.submitted, true);
      checks++;
    }
    for (const note of [false, true]) {
      reset(async () => {
        const envelope = await success(note).json();
        envelope.data = null;
        return Response.json(envelope);
      });
      const result = await (
        note
          ? actions.saveMobileAppointmentNoteAction
          : actions.saveMobileAppointmentCompletionAction
      )(form(note));
      assert.equal(result.ok, false);
      assert.equal(result.uncertain, true);
      assert.equal(result.submitted, true);
      assert.equal(__revalidated.length, 0);
      checks++;
    }
    for (const note of [false, true]) {
      reset(() => success(note));
      try {
        await (
          note
            ? actions.addMobileAppointmentNoteAction
            : actions.updateMobileAppointmentStatusAction
        )(form(note));
        assert.fail("Expected redirect");
      } catch (e) {
        const url = new URL(e.redirect, "http://test");
        assert.equal(url.searchParams.get("jobId"), id);
        assert.equal(url.searchParams.get("screen"), "calendar");
        assert.equal(url.searchParams.get("date"), "2026-09-12");
      }
      checks++;
    }

    async function redirected(action, data) {
      try {
        await action(data);
        assert.fail("Expected redirect");
      } catch (error) {
        assert.equal(typeof error.redirect, "string");
        return new URL(error.redirect, "https://test.invalid");
      }
    }
    function permitMessages() {
      __session.teamMember.permissions.push("messages.read", "messages.send");
    }
    reset((path) =>
      path.startsWith("/api/appointments?")
        ? Response.json({ appointments: [{ id, contact: { id: member } }] })
        : Response.json({ threads: [{ id: "thread-1" }] }),
    );
    permitMessages();
    let url = await redirected(
      actions.openMobileAppointmentThreadAction,
      form(),
    );
    assert.equal(url.searchParams.get("screen"), "inbox");
    assert.equal(url.searchParams.get("threadId"), "thread-1");
    assert.equal(
      url.searchParams.get("bookingReturn"),
      `/mobile?screen=calendar&date=2026-09-12&jobId=${id}`,
    );
    assert.equal(__calls.length, 2);
    assert.ok(__calls.every((call) => call.init.method === "GET"));
    checks++;
    reset((path) =>
      path.startsWith("/api/appointments?")
        ? Response.json({ appointments: [{ id, contact: { id: member } }] })
        : path.includes("/ensure")
          ? Response.json({ ok: true, threadId: "thread-2" })
          : Response.json({ threads: [] }),
    );
    permitMessages();
    url = await redirected(actions.openMobileAppointmentThreadAction, form());
    assert.equal(url.searchParams.get("threadId"), "thread-2");
    assert.equal(url.searchParams.get("screen"), "inbox");
    assert.ok(url.searchParams.get("bookingReturn").includes(id));
    assert.equal(__calls.length, 3);
    assert.ok(__calls.every((call) => !call.path.endsWith("/messages")));
    checks++;
    reset(() => {
      throw Error("lookup unavailable");
    });
    permitMessages();
    url = await redirected(actions.openMobileAppointmentThreadAction, form());
    assert.equal(url.searchParams.get("jobId"), id);
    assert.equal(url.searchParams.get("date"), "2026-09-12");
    assert.equal(url.searchParams.get("error"), "appointment_lookup_failed");
    checks++;
    reset(() => Response.json({ ok: true, threadId: "contact-thread" }));
    permitMessages();
    const contactForm = form();
    contactForm.set("contactId", member);
    contactForm.set(
      "returnTo",
      `/mobile?screen=myday&date=2026-09-12&jobId=${id}`,
    );
    url = await redirected(actions.openMobileContactThreadAction, contactForm);
    assert.equal(url.searchParams.get("screen"), "inbox");
    assert.ok(url.searchParams.get("bookingReturn").includes(id));
    checks++;
    const rescheduleForm = form();
    rescheduleForm.set("screen", "myday");
    rescheduleForm.set("currentDate", "2026-09-12");
    rescheduleForm.set("preferredDate", "2026-09-13");
    rescheduleForm.set("startTime", "09:30");
    reset(() =>
      Response.json({
        ok: true,
        appointmentId: id,
        preferredDate: "2026-09-13",
        version: nextVersion,
      }),
    );
    url = await redirected(
      actions.rescheduleMobileAppointmentAction,
      rescheduleForm,
    );
    assert.equal(url.searchParams.get("screen"), "myday");
    assert.equal(url.searchParams.get("date"), "2026-09-13");
    assert.equal(url.searchParams.get("jobId"), id);
    assert.deepEqual(JSON.parse(__calls[0].init.body), {
      preferredDate: "2026-09-13",
      startTime: "09:30",
    });
    checks++;
    for (const answer of [
      () => {
        throw Error("lost response");
      },
      () => Response.json({ ok: true }),
      () => Response.json({ error: "schedule_conflict" }, { status: 409 }),
    ]) {
      reset(answer);
      url = await redirected(
        actions.rescheduleMobileAppointmentAction,
        rescheduleForm,
      );
      assert.equal(url.searchParams.get("screen"), "myday");
      assert.equal(url.searchParams.get("date"), "2026-09-12");
      assert.equal(url.searchParams.get("jobId"), id);
      assert.ok(url.searchParams.get("error"));
      assert.equal(url.searchParams.get("appointment"), null);
      checks++;
    }
    reset(() => Response.json({ ok: true, threadId: "contact-thread" }));
    permitMessages();
    const unsafeReturn = form();
    unsafeReturn.set("contactId", member);
    unsafeReturn.set("returnTo", "/mobile-unsafe?jobId=oops");
    url = await redirected(actions.openMobileContactThreadAction, unsafeReturn);
    assert.equal(url.searchParams.get("bookingReturn"), null);
    checks++;

    const savedPropertyId = "77777777-7777-4777-8777-777777777777";
    function bookingForm() {
      const f = new FormData();
      for (const [name, value] of Object.entries({
        contactId: id,
        propertyId: "",
        startAt: "2026-09-16T09:00",
        appointmentType: "job",
        sourceType: "team_member",
        sourceTeamMemberId: member,
        serviceType: "junk_removal",
        priceInputMode: "exact",
        quotedTotal: "350",
        loadSize: "quarter_to_half",
        addressLine1: "123 Main St",
        addressLine2: " Building B, Unit 204 ",
        city: "Atlanta",
        state: "GA",
        postalCode: "30301",
      }))
        f.set(name, value);
      return f;
    }
    function permitBooking() {
      globalThis.__session.teamMember = {
        id: member,
        permissions: ["bookings.manage"],
      };
    }
    reset((path) =>
      path.endsWith("/properties")
        ? Response.json({ property: { id: savedPropertyId } })
        : Response.json({ ok: true }),
    );
    permitBooking();
    url = await redirected(actions.bookMobileAppointmentAction, bookingForm());
    assert.equal(url.searchParams.get("booked"), "1", url.href);
    assert.equal(__calls.length, 2);
    assert.deepEqual(JSON.parse(__calls[0].init.body), {
      addressLine1: "123 Main St",
      addressLine2: "Building B, Unit 204",
      city: "Atlanta",
      state: "GA",
      postalCode: "30301",
    });
    assert.equal(__calls[1].path, "/api/admin/booking/book");
    assert.equal(JSON.parse(__calls[1].init.body).propertyId, savedPropertyId);
    checks++;

    reset();
    permitBooking();
    const ambiguousAddress = bookingForm();
    ambiguousAddress.set("propertyId", savedPropertyId);
    url = await redirected(
      actions.bookMobileAppointmentAction,
      ambiguousAddress,
    );
    assert.match(url.searchParams.get("error"), /Choose Add a new address/);
    assert.equal(__calls.length, 0);
    checks++;

    reset(() => Response.json({ ok: true }));
    permitBooking();
    const savedAddress = bookingForm();
    savedAddress.set("propertyId", savedPropertyId);
    for (const key of [
      "addressLine1",
      "addressLine2",
      "city",
      "state",
      "postalCode",
    ]) {
      savedAddress.delete(key);
    }
    url = await redirected(actions.bookMobileAppointmentAction, savedAddress);
    assert.equal(url.searchParams.get("booked"), "1");
    assert.equal(__calls.length, 1);
    assert.equal(JSON.parse(__calls[0].init.body).propertyId, savedPropertyId);
    checks++;

    reset();
    permitBooking();
    const incompleteAddress = bookingForm();
    incompleteAddress.delete("addressLine1");
    url = await redirected(
      actions.bookMobileAppointmentAction,
      incompleteAddress,
    );
    assert.equal(url.searchParams.get("error"), "complete_address_required");
    assert.equal(__calls.length, 0);
    checks++;
    console.log(`${checks} mobile action runtime checks passed`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
