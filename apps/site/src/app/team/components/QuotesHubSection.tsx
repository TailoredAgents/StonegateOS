import React, { type ReactElement } from "react";
import { QuotesSection } from "./QuotesSection";
import { QuoteBuilderSection } from "./QuoteBuilderSection";
import { TeamSkeletonCard } from "./TeamSkeleton";
import {
  TEAM_CARD_PADDED,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass
} from "./team-ui";

function quotesHref(hash?: string): string {
  return hash ? `/team?tab=quotes#${hash}` : "/team?tab=quotes";
}

export function QuotesHubSection({
  contactId
}: {
  quoteMode?: string | null;
  contactId?: string;
  memberId?: string;
}): ReactElement {
  return (
    <section className="space-y-6">
      <header className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-3xl">
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-primary-600">
              Quote Workspace
            </p>
            <h2 className={TEAM_SECTION_TITLE}>Create and manage quotes</h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              One quote creation flow, one management view. Search the client,
              build the quote, send it, then track pending approval, approved,
              and rejected quotes from the same tab.
            </p>
          </div>
          <nav className="flex flex-wrap items-center gap-2 text-xs" aria-label="Quote workspace sections">
            <a className={teamButtonClass("primary", "sm")} href={quotesHref("quote-create")}>
              Create quote
            </a>
            <a className={teamButtonClass("secondary", "sm")} href={quotesHref("quote-management")}>
              Manage quotes
            </a>
          </nav>
        </div>
      </header>

      <div id="quote-create" className="scroll-mt-24">
        <React.Suspense fallback={<TeamSkeletonCard title="Loading quote creation" />}>
          <QuoteBuilderSection initialContactId={contactId} />
        </React.Suspense>
      </div>

      <div id="quote-management" className="scroll-mt-24">
        <React.Suspense fallback={<TeamSkeletonCard title="Loading quote management" />}>
          <QuotesSection />
        </React.Suspense>
      </div>
    </section>
  );
}
