import { validateAssignableTeamPermissions } from "@/lib/team-permission-input";

describe("assignable team permission input", () => {
  it("normalizes and de-duplicates catalog permissions", () => {
    expect(
      validateAssignableTeamPermissions([
        " messages.read ",
        "messages.read",
        "quotes.send",
      ]),
    ).toEqual({
      ok: true,
      permissions: ["messages.read", "quotes.send"],
    });
  });

  it.each([
    "*",
    "read",
    "messages.*",
    "access.break_glass",
    "sessions.manage_self",
    "future.use",
  ])("rejects non-assignable permission %s", (permission) => {
    expect(validateAssignableTeamPermissions([permission])).toEqual({
      ok: false,
      code: "unsupported_permissions",
      invalidEntries: [permission],
    });
  });

  it("rejects malformed list values", () => {
    expect(validateAssignableTeamPermissions("messages.read")).toEqual({
      ok: false,
      code: "permissions_must_be_an_array",
      invalidEntries: [],
    });
    expect(validateAssignableTeamPermissions(null)).toEqual({
      ok: false,
      code: "permissions_must_be_an_array",
      invalidEntries: [],
    });
    expect(validateAssignableTeamPermissions(["messages.read", 42])).toEqual({
      ok: false,
      code: "unsupported_permissions",
      invalidEntries: ["<number>"],
    });
    expect(validateAssignableTeamPermissions(["", null, {}])).toEqual({
      ok: false,
      code: "unsupported_permissions",
      invalidEntries: ["<string>", "<object>"],
    });
  });
});
