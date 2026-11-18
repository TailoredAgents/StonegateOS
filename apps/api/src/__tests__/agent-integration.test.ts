import { NextRequest } from "next/server";
import { CampaignTermsSchema } from "@myst-os/sdk";
import {
  canonicalJson,
  payloadHash,
  sanitizeAgentResult,
} from "@/lib/agent-operations";
import {
  AGENT_CATALOG,
  ToolInputSchema,
  catalogTool,
  needsActionApproval,
} from "@/lib/agent-tool-catalog";
import {
  getIntegrationContext,
  bindIntegrationContext,
} from "@/lib/agent-integration-context";
import { normalizedMatchPhone, RecordsSchema } from "@/lib/agent-records";

describe("agent integration boundaries", () => {
  it("preserves timestamps when serializing database records", () => {
    expect(
      sanitizeAgentResult({ createdAt: new Date("2026-11-16T12:00:00Z") }),
    ).toEqual({ createdAt: "2026-11-16T12:00:00.000Z" });
  });
  it("binds approval to the entire immutable payload, independent of key order", () => {
    expect(payloadHash({ b: 2, a: { x: 1 } })).toBe(
      payloadHash({ a: { x: 1 }, b: 2 }),
    );
    expect(payloadHash({ body: "one", recipients: [1, 2] })).not.toBe(
      payloadHash({ body: "one", recipients: [2, 1] }),
    );
    expect(payloadHash({ body: "one" })).not.toBe(payloadHash({ body: "two" }));
    expect(JSON.parse(canonicalJson({ a: 'quotes " and unicode 😀' }))).toEqual(
      { a: 'quotes " and unicode 😀' },
    );
  });
  it("never accepts a caller-supplied principal as an integration context", () => {
    const request = new NextRequest("https://example.test/api/admin/contacts", {
      headers: {
        "x-actor-type": "worker",
        "x-actor-label": "facebook-outreach",
        "x-integration-id": "fake",
      },
    });
    expect(getIntegrationContext(request)).toBeUndefined();
    bindIntegrationContext(request, {
      integrationId: "trusted",
      ownerId: "owner",
      label: "test",
      permissions: ["contacts.read"],
      mutationAllowed: false,
    });
    expect(getIntegrationContext(request)?.mutationAllowed).toBe(false);
    expect(getIntegrationContext(new NextRequest(request))).toBeUndefined();
  });
  it("has an explicit catalog and rejects caller-selected routes, SQL and malformed IDs", () => {
    expect(new Set(AGENT_CATALOG.map((t) => t.name)).size).toBe(
      AGENT_CATALOG.length,
    );
    expect(() => catalogTool("../admin/policy")).toThrow();
    expect(
      ToolInputSchema.safeParse({ url: "https://evil.invalid" }).success,
    ).toBe(false);
    expect(
      ToolInputSchema.safeParse({ params: { id: "../../secrets" } }).success,
    ).toBe(false);
    expect(RecordsSchema.safeParse({ resource: "team_sessions" }).success).toBe(
      false,
    );
    expect(
      RecordsSchema.safeParse({ resource: "messages", limit: 10000 }).success,
    ).toBe(false);
  });
  it("requires approval for sends and releases and cannot manufacture consent", () => {
    const input = ToolInputSchema.parse({ body: { action: "release" } });
    expect(needsActionApproval(catalogTool("message_send"), input)).toBe(true);
    expect(needsActionApproval(catalogTool("call_start"), input)).toBe(true);
    expect(needsActionApproval(catalogTool("campaigns_command"), input)).toBe(
      true,
    );
    expect(
      needsActionApproval(
        catalogTool("campaigns_command"),
        ToolInputSchema.parse({ body: { action: "review" } }),
      ),
    ).toBe(false);
    expect(() =>
      needsActionApproval(
        catalogTool("campaigns_command"),
        ToolInputSchema.parse({ body: { action: "consent" } }),
      ),
    ).toThrow();
  });
  it("honors owner delegation without changing restricted connections", () => {
    for (const name of [
      "message_send",
      "call_start",
      "promotional_sms_release",
      "promotional_sms_import",
      "outreach_qualification_record",
    ]) {
      const input = ToolInputSchema.parse({ body: {} });
      expect(
        needsActionApproval(catalogTool(name), input, "owner_delegated"),
      ).toBe(false);
      expect(needsActionApproval(catalogTool(name), input, "per_action")).toBe(
        true,
      );
    }
    expect(
      needsActionApproval(
        catalogTool("campaigns_command"),
        ToolInputSchema.parse({ body: { action: "consent" } }),
        "owner_delegated",
      ),
    ).toBe(false);
  });
  it("does not leak credential fields nested in business responses", () => {
    expect(
      sanitizeAgentResult({
        body: "customer text",
        nested: [
          {
            passwordHash: "secret",
            shareToken: "secret",
            apiKey: "secret",
            recordingUrl: "private",
            id: "record",
          },
        ],
      }),
    ).toEqual({ body: "customer text", nested: [{ id: "record" }] });
  });
  it("normalizes phones and preserves the old campaign audience unless explicitly extended", () => {
    expect(normalizedMatchPhone("(202) 555-0123")).toBe("+12025550123");
    expect(normalizedMatchPhone("Unknown")).toBeNull();
    const terms = { name: "Test", expiresAt: null, serviceThrough: null };
    expect(CampaignTermsSchema.parse(terms).audience).toBeUndefined();
    expect(
      CampaignTermsSchema.parse({ ...terms, audience: "customers_and_leads" })
        .audience,
    ).toBe("customers_and_leads");
  });
});
