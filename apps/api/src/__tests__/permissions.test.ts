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
