import { randomUUID } from "node:crypto";
import type { ReactElement } from "react";
import type { TeamRequestPrincipal } from "@/lib/team-principal";
import { getPublicCompanyProfile } from "@/lib/company";
import { hasTeamPermissionValue } from "@/lib/team-permissions";
import QuoteV2ComposerClient from "./QuoteV2ComposerClient";
import { teamStatePanelClass } from "./team-ui";
import { isQuoteV2SenderFeatureEnabled } from "../lib/quote-v2-staff-feature";
import { callAdminApiAs } from "../lib/api";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type InitialPartnerQuoteContext = {
  accountId: string;
  targetType: string;
  targetId: string;
};

type VerifiedPartnerQuoteContext = {
  accountId: string;
  accountName: string;
  target: { type: "location" | "booking"; id: string };
  targetLabel: string;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function verifyPartnerQuoteContext(input: {
  principal: TeamRequestPrincipal;
  context: InitialPartnerQuoteContext;
  contactId?: string;
  propertyId?: string;
}): Promise<VerifiedPartnerQuoteContext | null> {
  if (
    !["location", "booking"].includes(input.context.targetType) ||
    !UUID_PATTERN.test(input.context.accountId) ||
    !UUID_PATTERN.test(input.context.targetId) ||
    !input.contactId ||
    !UUID_PATTERN.test(input.contactId) ||
    !input.propertyId ||
    !UUID_PATTERN.test(input.propertyId)
  ) {
    return null;
  }
  const response = await callAdminApiAs(
    input.principal,
    `/api/admin/partner-management/v1/accounts/${encodeURIComponent(input.context.accountId)}/quote-context`,
    { timeoutMs: 10_000 },
  ).catch(() => null);
  if (!response?.ok) return null;
  const payload = record(await response.json().catch(() => null));
  const account = record(payload?.["account"]);
  const targets = payload?.["targets"];
  if (
    payload?.["ok"] !== true ||
    account?.["id"] !== input.context.accountId ||
    typeof account["name"] !== "string" ||
    !Array.isArray(targets) ||
    targets.length > 100
  ) {
    return null;
  }
  const target = (targets as unknown[]).find((candidate) => {
    const item = record(candidate);
    return (
      item?.["type"] === input.context.targetType &&
      item["id"] === input.context.targetId &&
      item["contactId"] === input.contactId &&
      item["propertyId"] === input.propertyId
    );
  });
  const item = record(target);
  if (!item || typeof item["label"] !== "string") return null;
  return {
    accountId: input.context.accountId,
    accountName: account["name"].slice(0, 240),
    target: {
      type: input.context.targetType as "location" | "booking",
      id: input.context.targetId,
    },
    targetLabel: item["label"].slice(0, 240),
  };
}

export async function QuoteV2BuilderSection({
  principal,
  initialContactId,
  initialPropertyId,
  initialPartnerContext,
}: {
  principal: TeamRequestPrincipal;
  initialContactId?: string;
  initialPropertyId?: string;
  initialPartnerContext?: InitialPartnerQuoteContext;
}): Promise<ReactElement> {
  const company = getPublicCompanyProfile();
  const hasSendPermission = hasTeamPermissionValue(
    principal.permissions,
    "quotes.send",
  );
  const senderEnabled = isQuoteV2SenderFeatureEnabled();
  const canSend = hasSendPermission && senderEnabled;
  const siteUrl = process.env["NEXT_PUBLIC_SITE_URL"]?.trim() || null;
  const validSiteUrl = (() => {
    if (!siteUrl) return null;
    try {
      const parsed = new URL(siteUrl);
      return parsed.protocol === "https:" || parsed.protocol === "http:"
        ? parsed.toString()
        : null;
    } catch {
      return null;
    }
  })();
  const verifiedPartnerContext = initialPartnerContext
    ? await verifyPartnerQuoteContext({
        principal,
        context: initialPartnerContext,
        contactId: initialContactId,
        propertyId: initialPropertyId,
      })
    : null;
  if (initialPartnerContext && !verifiedPartnerContext) {
    return (
      <div className={teamStatePanelClass("danger")} role="alert">
        <p className="font-semibold">Partner quote context is unavailable</p>
        <p className="mt-1">
          The account, contact, property, and Partner job or location could not
          be verified as one tenant-owned target. Open Partner Administration
          and choose the target again. No quote draft was created.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {!canSend ? (
        <div className={teamStatePanelClass("warning")} role="status">
          <p className="font-semibold">Draft access only</p>
          <p className="mt-1">
            {hasSendPermission
              ? "You can build and autosave this proposal, but the V2 sender is not enabled for this rollout cohort."
              : "You can build and autosave this proposal, but a teammate with quote-send permission must freeze and issue it."}
          </p>
        </div>
      ) : null}
      <QuoteV2ComposerClient
        canSend={canSend}
        canQuickCreate={hasTeamPermissionValue(
          principal.permissions,
          "contacts.write",
        )}
        preparerName={principal.name}
        recoveryId={randomUUID()}
        initialContactId={initialContactId}
        initialPropertyId={initialPropertyId}
        partnerContext={
          verifiedPartnerContext
            ? {
                accountId: verifiedPartnerContext.accountId,
                target: verifiedPartnerContext.target,
                accountName: verifiedPartnerContext.accountName,
                targetLabel: verifiedPartnerContext.targetLabel,
              }
            : undefined
        }
        issuer={{
          legalName: company.name,
          displayName: company.name,
          address: `${company.hqCity}, ${company.hqState}, ${company.hqCountry}`,
          email: company.email,
          phoneE164: company.phoneE164,
          website: validSiteUrl,
          logoAssetId: null,
          supportMessage: `${company.serviceAreaSummary} ${company.hoursSummary}`,
        }}
      />
    </div>
  );
}
