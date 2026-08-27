import {
  computeEffectivePermissions,
  getTeamOperationKillSwitch,
  getTeamOperationKillSwitchForRisk,
  getDefaultPermissionsForRole,
  permissionMatches,
  restrictOwnerOnlyPermissionsForRole,
  TEAM_PERMISSION_CATALOG,
} from "@/lib/permissions";

describe("team role permissions", () => {
  it("gives sales the mobile work permissions without owner/admin controls", () => {
    const permissions = getDefaultPermissionsForRole("sales");

    expect(permissions).toEqual(
      expect.arrayContaining([
        "messages.read",
        "messages.write",
        "messages.upload",
        "messages.delete",
        "messages.send",
        "appointments.read",
        "appointments.update",
        "appointment_media.capture",
        "appointment_media.manage",
        "payments.read",
        "payments.collect",
        "bookings.manage",
        "calls.place",
        "quotes.read",
        "quotes.write",
        "quotes.send",
        "quotes.update",
      ]),
    );

    expect(permissions).not.toContain("*");
    expect(permissions).not.toContain("audit.read");
    expect(permissions).not.toContain("policy.write");
    expect(permissions).not.toContain("automation.write");
    expect(permissions).not.toContain("expenses.read");
    expect(permissions).not.toContain("quotes.delete");
    expect(permissions).not.toContain("payments.manage");
    expect(permissions).not.toContain("payments.reconcile");
    expect(permissions).not.toContain("calls.reconcile");
  });

  it("keeps owner as full access", () => {
    expect(getDefaultPermissionsForRole("owner")).toEqual([
      "*",
      "contacts.purge",
      "expenses.approve",
      "financials.read",
      "ad_spend.write",
    ]);
  });

  it("scopes the Expense Tracking V2 permissions to submitters and full-access owners", () => {
    const owner = computeEffectivePermissions({
      rolePermissions: getDefaultPermissionsForRole("owner"),
      grant: [],
      deny: [],
    });
    const office = getDefaultPermissionsForRole("office");
    const crew = getDefaultPermissionsForRole("crew");
    const sales = getDefaultPermissionsForRole("sales");
    const readOnly = getDefaultPermissionsForRole("read_only");
    const privilegedExpensePermissions = [
      "expenses.approve",
      "financials.read",
      "ad_spend.write",
    ];

    expect(owner).toEqual(
      expect.arrayContaining([
        "expenses.submit",
        "expenses.approve",
        "financials.read",
        "ad_spend.write",
      ]),
    );
    expect(office).toContain("expenses.submit");
    expect(crew).toContain("expenses.submit");
    expect(crew).not.toContain("expenses.read");
    expect(crew).not.toContain("expenses.write");
    for (const permissions of [office, crew, sales, readOnly]) {
      expect(permissions).toEqual(
        expect.not.arrayContaining(privilegedExpensePermissions),
      );
    }
    expect(sales).not.toContain("expenses.submit");
    expect(readOnly).not.toContain("expenses.submit");
  });

  it("cannot grant owner-only expense authority to a non-owner through wildcards", () => {
    expect(
      restrictOwnerOnlyPermissionsForRole("crew", [
        "expenses.*",
        "financials.read",
        "ad_spend.write",
      ]),
    ).toEqual(expect.arrayContaining(["expenses.submit"]));
    expect(
      restrictOwnerOnlyPermissionsForRole("crew", [
        "expenses.*",
        "financials.read",
        "ad_spend.write",
      ]),
    ).not.toEqual(
      expect.arrayContaining([
        "expenses.approve",
        "financials.read",
        "ad_spend.write",
      ]),
    );
    expect(
      restrictOwnerOnlyPermissionsForRole("owner", [
        "expenses.*",
        "financials.read",
        "ad_spend.write",
      ]),
    ).toEqual(["expenses.*", "financials.read", "ad_spend.write"]);
  });

  it("keeps crew on submitter-scoped expense routes despite legacy grants", () => {
    expect(
      restrictOwnerOnlyPermissionsForRole("crew", [
        "expenses.submit",
        "expenses.read",
        "expenses.write",
        "expenses.export",
      ]),
    ).toEqual(["expenses.submit"]);
    expect(
      restrictOwnerOnlyPermissionsForRole("office", [
        "expenses.submit",
        "expenses.read",
        "expenses.export",
      ]),
    ).toEqual(["expenses.submit", "expenses.read", "expenses.export"]);
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
      expect(permissions).not.toContain("payments.reconcile");
    }

    expect(crew).toEqual(
      expect.arrayContaining([
        "calls.place",
        "appointment_media.capture",
        "payments.read",
        "payments.collect",
      ]),
    );
    expect(crew).not.toContain("appointment_media.manage");
    expect(crew).not.toContain("payments.manage");
    expect(crew).not.toContain("payments.reconcile");

    expect(readOnly).toEqual(
      expect.arrayContaining([
        "appointments.read",
        "messages.read",
        "contacts.read",
        "quotes.read",
      ]),
    );
    expect(readOnly).not.toContain("read");
    expect(readOnly).not.toContain("payments.read");
    expect(readOnly).not.toContain("calls.place");
    expect(readOnly).not.toContain("calls.reconcile");
  });

  it("does not treat the retired generic read value as authority", () => {
    expect(permissionMatches("read", "appointments.read")).toBe(false);
    expect(permissionMatches("read", "messages.read")).toBe(false);
    expect(permissionMatches("read", "payments.read")).toBe(false);
    expect(permissionMatches("payments.read", "payments.read")).toBe(true);
  });

  it("gives every verified person a deny-wins self-session capability", () => {
    expect(
      computeEffectivePermissions({
        rolePermissions: [],
        grant: [],
        deny: [],
      }),
    ).toContain("sessions.manage_self");
    expect(
      computeEffectivePermissions({
        rolePermissions: ["*"],
        grant: [],
        deny: [],
      }),
    ).toContain("sessions.manage_self");
    expect(
      computeEffectivePermissions({
        rolePermissions: ["appointments.read"],
        grant: [],
        deny: ["sessions.manage_self"],
      }),
    ).not.toContain("sessions.manage_self");
  });

  it("materializes a wildcard so granular denies always win", () => {
    const permissions = computeEffectivePermissions({
      rolePermissions: ["*"],
      grant: [],
      deny: ["messages.send", "payments.*"],
    });

    expect(permissions).toContain("access.manage");
    expect(permissions).toContain("messages.read");
    expect(permissions).not.toContain("messages.send");
    expect(permissions).not.toContain("payments.read");
    expect(permissions).not.toContain("payments.manage");
    expect(permissions).not.toContain("access.break_glass");
    expect(permissions).not.toContain("expenses.approve");
    expect(permissions).not.toContain("financials.read");
    expect(permissions).not.toContain("ad_spend.write");
    expect(permissions).not.toContain("*");
  });

  it("allows explicit denies to remove sales permissions", () => {
    const permissions = computeEffectivePermissions({
      rolePermissions: getDefaultPermissionsForRole("sales"),
      grant: [],
      deny: ["quotes.send", "messages.send"],
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

  it("publishes the first-wave CRM permission catalog", () => {
    expect(TEAM_PERMISSION_CATALOG).toEqual(
      expect.arrayContaining([
        "contacts.read",
        "calls.place",
        "calls.reconcile",
        "contacts.write",
        "contacts.delete",
        "properties.read",
        "properties.write",
        "properties.delete",
        "pipeline.read",
        "pipeline.write",
        "messages.write",
        "messages.upload",
        "messages.delete",
        "messages.export",
        "payments.reconcile",
        "sales.read",
        "sales.write",
        "sales.reset",
        "sessions.manage_self",
        "outbound.read",
        "outbound.write",
        "outbound.import",
        "partners.read",
        "partners.write",
        "partners.invite",
        "partners.rates",
        "finance.read",
        "financials.read",
        "ad_spend.write",
        "expenses.submit",
        "expenses.approve",
        "commissions.read",
        "commissions.manage",
        "commissions.pay",
        "marketing.read",
        "marketing.write",
        "marketing.apply",
        "marketing.publish",
        "outbox.dispatch",
      ]),
    );
  });

  it("preserves office and sales CRM workflows without granting owner-only domains", () => {
    const office = getDefaultPermissionsForRole("office");
    const sales = getDefaultPermissionsForRole("sales");

    expect(office).toEqual(
      expect.arrayContaining([
        "contacts.read",
        "contacts.write",
        "contacts.delete",
        "properties.read",
        "properties.write",
        "properties.delete",
        "pipeline.read",
        "pipeline.write",
        "sales.read",
        "sales.write",
        "outbound.read",
        "outbound.write",
        "outbound.import",
        "messages.write",
        "messages.upload",
        "messages.delete",
        "calls.place",
        "calls.reconcile",
      ]),
    );
    expect(sales).toEqual(
      expect.arrayContaining([
        "contacts.read",
        "contacts.write",
        "properties.read",
        "properties.write",
        "pipeline.read",
        "pipeline.write",
        "sales.read",
        "sales.write",
        "outbound.read",
        "outbound.write",
        "outbound.import",
        "messages.write",
        "messages.upload",
        "messages.delete",
        "calls.place",
      ]),
    );

    for (const permissions of [office, sales]) {
      expect(permissions).not.toContain("messages.export");
      expect(permissions).not.toContain("partners.rates");
      expect(permissions).not.toContain("finance.read");
      expect(permissions).not.toContain("commissions.pay");
      expect(permissions).not.toContain("marketing.apply");
      expect(permissions).not.toContain("payments.reconcile");
    }
    expect(sales).not.toContain("calls.reconcile");
    expect(office).toContain("calls.reconcile");
  });

  it("maps high-risk permissions to independently controlled server kill switches", () => {
    const variables = [
      "TEAM_KILL_EXTERNAL_SENDS",
      "TEAM_KILL_FINANCIAL_MUTATIONS",
      "TEAM_KILL_DESTRUCTIVE_MUTATIONS",
      "TEAM_KILL_ADVERTISING_CHANGES",
      "TEAM_KILL_PUBLISHING",
    ] as const;
    const original = Object.fromEntries(
      variables.map((name) => [name, process.env[name]]),
    );

    try {
      process.env["TEAM_KILL_EXTERNAL_SENDS"] = "1";
      process.env["TEAM_KILL_FINANCIAL_MUTATIONS"] = "true";
      process.env["TEAM_KILL_DESTRUCTIVE_MUTATIONS"] = "on";
      process.env["TEAM_KILL_ADVERTISING_CHANGES"] = "1";
      process.env["TEAM_KILL_PUBLISHING"] = "1";

      expect(getTeamOperationKillSwitch(["messages.send"])).toBe(
        "external_sends",
      );
      expect(getTeamOperationKillSwitch(["calls.place"])).toBe(
        "external_sends",
      );
      expect(getTeamOperationKillSwitch(["partners.invite"])).toBe(
        "external_sends",
      );
      expect(
        getTeamOperationKillSwitch(["partners.invite"], {
          ignoredCategories: ["external_sends"],
        }),
      ).toBeNull();
      expect(
        getTeamOperationKillSwitch(["partners.invite", "partners.rates"], {
          ignoredCategories: ["external_sends"],
        }),
      ).toBe("financial_mutations");
      expect(getTeamOperationKillSwitch(["payments.manage"])).toBe(
        "financial_mutations",
      );
      expect(getTeamOperationKillSwitch(["expenses.write"])).toBe(
        "financial_mutations",
      );
      expect(getTeamOperationKillSwitch(["expenses.submit"])).toBe(
        "financial_mutations",
      );
      expect(getTeamOperationKillSwitch(["expenses.approve"])).toBe(
        "financial_mutations",
      );
      expect(getTeamOperationKillSwitch(["ad_spend.write"])).toBe(
        "financial_mutations",
      );
      expect(getTeamOperationKillSwitch(["commissions.manage"])).toBe(
        "financial_mutations",
      );
      expect(getTeamOperationKillSwitch(["partners.rates"])).toBe(
        "financial_mutations",
      );
      expect(getTeamOperationKillSwitch(["contacts.merge"])).toBe(
        "destructive_mutations",
      );
      expect(getTeamOperationKillSwitch(["marketing.apply"])).toBe(
        "advertising_changes",
      );
      process.env["TEAM_KILL_FINANCIAL_MUTATIONS"] = "0";
      expect(getTeamOperationKillSwitch(["ad_spend.write"])).toBe(
        "advertising_changes",
      );
      process.env["TEAM_KILL_FINANCIAL_MUTATIONS"] = "true";
      expect(getTeamOperationKillSwitch(["marketing.publish"])).toBe(
        "publishing",
      );
      expect(getTeamOperationKillSwitch(["contacts.read"])).toBeNull();
      expect(getTeamOperationKillSwitch(["messages.write"])).toBeNull();
      expect(getTeamOperationKillSwitch(["messages.upload"])).toBeNull();
      expect(getTeamOperationKillSwitch(["messages.delete"])).toBeNull();
      expect(getTeamOperationKillSwitch(["payments.reconcile"])).toBeNull();

      expect(getTeamOperationKillSwitchForRisk("external")).toBe(
        "external_sends",
      );
      expect(getTeamOperationKillSwitchForRisk("financial")).toBe(
        "financial_mutations",
      );
      expect(getTeamOperationKillSwitchForRisk("destructive")).toBe(
        "destructive_mutations",
      );
      expect(getTeamOperationKillSwitchForRisk("normal")).toBeNull();
      expect(getTeamOperationKillSwitchForRisk("read")).toBeNull();
    } finally {
      for (const name of variables) {
        const value = original[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});
