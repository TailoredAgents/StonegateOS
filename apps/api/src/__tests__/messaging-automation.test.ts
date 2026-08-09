import fs from "node:fs";
import path from "node:path";
import {
  evaluateMessagingAutomationPrecedence,
  MESSAGING_AUTOMATION_PRECEDENCE,
  normalizeMessagingAutomationMode,
  toStoredLegacyAutomationMode,
  toStoredSalesAutopilotMode,
} from "@/lib/messaging-automation";
import {
  DEFAULT_SALES_AUTOPILOT_POLICY,
  evaluateSalesPlannerAutosendPolicy,
  isSalesAutopilotLiveReplyEnabled,
  type SalesAutopilotPolicy,
} from "@/lib/policy";
import { buildTeamRouteSecurityContract } from "@/lib/team-route-security-manifest";

const ROOT = path.resolve(__dirname, "../..");
const read = (relativePath: string): string =>
  fs.readFileSync(path.join(ROOT, relativePath), "utf8");

function automaticPolicy(
  overrides: Partial<SalesAutopilotPolicy> = {},
): SalesAutopilotPolicy {
  return {
    ...DEFAULT_SALES_AUTOPILOT_POLICY,
    mode: "full",
    channelModes: { sms: "full", email: "full", dm: "full" },
    emergencyStop: false,
    plannerAutoSendEnabled: true,
    plannerAutoSendChannels: ["sms", "email", "dm"],
    plannerAutoSendActions: ["follow_up_quote"],
    liveReplyAutonomyEnabled: true,
    liveReplyAutonomyChannels: ["sms"],
    liveReplyAutonomyActions: ["reply_now"],
    ...overrides,
  };
}

describe("Messaging Automation public mode", () => {
  it.each([
    ["off", "off"],
    ["draft", "off"],
    ["assist", "assist"],
    ["partial", "assist"],
    ["automatic", "automatic"],
    ["auto", "automatic"],
    ["full", "automatic"],
  ] as const)("normalizes %s as %s", (stored, expected) => {
    expect(normalizeMessagingAutomationMode(stored)).toBe(expected);
  });

  it("preserves both legacy storage dialects behind the public labels", () => {
    expect(toStoredSalesAutopilotMode("off")).toBe("off");
    expect(toStoredSalesAutopilotMode("assist")).toBe("partial");
    expect(toStoredSalesAutopilotMode("automatic")).toBe("full");
    expect(toStoredLegacyAutomationMode("off")).toBe("draft");
    expect(toStoredLegacyAutomationMode("assist")).toBe("assist");
    expect(toStoredLegacyAutomationMode("automatic")).toBe("auto");
  });

  it("documents the fixed public precedence in order", () => {
    expect(MESSAGING_AUTOMATION_PRECEDENCE).toEqual([
      "Do Not Contact",
      "Human takeover or pause",
      "Quiet hours or sending cap",
      "Channel override",
      "Global mode",
    ]);
  });

  it.each([
    [
      {
        dnc: true,
        humanTakeover: true,
        paused: true,
        quietHoursActive: true,
        capReached: true,
        channelOverride: "automatic" as const,
        globalMode: "automatic" as const,
      },
      "dnc",
    ],
    [
      {
        humanTakeover: true,
        paused: true,
        quietHoursActive: true,
        capReached: true,
        channelOverride: "automatic" as const,
        globalMode: "automatic" as const,
      },
      "human_takeover",
    ],
    [
      {
        paused: true,
        quietHoursActive: true,
        capReached: true,
        channelOverride: "automatic" as const,
        globalMode: "automatic" as const,
      },
      "paused",
    ],
    [
      {
        quietHoursActive: true,
        capReached: true,
        channelOverride: "automatic" as const,
        globalMode: "automatic" as const,
      },
      "quiet_hours",
    ],
    [
      {
        capReached: true,
        channelOverride: "automatic" as const,
        globalMode: "automatic" as const,
      },
      "cap_reached",
    ],
    [
      {
        channelOverride: "assist" as const,
        globalMode: "automatic" as const,
      },
      "channel_override",
    ],
    [{ globalMode: "automatic" as const }, "global_mode"],
  ])("uses the first effective rule %#", (input, reason) => {
    expect(evaluateMessagingAutomationPrecedence(input).reason).toBe(reason);
  });

  it("keeps Assist approval-only and Automatic eligible", () => {
    expect(
      evaluateMessagingAutomationPrecedence({
        channelOverride: "assist",
        globalMode: "automatic",
      }),
    ).toMatchObject({
      decision: "approval_required",
      automaticSendAllowed: false,
    });
    expect(
      evaluateMessagingAutomationPrecedence({ globalMode: "automatic" }),
    ).toMatchObject({ decision: "automatic", automaticSendAllowed: true });
  });
});

