import type { ReactElement } from "react";
import {
  QUOTE_WORKSPACE_MODES,
  normalizeQuoteWorkspaceMode,
  quoteWorkspaceHref,
  type QuoteWorkspaceMode,
} from "../quotes-workspace";
import {
  TEAM_CARD_PADDED,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass,
} from "./team-ui";

const WORKSPACE_LABELS: Record<QuoteWorkspaceMode, string> = {
  create: "Create quote",
  manage: "Manage quotes",
  instant: "Instant quotes",
};

export async function QuotesHubSection({
  quoteMode,
  contactId,
  propertyId,
  instantQuoteId,
  partnerAccountId,
  partnerTargetType,
  partnerTargetId,
}: {
  quoteMode?: string | null;
  contactId?: string;
  propertyId?: string;
  instantQuoteId?: string;
  partnerAccountId?: string;
  partnerTargetType?: string;
  partnerTargetId?: string;
  memberId?: string;
}): Promise<ReactElement> {
  const activeMode = normalizeQuoteWorkspaceMode(quoteMode);
  let workspace: ReactElement;
  if (activeMode === "create") {
    const { QuoteBuilderSection } = await import("./QuoteBuilderSection");
    workspace = await QuoteBuilderSection({
      initialContactId: contactId,
      initialPropertyId: propertyId,
      instantQuoteId,
      partnerAccountId,
      partnerTargetType,
      partnerTargetId,
    });
  } else if (activeMode === "instant") {
    const { InstantQuotesSection } = await import("./InstantQuotesSection");
    if (instantQuoteId) {
      const { InstantQuoteDetail } = await import("./InstantQuoteDetail");
      workspace = (
        <div className="space-y-6">
          <InstantQuoteDetail quoteId={instantQuoteId} />
          {await InstantQuotesSection({ compact: true })}
        </div>
      );
    } else {
      workspace = await InstantQuotesSection({ compact: true });
    }
  } else {
    const { QuotesSection } = await import("./QuotesSection");
    workspace = await QuotesSection();
  }

  return (
    <section className="space-y-6">
      <header className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[color:var(--team-link)]">
              Quote Workspace
            </p>
            <h2 className={TEAM_SECTION_TITLE}>
              {WORKSPACE_LABELS[activeMode]}
            </h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              Create accurate proposals, manage their lifecycle, and convert
              instant estimates without loading unrelated workspaces.
            </p>
          </div>
          <nav
            className="flex flex-wrap items-center gap-2 text-xs"
            aria-label="Quote workspace sections"
          >
            {QUOTE_WORKSPACE_MODES.map((mode) => (
              <a
                key={mode}
                className={teamButtonClass(
                  activeMode === mode ? "primary" : "secondary",
                  "sm",
                )}
                href={quoteWorkspaceHref(mode)}
                aria-current={activeMode === mode ? "page" : undefined}
              >
                {WORKSPACE_LABELS[mode]}
              </a>
            ))}
          </nav>
        </div>
      </header>

      <div id={`quote-${activeMode}`} className="scroll-mt-24">
        {workspace}
      </div>
    </section>
  );
}
