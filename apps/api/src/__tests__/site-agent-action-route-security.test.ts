import { readFileSync } from "node:fs";
import { join } from "node:path";

const routeSource = readFileSync(
  join(process.cwd(), "../site/src/app/api/chat/actions/route.ts"),
  "utf8",
);
const agentContractsSource = readFileSync(
  join(process.cwd(), "../../packages/sdk/src/agent-action-contracts.ts"),
  "utf8",
);

const publicChatRouteSource = readFileSync(
  join(process.cwd(), "../site/src/app/api/chat/route.ts"),
  "utf8",
);
const agentRouteSource = readFileSync(
  join(process.cwd(), "../site/src/app/api/team/agent/route.ts"),
  "utf8",
);
const agentClientSource = readFileSync(
  join(process.cwd(), "../site/src/app/team/components/TeamChatClient.tsx"),
  "utf8",
);
const agentReadToolsSource = readFileSync(
  join(process.cwd(), "../site/src/app/api/chat/jarvis-read-tools.ts"),
  "utf8",
);
const publicChatServiceSource = readFileSync(
  join(process.cwd(), "../site/src/app/api/chat/service-api.ts"),
  "utf8",
);
const bookingRouteSource = readFileSync(
  join(process.cwd(), "../site/src/app/api/chat/book/route.ts"),
  "utf8",
);
const sttRouteSource = readFileSync(
  join(process.cwd(), "../site/src/app/api/chat/stt/route.ts"),
  "utf8",
);
const ttsRouteSource = readFileSync(
  join(process.cwd(), "../site/src/app/api/chat/tts/route.ts"),
  "utf8",
);

describe("Site Agent action approval boundary", () => {
  it("denies bot/service mutation requests and authenticates a human before parsing", () => {
    const botCheck = routeSource.indexOf("isAgentBotRequest(request)");
    const botDenial = routeSource.indexOf(
      "Agent and service requests may propose actions",
    );
    const principalCheck = routeSource.indexOf(
      "requireTeamRequestPrincipal(request",
    );
    const bodyParse = routeSource.indexOf("readBoundedRequestBytes(");

    expect(botCheck).toBeGreaterThan(-1);
    expect(botDenial).toBeGreaterThan(botCheck);
    expect(principalCheck).toBeGreaterThan(botDenial);
    expect(bodyParse).toBeGreaterThan(principalCheck);
  });

  it("uses effective permissions instead of role slugs", () => {
    expect(routeSource).not.toContain("requireTeamRole");
    expect(routeSource).not.toMatch(/roles\s*:\s*\[/);
    expect(routeSource).toContain(
      "hasTeamPermission(auth.principal, permission)",
    );
  });

  it.each([
    [
      "create_contact",
      ["contacts.write", "properties.write", "pipeline.write"],
    ],
    ["create_quote", ["quotes.write", "contacts.read", "properties.read"]],
    ["create_task", ["appointments.update"]],
    ["add_contact_note", ["contacts.write"]],
    ["create_reminder", ["contacts.write"]],
    ["book_appointment", ["bookings.manage"]],
    ["cancel_appointment", ["appointments.update", "messages.send"]],
    ["reschedule_appointment", ["appointments.update"]],
    ["send_text", ["messages.write", "messages.send"]],
    ["google_ads_recommendations_bulk_update", ["marketing.write"]],
    ["google_ads_recommendations_bulk_apply", ["marketing.apply"]],
  ] as const)(
    "declares all required permissions for %s",
    (action, permissions) => {
      const permissionPattern = permissions
        .map((permission) => `"${permission.replaceAll(".", "\\.")}"`)
        .join("\\s*,\\s*");
      expect(agentContractsSource).toMatch(
        new RegExp(`${action}:\\s*\\[\\s*${permissionPattern}\\s*\\]`),
      );
    },
  );

  it("forwards the already verified human principal explicitly", () => {
    expect(routeSource).toContain(
      "const response = await callAdminApiAs(auth.principal, path",
    );
    expect(routeSource).not.toMatch(/\bcallAdminApi\(/);
    expect(routeSource).not.toContain('error: "admin_key_missing"');
    expect(routeSource).toContain('"/api/admin/agent/action-executions"');
  });

  it("protects the Agent, STT, and TTS reads with effective permissions", () => {
    for (const source of [agentRouteSource, sttRouteSource, ttsRouteSource]) {
      expect(source).toContain("requireTeamRequestPrincipal(");
      expect(source).toContain('permissions: "messages.read"');
      expect(source).not.toContain("requireTeamRole");
      expect(source).not.toMatch(/roles\s*:\s*\[/);
      expect(source).not.toContain("ADMIN_SESSION_COOKIE");
      expect(source).not.toContain("adminSessionMatches");
    }
    expect(
      agentRouteSource.indexOf("requireTeamRequestPrincipal(request"),
    ).toBeLessThan(
      agentRouteSource.indexOf("handleChatRequest(request, auth.principal)"),
    );
    expect(agentClientSource).toContain('fetch("/api/team/agent"');
    expect(agentClientSource).toContain("ACTION_REVIEW_DETAILS");
    expect(agentClientSource).toContain(
      "Any write appears below with its exact",
    );
    expect(agentClientSource).toContain("reviewDetails.permission");
    expect(agentClientSource).toContain("reviewDetails.effect");
    expect(publicChatRouteSource).toMatch(
      /const requestedAudience\s*=\s*verifiedTeamPrincipal\s*\|\|\s*isBot/u,
    );
    expect(publicChatRouteSource).not.toContain('body.mode === "team"');
  });

  it("forwards the verified principal through Agent live-data tools", () => {
    expect(publicChatRouteSource).toContain(
      "callAdminApiAs(teamPrincipal, path, init)",
    );
    expect(publicChatRouteSource).toContain(
      "resolveContactTarget(message, principal)",
    );
    expect(agentReadToolsSource).toContain(
      'error: "verified_principal_missing"',
    );
    expect(agentReadToolsSource).toMatch(/\bctx\s*\.\s*callApi\s*\(\s*path\b/u);
    expect(agentReadToolsSource).not.toContain('"x-api-key"');
    expect(agentReadToolsSource).not.toContain("adminKey");
  });

  it("books through the verified human principal and independent API check", () => {
    const authIndex = bookingRouteSource.indexOf(
      "requireTeamRequestPrincipal(request",
    );
    const upstreamIndex = bookingRouteSource.indexOf(
      "executeApprovedAgentAction(request)",
    );

    expect(authIndex).toBeGreaterThan(-1);
    expect(bookingRouteSource).toContain('permissions: "bookings.manage"');
    expect(upstreamIndex).toBeGreaterThan(authIndex);
    expect(bookingRouteSource).toContain('from "../actions/route"');
    expect(bookingRouteSource).not.toContain("ADMIN_SESSION_COOKIE");
    expect(bookingRouteSource).not.toContain("adminSessionMatches");
    expect(bookingRouteSource).not.toContain('"x-api-key"');
  });

  it("uses a named, narrow API service identity for the public booking handoff", () => {
    expect(publicChatServiceSource).toContain(
      'headers.set("x-actor-type", "worker")',
    );
    expect(publicChatServiceSource).toContain(
      'headers.set("x-actor-label", "public-chat-booking")',
    );
    expect(publicChatRouteSource).toContain(
      'callPublicChatBookingApi("/api/admin/tools/contact"',
    );
    expect(publicChatRouteSource).toContain(
      'callPublicChatBookingApi("/api/admin/booking/assist"',
    );
    expect(publicChatRouteSource).toContain(
      'callPublicChatBookingApi("/api/admin/booking/book"',
    );
  });
});