describe("Messaging Automation runtime policy enforcement", () => {
  it.each([
    ["dnc", { dnc: true }],
    ["human_takeover", { humanTakeover: true }],
    ["paused", { paused: true }],
    ["quiet_hours", { quietHoursActive: true }],
    ["cap_reached", { capReached: true }],
  ] as const)("blocks planner sends for %s", (reason, guard) => {
    expect(
      evaluateSalesPlannerAutosendPolicy(automaticPolicy(), {
        channel: "sms",
        actionType: "follow_up_quote",
        ...guard,
      }),
    ).toMatchObject({ allowed: false, reason });
  });

  it("makes stored Partial behave as public Assist instead of auto-sending", () => {
    const result = evaluateSalesPlannerAutosendPolicy(
      automaticPolicy({
        mode: "partial",
        channelModes: { sms: "partial", email: "partial", dm: "partial" },
      }),
      { channel: "sms", actionType: "follow_up_quote" },
    );
    expect(result).toMatchObject({
      allowed: false,
      reason: "action_requires_automatic_mode",
    });
  });

  it("allows an allowlisted planner action only in Automatic", () => {
    expect(
      evaluateSalesPlannerAutosendPolicy(automaticPolicy(), {
        channel: "sms",
        actionType: "follow_up_quote",
      }),
    ).toMatchObject({ allowed: true, reason: null });
  });

  it("applies the global emergency stop to planner and live replies", () => {
    const policy = automaticPolicy({ emergencyStop: true });
    expect(
      evaluateSalesPlannerAutosendPolicy(policy, {
        channel: "sms",
        actionType: "follow_up_quote",
      }),
    ).toMatchObject({ allowed: false, reason: "emergency_stop" });
    expect(isSalesAutopilotLiveReplyEnabled(policy, "sms")).toBe(false);
  });
});

