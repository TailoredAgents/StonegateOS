import { computeEffectivePermissions, getDefaultPermissionsForRole } from "@/lib/permissions";

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
  });

  it("keeps owner as full access", () => {
    expect(getDefaultPermissionsForRole("owner")).toEqual(["*"]);
  });

  it("grants appointment media permissions by role", () => {
    const office = getDefaultPermissionsForRole("office");
    const sales = getDefaultPermissionsForRole("sales");
    const crew = getDefaultPermissionsForRole("crew");
    const readOnly = getDefaultPermissionsForRole("read_only");

    for (const permissions of [office, sales]) {
      expect(permissions).toEqual(
        expect.arrayContaining([
          "appointment_media.capture",
          "appointment_media.manage",
        ]),
      );
    }

    expect(crew).toContain("appointment_media.capture");
    expect(crew).not.toContain("appointment_media.manage");
    expect(readOnly).toEqual(["read"]);
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
});
