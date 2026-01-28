export type PublicCompanyProfile = {
  name: string;
  phoneE164: string;
  phoneDisplay: string;
  email: string;
  logoPath: string;
  serviceAreaSummary: string;
  hoursSummary: string;
  hqCity: string;
  hqState: string;
  hqCountry: string;
};

const FALLBACK_COMPANY: PublicCompanyProfile = {
  name: "Stonegate Junk Removal",
  phoneE164: "+14047772631",
  phoneDisplay: "(404) 777-2631",
  email: "austin@stonegatejunkremoval.com",
  logoPath: "/images/brand/Stonegatelogo.png",
  serviceAreaSummary: "Serving North Metro Atlanta and nearby Georgia communities.",
  hoursSummary: "Mon-Sat 7:30 AM-7:30 PM ET. Sunday: on-call.",
  hqCity: "Woodstock",
  hqState: "GA",
  hqCountry: "US"
};

function coerceEnv(key: string): string | null {
  const raw = process.env[key];
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  return trimmed.length ? trimmed : null;
}

function normalizePhoneE164(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return FALLBACK_COMPANY.phoneE164;
  if (trimmed.startsWith("+")) return trimmed;
  const digits = trimmed.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return trimmed;
}

function normalizePhoneDisplay(value: string, fallback: string): string {
  const trimmed = value.trim();
  if (trimmed) return trimmed;
  return fallback;
}

export function getPublicCompanyProfile(): PublicCompanyProfile {
  const name = coerceEnv("NEXT_PUBLIC_COMPANY_NAME") ?? FALLBACK_COMPANY.name;
  const phoneE164 = normalizePhoneE164(coerceEnv("NEXT_PUBLIC_COMPANY_PHONE_E164") ?? FALLBACK_COMPANY.phoneE164);
  const phoneDisplay = normalizePhoneDisplay(
    coerceEnv("NEXT_PUBLIC_COMPANY_PHONE_DISPLAY") ?? "",
    FALLBACK_COMPANY.phoneDisplay
  );
  const email = coerceEnv("NEXT_PUBLIC_COMPANY_EMAIL") ?? FALLBACK_COMPANY.email;
  const logoPath = coerceEnv("NEXT_PUBLIC_COMPANY_LOGO_PATH") ?? FALLBACK_COMPANY.logoPath;
  const serviceAreaSummary = coerceEnv("NEXT_PUBLIC_COMPANY_SERVICE_AREA") ?? FALLBACK_COMPANY.serviceAreaSummary;
  const hoursSummary = coerceEnv("NEXT_PUBLIC_COMPANY_HOURS_SUMMARY") ?? FALLBACK_COMPANY.hoursSummary;
  const hqCity = coerceEnv("NEXT_PUBLIC_COMPANY_HQ_CITY") ?? FALLBACK_COMPANY.hqCity;
  const hqState = coerceEnv("NEXT_PUBLIC_COMPANY_HQ_STATE") ?? FALLBACK_COMPANY.hqState;
  const hqCountry = coerceEnv("NEXT_PUBLIC_COMPANY_HQ_COUNTRY") ?? FALLBACK_COMPANY.hqCountry;

  return {
    name,
    phoneE164,
    phoneDisplay,
    email,
    logoPath,
    serviceAreaSummary,
    hoursSummary,
    hqCity,
    hqState,
    hqCountry
  };
}

export function getCompanyShortName(profile: PublicCompanyProfile = getPublicCompanyProfile()): string {
  const trimmed = profile.name.trim();
  if (!trimmed) return "Company";
  return trimmed.split(/\s+/u)[0] ?? "Company";
}
