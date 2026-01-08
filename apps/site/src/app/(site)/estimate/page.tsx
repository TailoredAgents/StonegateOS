import { Badge, Section } from "@myst-os/ui";
import { EstimateRequestForm } from "@/components/EstimateRequestForm";

export const metadata = {
  title: "Schedule an estimate"
};

export default function EstimatePage() {
  return (
    <Section>
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-3">
          <Badge tone="highlight">Schedule</Badge>
          <h1 className="font-display text-display text-primary-800">Request an on-site estimate</h1>
          <p className="text-body text-neutral-600">
            Choose a preferred date/time window and we’ll follow up to confirm the exact time.
          </p>
        </header>
        <EstimateRequestForm />
      </div>
    </Section>
  );
}

