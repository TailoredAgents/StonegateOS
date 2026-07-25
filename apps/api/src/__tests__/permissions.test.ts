import {
  computeEffectivePermissions,
  getDefaultPermissionsForRole,
  permissionMatches,
} from "@/lib/permissions";

describe("team role permissions", () => {
  it("gives sales the mobile work permissions without owner/admin controls", () => {
    const permissions = getDefaultPermissionsForRole("sales");

    expect(permissions).toEqual(
      expect.arrayContaining([
        "messages.read",
        "messages.send",
        "appointments.read",
        "appointments.update",
        "appointment_media.capture",
        "appointment_media.manage",
        "payments.read",
        "payments.collect",
        "bookings.manage",
        "quotes.read",
        "quotes.write",
        "quotes.send",
        "quotes.update"
      ])
    );

    expect(permissions).not.toContain("*");
    expect(permissions).not.toContain("audit.read");
    expect(permissions).not.toContain("policy.write");
    expect(permissions).not.toContain("automation.write");
    expect(permissions).not.toContain("expenses.read");
    expect(permissions).not.toContain("quotes.delete");
    expect(permissions).not.toContain("payments.manage");
  });

  it("keeps owner as full access", () => {
    expect(getDefaultPermissionsForRole("owner")).toEqual(["*"]);
  });

  it("grants appointment media and payment collection by role", () => {
    const office = getDefaultPermissionsForRole("office");
    const sales = getDefaultPermissionsForRole("sales");
    const crew = getDefaultPermissionsForRole("crew");
    const readOnly = getDefaultPermissionsForRole("read_only");

    for (const permissions of [office, sales]) {
      expect(permissions).toEqual(
        expect.arrayContaining([
          "appointment_media.capture",
          "appointment_media.manage",
          "payments.read",
          "payments.collect",
        ]),
      );
      expect(permissions).not.toContain("payments.manage");
    }

    expect(crew).toEqual(
      expect.arrayContaining([
        "appointment_media.capture",
        "payments.read",
        "payments.collect",
      ]),
    );
    expect(crew).not.toContain("appointment_media.manage");
    expect(crew).not.toContain("payments.manage");

    expect(readOnly).toEqual(["read"]);
  });

  it("does not let generic read expose payment details", () => {
    expect(permissionMatches("read", "appointments.read")).toBe(true);
    expect(permissionMatches("read", "messages.read")).toBe(true);
    expect(permissionMatches("read", "payments.read")).toBe(false);
    expect(permissionMatches("payments.read", "payments.read")).toBe(true);
  });

  it("allows explicit denies to remove sales permissions", () => {
    const permissions = computeEffectivePermissions({
      rolePermissions: getDefaultPermissionsForRole("sales"),
      grant: [],
      deny: ["quotes.send", "messages.send"]
    });

    expect(permissions).toContain("quotes.read");
    expect(permissions).not.toContain("quotes.send");
    expect(permissions).not.toContain("messages.send");
  });

  it("can deny payment details without removing appointment access", () => {
    const permissions = computeEffectivePermissions({
      rolePermissions: getDefaultPermissionsForRole("sales"),
      grant: [],
      deny: ["payments.read", "payments.collect"],
    });

    expect(permissions).toContain("appointments.read");
    expect(permissions).toContain("appointments.update");
    expect(permissions).not.toContain("payments.read");
    expect(permissions).not.toContain("payments.collect");
  });
});
