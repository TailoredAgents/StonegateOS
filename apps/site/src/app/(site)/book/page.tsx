import { Badge, Section } from "@myst-os/ui";
import { LeadForm } from "@/components/LeadForm";
import { absoluteUrl } from "@/lib/metadata";

export const metadata = {
  title: "Instant junk removal quote",
  description: "Get an instant quote in under a minute, then pick a time and book online.",
  alternates: { canonical: absoluteUrl("/book") },
  openGraph: {
    title: "Instant junk removal quote",
    description: "Get an instant quote in under a minute, then pick a time and book online.",
    url: absoluteUrl("/book"),
    type: "website"
  }
};

export default function BookPage() {
  return (
    <Section>
      <div className="mx-auto grid max-w-6xl gap-10 lg:grid-cols-[420px_1fr] lg:items-start">
        <header className="space-y-4">
          <Badge tone="highlight">Book Online</Badge>
          <h1 className="font-display text-display text-primary-800">Get your instant junk removal quote</h1>
          <p className="text-body text-neutral-600">
            Answer a few quick questions and get your price. Most jobs can be booked in under a minute.
          </p>
          <ul className="space-y-2 text-sm text-neutral-600">
            <li>Full-service pickup (we do the lifting)</li>
            <li>Licensed & insured crews</li>
            <li>Text confirmation after booking</li>
            <li>No travel fees in our core service area</li>
          </ul>
        </header>

        <LeadForm />
      </div>
    </Section>
  );
}
