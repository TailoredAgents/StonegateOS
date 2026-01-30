import { Badge, Section } from "@myst-os/ui";
import { LeadForm } from "@/components/LeadForm";
import { absoluteUrl } from "@/lib/metadata";

export const metadata = {
  title: "Brush clearing quote",
  description: "Get a fast brush-clearing estimate in under a minute, then pick a time and book online.",
  alternates: { canonical: absoluteUrl("/bookbrush") },
  openGraph: {
    title: "Brush clearing quote",
    description: "Get a fast brush-clearing estimate in under a minute, then pick a time and book online.",
    url: absoluteUrl("/bookbrush"),
    type: "website"
  }
};

export default function BookBrushPage() {
  return (
    <Section>
      <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[420px_1fr] lg:items-start">
        <header className="space-y-4">
          <Badge tone="highlight">Brush Clearing</Badge>
          <h1 className="font-display text-display text-primary-800">Get your brush clearing estimate</h1>
          <p className="text-body text-neutral-600">
            Upload a few photos and answer quick questions to get a ballpark range. Then pick a time and book online.
          </p>
          <ul className="space-y-2 text-sm text-neutral-600">
            <li>Light brush, overgrowth, and storm debris</li>
            <li>Haul-away included (optional)</li>
            <li>Licensed &amp; insured crews</li>
            <li>Text confirmation after booking</li>
          </ul>
        </header>

        <LeadForm variant="brush" />
      </div>
    </Section>
  );
}

