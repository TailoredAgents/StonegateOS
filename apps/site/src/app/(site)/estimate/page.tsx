import { Badge, Section } from "@myst-os/ui";
import { EstimateRequestForm } from "@/components/EstimateRequestForm";

export const metadata = {
  title: "Schedule an estimate"
};

function normalizeStringList(value: string | string[] | undefined): string[] {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of raw) {
    const parts = entry
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    for (const part of parts) {
      if (!out.includes(part)) out.push(part);
    }
  }
  return out;
}

export default function EstimatePage({
  searchParams
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const intent = typeof searchParams?.["intent"] === "string" ? searchParams["intent"].trim().toLowerCase() : "";
  const context = intent.includes("contract") || intent.includes("construction") ? "contractor" : "default";
  const initialServices = normalizeStringList(searchParams?.["services"]);

  return (
    <Section>
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-3">
          <Badge tone="highlight">Schedule</Badge>
          <h1 className="font-display text-display text-primary-800">Request an on-site estimate</h1>
          <p className="text-body text-neutral-600">
            Choose a preferred date/time window and we'll follow up to confirm the exact time.
          </p>
        </header>
        <EstimateRequestForm context={context} initialServices={initialServices} />
      </div>
    </Section>
  );
}
