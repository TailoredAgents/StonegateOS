import { Badge, Section } from "@myst-os/ui";
import { EstimateRequestForm } from "@/components/EstimateRequestForm";
import {
  ADDONS,
  PRICING_ESTIMATOR_QUERY_KEYS,
  computeAddonTotal,
  getTierById,
  normalizeTierId
} from "@/lib/pricing-estimator";

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

function normalizeString(value: string | string[] | undefined): string | undefined {
  if (!value) return undefined;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : undefined;
}

function parseCount(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 0;
  return Math.min(99, Math.max(0, parsed));
}

function formatUsd(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(value);
}

export default function EstimatePage({
  searchParams
}: {
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const intent = typeof searchParams?.["intent"] === "string" ? searchParams["intent"].trim().toLowerCase() : "";
  const context = intent.includes("contract") || intent.includes("construction") ? "contractor" : "default";
  const initialServices = normalizeStringList(searchParams?.["services"]);

  const peLoadRaw = normalizeString(searchParams?.[PRICING_ESTIMATOR_QUERY_KEYS.load]);
  const peLoad = normalizeTierId(peLoadRaw ?? null);
  const hasEstimatorParams =
    typeof searchParams?.[PRICING_ESTIMATOR_QUERY_KEYS.load] !== "undefined" ||
    typeof searchParams?.[PRICING_ESTIMATOR_QUERY_KEYS.mattress] !== "undefined" ||
    typeof searchParams?.[PRICING_ESTIMATOR_QUERY_KEYS.paint] !== "undefined" ||
    typeof searchParams?.[PRICING_ESTIMATOR_QUERY_KEYS.tire] !== "undefined";

  const addonCounts = {
    mattress: parseCount(normalizeString(searchParams?.[PRICING_ESTIMATOR_QUERY_KEYS.mattress])),
    paint: parseCount(normalizeString(searchParams?.[PRICING_ESTIMATOR_QUERY_KEYS.paint])),
    tire: parseCount(normalizeString(searchParams?.[PRICING_ESTIMATOR_QUERY_KEYS.tire]))
  };

  const initialNotes = (() => {
    if (!hasEstimatorParams && !intent.includes("pricing")) {
      return undefined;
    }

    const tier = getTierById(peLoad ?? "quarter");
    const addonTotal = computeAddonTotal(addonCounts);
    const totalMin = tier.min + addonTotal;
    const totalMax = tier.max + addonTotal;
    const addonUnitPrices = Object.fromEntries(ADDONS.map((addon) => [addon.id, addon.unitPrice])) as Record<string, number>;
    const addonParts: string[] = [];
    if (addonCounts.mattress > 0) addonParts.push(`${addonCounts.mattress} mattress${addonCounts.mattress === 1 ? "" : "es"} (+${formatUsd(addonCounts.mattress * (addonUnitPrices["mattress"] ?? 30))})`);
    if (addonCounts.paint > 0) addonParts.push(`${addonCounts.paint} paint can${addonCounts.paint === 1 ? "" : "s"} (+${formatUsd(addonCounts.paint * (addonUnitPrices["paint"] ?? 10))})`);
    if (addonCounts.tire > 0) addonParts.push(`${addonCounts.tire} tire${addonCounts.tire === 1 ? "" : "s"} (+${formatUsd(addonCounts.tire * (addonUnitPrices["tire"] ?? 10))})`);

    return [
      "Pricing estimator selection:",
      `Load size: ${tier.label} (${formatUsd(tier.min)}–${formatUsd(tier.max)})`,
      `Add-ons: ${addonParts.length ? addonParts.join(", ") : "none"}`,
      `Estimated range: ${formatUsd(totalMin)}–${formatUsd(totalMax)}`
    ].join("\n");
  })();

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
        <EstimateRequestForm context={context} initialServices={initialServices} initialNotes={initialNotes} />
      </div>
    </Section>
  );
}
