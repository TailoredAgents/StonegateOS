import { serviceRates } from "@myst-os/pricing/src/config/defaults";

const SERVICE_LABELS = new Map<string, string>(
  serviceRates.map((rate) => [rate.service.toLowerCase(), rate.label])
);

const LABEL_ALIASES: Record<string, string> = {
  junk_removal_primary: "Junk removal",
  junk_removal: "Junk removal",
  "junk-removal-primary": "Junk removal",
  "junk-removal": "Junk removal",
  general_junk: "Junk removal",
  "general-junk": "Junk removal",
  "commercial-services": "Commercial services",
  commercial_services: "Commercial services"
};

const SERVICE_ID_ALIASES: Record<string, string> = {
  single_item: "single-item",
  yard_waste: "yard-waste",
  construction_debris: "construction-debris",
  hot_tub: "hot-tub",
  rubbish: "single-item",
  trash: "single-item",
  garbage: "single-item",
  "household-waste": "single-item",
  household_waste: "single-item"
};

function humanizeServiceId(value: string): string {
  const clean = value
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
  return clean.length ? clean.replace(/\b\w/g, (c) => c.toUpperCase()) : "Junk removal";
}

function normalizeServiceId(value: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "";
  const lower = raw.toLowerCase();
  const hyphenated = lower.replace(/_/g, "-");
  return SERVICE_ID_ALIASES[hyphenated] ?? SERVICE_ID_ALIASES[lower] ?? hyphenated;
}

export function formatServiceLabel(value: string): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return "Junk removal";

  const lower = raw.toLowerCase();
  const aliasLabel = LABEL_ALIASES[lower] ?? LABEL_ALIASES[lower.replace(/_/g, "-")];
  if (aliasLabel) return aliasLabel;

  const normalized = normalizeServiceId(raw);
  const directLabel = SERVICE_LABELS.get(normalized);
  if (directLabel) return directLabel;

  return humanizeServiceId(raw);
}

export function summarizeServiceLabels(services: string[]): string {
  const labels: string[] = [];
  for (const service of services) {
    if (typeof service !== "string") continue;
    const label = formatServiceLabel(service);
    if (!labels.includes(label)) labels.push(label);
  }

  if (!labels.length) return "Junk removal";
  const [first, ...rest] = labels;
  if (!first) return "Junk removal";
  return rest.length ? `${first} +${rest.length}` : first;
}

