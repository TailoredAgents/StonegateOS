import { Badge, Section } from "@myst-os/ui";
import { LeadForm } from "@/components/LeadForm";
import { absoluteUrl } from "@/lib/metadata";

export const metadata = {
  title: "Junk removal quote request",
  description: "Request a junk removal estimate, then choose whether to book online, call, or get text follow-up.",
  alternates: { canonical: absoluteUrl("/book") },
  openGraph: {
    title: "Junk removal quote request",
    description: "Request a junk removal estimate, then choose whether to book online, call, or get text follow-up.",
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
          <h1 className="font-display text-display text-primary-800">Get your junk removal quote started</h1>
          <p className="text-body text-neutral-600">
            Tell us who to text, then answer a few quick job questions. Your quote request is saved before we show the estimate.
          </p>
          <ul className="space-y-2 text-sm text-neutral-600">
            <li>Full-service pickup (we do the lifting)</li>
            <li>Licensed & insured crews</li>
            <li>Text confirmation after booking</li>
            <li>Book online, call, or keep the quote for text follow-up</li>
          </ul>
        </header>

        <LeadForm contactFirst />
      </div>
    </Section>
  );
}
