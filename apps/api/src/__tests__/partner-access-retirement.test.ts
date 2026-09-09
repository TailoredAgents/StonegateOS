import { NextRequest } from "next/server";
import { partnerAccessWorkflowRetired } from "../lib/partner-access-retirement";
import { POST as emailChallenge } from "../../app/api/portal/v2/onboarding/email-challenges/route";
import { POST as submitApplication } from "../../app/api/portal/v2/onboarding/application/submit/route";
import { POST as respondApplication } from "../../app/api/portal/v2/onboarding/application/respond/route";
import { POST as withdrawApplication } from "../../app/api/portal/v2/onboarding/application/withdraw/route";

describe("retired self-service partner access", () => {
  it.each([
    ["email verification request", emailChallenge],
    ["application submission", submitApplication],
    ["application response", respondApplication],
    ["application withdrawal", withdrawApplication],
    ["shared retirement response", partnerAccessWorkflowRetired],
  ] as const)(
    "fails closed without interpreting or echoing the %s body",
    async (_label, handler) => {
      const response = handler(
        new NextRequest(
          "https://api.stonegate.example/api/portal/v2/onboarding",
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-correlation-id": "portal_retired_test_123",
            },
            body: JSON.stringify({
              email: "private@example.com",
              companyName: "private company",
              accountId: "private-account",
            }),
          },
        ),
      );
      expect(response.status).toBe(410);
      expect(response.headers.get("cache-control")).toContain(
        "private, no-store",
      );
      const payload: unknown = await response.json();
      expect(payload).toMatchObject({
        ok: false,
        code: "workflow_retired",
        retryable: false,
      });
      if (
        !payload ||
        typeof payload !== "object" ||
        !("message" in payload) ||
        typeof payload.message !== "string"
      ) {
        throw new Error("Missing retirement message");
      }
      expect(payload.message).toContain("sales@stonegatejunkremoval.com");
      expect(payload.message).toContain("404-777-2631");
      expect(JSON.stringify(payload)).not.toContain("private@example.com");
      expect(JSON.stringify(payload)).not.toContain("private-account");
    },
  );
});