describe("Messaging Automation route and UI contracts", () => {
  const automationRoute = read("app/api/admin/automation/route.ts");
  const leadRoute = read("app/api/admin/automation/lead/route.ts");
  const autopilotRoute = read("app/api/admin/sales/autopilot/route.ts");
  const signatureRoute = read(
    "app/api/admin/sales/autopilot/signature/route.ts",
  );
  const salesAutopilot = read("src/lib/sales-autopilot.ts");
  const outboxProcessor = read("src/lib/outbox-processor.ts");
  const siteProxy = read("../site/src/app/api/team/automation/lead/route.ts");
  const section = read("../site/src/app/team/components/AutomationSection.tsx");
  const siteActions = read("../site/src/app/team/actions.ts");
  const reviewForm = read(
    "../site/src/app/team/components/AutomationReviewForm.tsx",
  );
  const leadControl = read(
    "../site/src/app/team/components/LeadAutomationControlClient.tsx",
  );

  it("uses automation permissions while preserving Policy signature access", () => {
    expect(autopilotRoute).toContain('"automation.read"');
    expect(autopilotRoute).toContain('"policy.read"');
    expect(autopilotRoute).toContain(
      'requiredPermissions: ["automation.write"]',
    );
    expect(signatureRoute).toContain('requiredPermissions: ["policy.write"]');
    expect(autopilotRoute).toContain("publicPolicy: publicPolicy(policy)");
  });

  it("classifies both settings writes as external and idempotent in the route manifest", () => {
    for (const [route, method] of [
      ["app/api/admin/automation/route.ts", "POST"],
      ["app/api/admin/sales/autopilot/route.ts", "PATCH"],
    ] as const) {
      expect(
        buildTeamRouteSecurityContract({
          route,
          method,
          permissions: ["automation.write"],
        }),
      ).toMatchObject({ risk: "external", requiresIdempotency: true });
    }
  });

  it("validates writes, synchronizes compatibility channels, and audits evidence", () => {
    expect(automationRoute).toContain("normalizeMessagingAutomationMode");
    expect(automationRoute).toContain("fieldErrors");
    expect(autopilotRoute).toContain("db.transaction");
    expect(autopilotRoute).toContain("automationSettings");
    expect(autopilotRoute).toContain("toStoredLegacyAutomationMode");
    expect(autopilotRoute).toContain(
      'readInt("dailyAutomaticSendCap", 1, 1000)',
    );
    expect(autopilotRoute).toContain(
      'auditAction: "sales.autopilot.policy.updated"',
    );
    expect(autopilotRoute).toContain("claimTeamMutationIdempotency");
    expect(autopilotRoute).toContain("completeTeamMutationIdempotency");
    expect(autopilotRoute).toContain("mutation.audit.insertSuccess");
    expect(autopilotRoute).toContain("pg_advisory_xact_lock_shared");
    expect(autopilotRoute).toContain("actualVersion !== expectedVersion");
    expect(autopilotRoute).toContain("before:");
    expect(autopilotRoute).toContain("after:");
  });

  it("rechecks lead guards, quiet hours, caps, and modes before dispatch", () => {
    expect(salesAutopilot).toContain("evaluateMessagingAutomationPrecedence");
    expect(salesAutopilot).toContain("contacts.doNotContact");
    expect(salesAutopilot).toContain("leadAutomationStates.humanTakeover");
    expect(salesAutopilot).toContain("nextQuietHoursEnd(");
    expect(salesAutopilot).toContain("policy.dailyAutomaticSendCap");
    expect(salesAutopilot).toContain('error: "automatic_send_cap_reached"');
    const bypassDefinition = outboxProcessor.slice(
      outboxProcessor.indexOf("const bypassQuietHours"),
      outboxProcessor.indexOf("if (isAutomated && !bypassQuietHours)"),
    );
    expect(bypassDefinition).not.toContain('metadata?.["salesAutopilot"]');
  });

  it("searches real active leads and distinguishes failures from empty results", () => {
    expect(leadRoute).toContain("innerJoin(contacts");
    expect(leadRoute).toContain("isNull(contacts.deletedAt)");
    expect(leadRoute).toContain("searchComplete: true");
    expect(leadRoute).toContain("lead_not_found");
    expect(leadRoute).toContain("UUID_PATTERN");
    expect(siteProxy.indexOf("requireTeamPrincipal(")).toBeLessThan(
      siteProxy.indexOf("request.nextUrl"),
    );
    expect(siteProxy).toContain('permissions: "automation.read"');
    expect(leadControl).toContain("No matching active leads were found");
    expect(leadControl).toContain("Lead search failed");
    expect(leadControl).not.toContain('placeholder="Lead UUID"');
  });

  it("surfaces one public mode, precedence, emergency stop, and reviewed diffs", () => {
    expect(section).toContain("Off, Assist, or Automatic");
    expect(section).not.toContain(">Partial<");
    expect(section).not.toContain(">Full<");
    expect(section).toContain("Do Not Contact");
    expect(section).toContain("Quiet hours or sending cap");
    expect(section).toContain('name="emergencyStop"');
    expect(section).toContain("Advanced compatibility status");
    expect(reviewForm).toContain("Review pending changes");
    expect(reviewForm).toContain("I reviewed these settings");
    expect(reviewForm).toContain(
      "protects against stale saves and duplicate clicks",
    );
    expect(reviewForm).toContain('name="expectedVersion"');
    expect(reviewForm).toContain('name="idempotencyKey"');
    expect(reviewForm).toContain("event.preventDefault()");
    expect(reviewForm).toContain(
      "startTransition(() => formAction(submission))",
    );
    expect(section).not.toContain('key={settingsVersion ?? "unavailable"}');
    expect(reviewForm).toContain("[expectedVersion, idempotencyKey]");
    expect(reviewForm).toContain(
      "actionState.ok !== true || changes.length === 0",
    );
    expect(reviewForm).toContain("{showActionFeedback ? (");
    expect(siteActions).toContain('"If-Match": expectedVersion');
    expect(siteActions).toContain('"Idempotency-Key": idempotencyKey');
    expect(siteActions).toContain("requireReceipt: true");
    expect(siteActions).toContain(
      'formData.get("automationReviewConfirmed") !== "on"',
    );
    expect(leadControl).toContain("I reviewed this lead and channel override");
  });
});
