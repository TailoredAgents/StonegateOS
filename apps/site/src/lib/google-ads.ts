declare global {
  interface Window {
    gtag?: (...args: unknown[]) => void;
    dataLayer?: unknown[];
  }
}

type EnhancedConversionsAddress = {
  first_name?: string;
  last_name?: string;
  street?: string;
  city?: string;
  region?: string;
  postal_code?: string;
  country?: string;
};

export type EnhancedConversionsUserData = {
  email?: string;
  phone_number?: string;
  address?: EnhancedConversionsAddress;
};

function normalizePhoneE164(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const digits = trimmed.replace(/[^\d]/g, "");
  if (!digits) return null;

  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (trimmed.startsWith("+") && digits.length >= 11 && digits.length <= 15) return `+${digits}`;

  return null;
}

function normalizeEmail(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  // Keep validation lightweight; Google will ignore invalid values.
  if (!trimmed.includes("@")) return null;
  return trimmed;
}

function normalizeAddress(input: EnhancedConversionsAddress | undefined): EnhancedConversionsAddress | undefined {
  if (!input) return undefined;
  const normalized: EnhancedConversionsAddress = {};
  const firstName = input.first_name?.trim() ?? "";
  const lastName = input.last_name?.trim() ?? "";
  const street = input.street?.trim() ?? "";
  const city = input.city?.trim() ?? "";
  const region = input.region?.trim() ?? "";
  const postal = input.postal_code?.trim() ?? "";
  const country = input.country?.trim().toUpperCase() ?? "";

  if (firstName) normalized.first_name = firstName;
  if (lastName) normalized.last_name = lastName;
  if (street) normalized.street = street;
  if (city) normalized.city = city;
  if (region) normalized.region = region;
  if (postal) normalized.postal_code = postal;
  if (country) normalized.country = country;

  return Object.keys(normalized).length ? normalized : undefined;
}

export function setGoogleAdsEnhancedConversionsUserData(input: EnhancedConversionsUserData) {
  try {
    if (typeof window === "undefined") return;

    const email = typeof input.email === "string" ? normalizeEmail(input.email) : null;
    const phone = typeof input.phone_number === "string" ? normalizePhoneE164(input.phone_number) : null;
    const address = normalizeAddress(input.address);

    const userData: EnhancedConversionsUserData = {};
    if (email) userData.email = email;
    if (phone) userData.phone_number = phone;
    if (address) userData.address = address;

    if (!Object.keys(userData).length) return;

    if (typeof window.gtag === "function") {
      window.gtag("set", "user_data", userData);
      return;
    }

    window.dataLayer = window.dataLayer || [];
    if (Array.isArray(window.dataLayer)) {
      // Mirror the gtag() stub behavior: it pushes the `arguments` array into dataLayer.
      window.dataLayer.push(["set", "user_data", userData]);
    }
  } catch (error) {
    console.warn("Google Ads enhanced conversions user_data failed", error);
  }
}

export function trackGoogleAdsConversion(sendTo: string, params?: Record<string, unknown>) {
  const normalized = sendTo.trim();
  if (!normalized) return;

  try {
    if (typeof window === "undefined") return;
    if (typeof window.gtag === "function") {
      window.gtag("event", "conversion", { send_to: normalized, ...(params ?? {}) });
      return;
    }

    window.dataLayer = window.dataLayer || [];
    if (Array.isArray(window.dataLayer)) {
      // Mirror the gtag() stub behavior: it pushes the `arguments` array into dataLayer.
      window.dataLayer.push(["event", "conversion", { send_to: normalized, ...(params ?? {}) }]);
    }
  } catch (error) {
    console.warn("Google Ads conversion tracking failed", error);
  }
}
