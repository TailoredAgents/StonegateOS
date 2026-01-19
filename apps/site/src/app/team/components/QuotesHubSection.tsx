import React, { type ReactElement } from "react";
import { QuotesSection } from "./QuotesSection";
import { InstantQuotesSection } from "./InstantQuotesSection";
import { QuoteBuilderSection } from "./QuoteBuilderSection";
import { CanvassSection } from "./CanvassSection";
import { TeamSkeletonCard } from "./TeamSkeleton";
import { TEAM_CARD_PADDED, TEAM_SECTION_SUBTITLE, TEAM_SECTION_TITLE, teamButtonClass } from "./team-ui";

type QuoteMode = "builder" | "canvass" | null;

function normalizeMode(mode?: string | null): QuoteMode {
  const value = typeof mode === "string" ? mode.trim().toLowerCase() : "";
  if (value === "builder" || value === "create") return "builder";
  if (value === "canvass" || value === "canvas") return "canvass";
  return null;
}

function quotesHref(params: { quoteMode?: QuoteMode; contactId?: string; memberId?: string }): string {
  const query = new URLSearchParams();
  query.set("tab", "quotes");
  if (params.quoteMode) query.set("quoteMode", params.quoteMode);
  if (params.contactId) query.set("contactId", params.contactId);
  if (params.memberId) query.set("memberId", params.memberId);
  return `/team?${query.toString()}`;
}

export async function QuotesHubSection({
  quoteMode,
  contactId,
  memberId
}: {
  quoteMode?: string | null;
  contactId?: string;
  memberId?: string;
}): Promise<ReactElement> {
  const mode = normalizeMode(quoteMode);
  const showBuilder = mode === "builder";
  const showCanvass = mode === "canvass";

  return (
    <section className="space-y-6">
      <header className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className={TEAM_SECTION_TITLE}>Quotes</h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              Formal proposals + quick builder + canvass mode. Instant Quotes remain separate (AI/photo quotes), but show here for visibility.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <a className={teamButtonClass("secondary", "sm")} href={quotesHref({})}>
              Reset view
            </a>
            <a
              className={teamButtonClass(showBuilder ? "primary" : "secondary", "sm")}
              href={quotesHref({ quoteMode: "builder", contactId, memberId })}
            >
              Create quote
            </a>
            <a
              className={teamButtonClass(showCanvass ? "primary" : "secondary", "sm")}
              href={quotesHref({ quoteMode: "canvass", contactId, memberId })}
            >
              Canvass mode
            </a>
          </div>
        </div>
      </header>

      <div className="space-y-4">
        <React.Suspense fallback={<TeamSkeletonCard title="Loading quotes" />}>
          <QuotesSection />
        </React.Suspense>
        <React.Suspense fallback={<TeamSkeletonCard title="Loading instant quotes" />}>
          <InstantQuotesSection />
        </React.Suspense>
      </div>

      <div className="space-y-4">
        {showBuilder ? (
          <React.Suspense fallback={<TeamSkeletonCard title="Loading quote builder" />}>
            <QuoteBuilderSection initialContactId={contactId} />
          </React.Suspense>
        ) : (
          <div className={TEAM_CARD_PADDED}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Create quote</h3>
                <p className="mt-1 text-sm text-slate-600">Build a formal quote for a contact/property and optionally email it.</p>
              </div>
              <a className={teamButtonClass("primary", "sm")} href={quotesHref({ quoteMode: "builder", contactId, memberId })}>
                Open builder
              </a>
            </div>
          </div>
        )}

        {showCanvass ? (
          <React.Suspense fallback={<TeamSkeletonCard title="Loading canvass mode" />}>
            <CanvassSection initialContactId={contactId} memberId={memberId} />
          </React.Suspense>
        ) : (
          <div className={TEAM_CARD_PADDED}>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-900">Canvass mode</h3>
                <p className="mt-1 text-sm text-slate-600">Door-to-door flow: create a canvass lead, build a quote, and manage manual follow-ups.</p>
              </div>
              <a className={teamButtonClass("primary", "sm")} href={quotesHref({ quoteMode: "canvass", contactId, memberId })}>
                Open canvass
              </a>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

