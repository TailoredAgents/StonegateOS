import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Section } from "@myst-os/ui";
import { ServiceAreaMapNoSSR } from "@/components/ServiceAreaMapNoSSR";
import { PublicPageIntro } from "@/components/public-site/PublicPageIntro";
import { getOrderedAreas } from "@/lib/content";
import { createAreaMetadata } from "@/lib/metadata";
export const metadata = createAreaMetadata("index");
export default function AreasIndex() {
  const areas = getOrderedAreas();
  return (
    <Section className="public-page">
      <div className="public-page-stack space-y-8">
        <PublicPageIntro
          eyebrow="Local crew. Nearby communities."
          title="At home in North Metro Atlanta."
          description="Based in Woodstock, we help our neighbors make room for what’s next. Find your community and explore our pickup coverage."
        />
        <div className="public-split">
          <div className="public-panel public-prose">
            <h2>How far do we travel?</h2>
            <p>
              For half-load jobs and larger, we cover up to 25 miles from
              Woodstock. For minimum-pickup and quarter-load jobs, coverage is
              up to 15 miles.
            </p>
            <h3>Not sure about your address?</h3>
            <p>
              Share your ZIP code when you request a quote, or contact the crew
              to talk through your location.
            </p>
            <Link href="/book" className="public-text-link">
              Check my pickup <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
          </div>
          <ServiceAreaMapNoSSR />
        </div>
        <div className="public-section-heading">
          <h2>Find your community.</h2>
          <p>Local details and services for the places we work.</p>
        </div>
        <div className="public-area-grid">
          {areas.map((area) => (
            <Link
              key={area.slug}
              href={`/areas/${area.slug}`}
              className="public-area-link"
            >
              {area.city || "Cherokee County"}
              <ArrowUpRight size={18} aria-hidden="true" />
            </Link>
          ))}
        </div>
      </div>
    </Section>
  );
}
