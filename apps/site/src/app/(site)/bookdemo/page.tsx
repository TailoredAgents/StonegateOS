import { Badge, Section } from "@myst-os/ui";
import { LeadForm } from "@/components/LeadForm";
import { absoluteUrl } from "@/lib/metadata";

export const metadata = {
  title: "Demolition estimate",
  description: "Get a fast demo estimate range in under a minute, then pick a time and book an on-site estimate.",
  alternates: { canonical: absoluteUrl("/bookdemo") },
  openGraph: {
    title: "Demolition estimate",
    description: "Get a fast demo estimate range in under a minute, then pick a time and book an on-site estimate.",
    url: absoluteUrl("/bookdemo"),
    type: "website"
  }
};

export default function BookDemoPage() {
  return (
    <Section>
      <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[420px_1fr] lg:items-start">
        <header className="space-y-4">
          <Badge tone="highlight">Demolition</Badge>
          <h1 className="font-display text-display text-primary-800">Get your demo estimate range</h1>
          <p className="text-body text-neutral-600">
            Answer quick questions and upload photos for the most accurate range. Then book a time for an on-site
            estimate.
          </p>
          <ul className="space-y-2 text-sm text-neutral-600">
            <li>Decks, sheds, fences, drywall, and light interior demo</li>
            <li>Concrete removal available</li>
            <li>Same-day estimates when available</li>
            <li>Text confirmation after booking</li>
          </ul>
        </header>

        <LeadForm variant="demo" />
      </div>
    </Section>
  );
}

