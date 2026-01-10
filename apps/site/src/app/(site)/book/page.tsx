import { Badge, Section } from "@myst-os/ui";
import { LeadForm } from "@/components/LeadForm";

export const metadata = {
  title: "Book your pickup"
};

export default function BookPage() {
  return (
    <Section>
      <div className="mx-auto grid max-w-5xl gap-8 lg:grid-cols-[1fr_440px] lg:items-start">
        <header className="space-y-4">
          <Badge tone="highlight">Book Online</Badge>
          <h1 className="font-display text-display text-primary-800">Book your junk removal pickup</h1>
          <p className="text-body text-neutral-600">
            Get an instant quote, pick a time, and lock it in. Pricing is based only on trailer volume.
          </p>
          <ul className="space-y-2 text-sm text-neutral-600">
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

