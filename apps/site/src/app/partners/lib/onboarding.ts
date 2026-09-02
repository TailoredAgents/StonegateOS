import { readPortalV2Response, type PortalV2Result } from "./portal-v2";

export const PARTNER_PERSONAS = [
  "contractor",
  "real_estate_agent",
  "property_manager",
  "commercial_client",
  "other",
] as const;

export type PartnerPersona = (typeof PARTNER_PERSONAS)[number];

export const PARTNER_REQUESTED_NEEDS = [
  "schedule_jobs",
  "manage_locations",
  "photos_and_proof",
  "invoices_and_documents",
  "reporting",
  "recurring_service",
] as const;

export type PartnerRequestedNeed = (typeof PARTNER_REQUESTED_NEEDS)[number];

export type PartnerCompanyResolutionChoice =
  | "join_existing"
  | "create_new"
  | "manual_review";

export type PartnerOnboardingApplicationStatus =
  | "draft"
  | "submitted"
  | "under_review"
  | "needs_information"
  | "approved_pending_activation"
  | "approved"
  | "declined"
  | "withdrawn";

export type PartnerOnboardingApplication = {
  id: string;
  status: PartnerOnboardingApplicationStatus;
  version: number;
  email: string;
  emailVerified: boolean;
  name: string;
  phone: string | null;
  companyName: string;
  website: string | null;
  partnerType: PartnerPersona | null;
  serviceAreas: string[];
  requestedNeeds: PartnerRequestedNeed[];
  companyResolution: {
    choice: PartnerCompanyResolutionChoice;
    candidateId: string | null;
    accountLabel: string | null;
  };
  informationRequest: string | null;
  submittedAt: string | null;
  updatedAt: string;
  etag: string;
};

export type PartnerOnboardingRequirements = {
  termsVersion: string;
  privacyVersion: string;
  partnerTypes: PartnerPersona[];
};

export type PartnerOnboardingApplicationPayload = {
  name: string;
  phone: string | null;
  companyName: string;
  website: string | null;
  partnerType: PartnerPersona;
  serviceAreas: string[];
  requestedNeeds: PartnerRequestedNeed[];
  companyResolutionChoice: PartnerCompanyResolutionChoice;
  companyCandidateId: string | null;
};

export type PartnerOnboardingApplicationResponse = {
  ok: true;
  application: PartnerOnboardingApplication;
  requirements: PartnerOnboardingRequirements;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function nullableString(value: unknown): string | null {
  const valueString = stringValue(value);
  return valueString || null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        const itemString = stringValue(item);
        return itemString ? [itemString] : [];
      })
    : [];
}

function isPersona(value: string): value is PartnerPersona {
  return (PARTNER_PERSONAS as readonly string[]).includes(value);
}

function isRequestedNeed(value: string): value is PartnerRequestedNeed {
  return (PARTNER_REQUESTED_NEEDS as readonly string[]).includes(value);
}

function isApplicationStatus(
  value: string,
): value is PartnerOnboardingApplicationStatus {
  return [
    "draft",
    "submitted",
    "under_review",
    "needs_information",
    "approved_pending_activation",
    "approved",
    "declined",
    "withdrawn",
  ].includes(value);
}

function resolutionChoice(value: unknown): PartnerCompanyResolutionChoice {
  return value === "join_existing" ||
    value === "create_new" ||
    value === "manual_review"
    ? value
    : "manual_review";
}

export function parsePartnerOnboardingApplicationResponse(
  value: unknown,
  responseEtag: string | null = null,
): PartnerOnboardingApplicationResponse | null {
  if (!isRecord(value) || value["ok"] !== true) return null;
  const application = isRecord(value["application"])
    ? value["application"]
    : null;
  const requirements = isRecord(value["requirements"])
    ? value["requirements"]
    : null;
  if (!application || !requirements) return null;

  const id = stringValue(application["id"]);
  const status = stringValue(application["status"]);
  const email = stringValue(application["email"]);
  const updatedAt = stringValue(application["updatedAt"]);
  const version = application["version"];
  const termsVersion = stringValue(requirements["termsVersion"]);
  const privacyVersion = stringValue(requirements["privacyVersion"]);
  if (
    !id ||
    !isApplicationStatus(status) ||
    !email ||
    typeof version !== "number" ||
    !Number.isSafeInteger(version) ||
    version < 1 ||
    !updatedAt ||
    !termsVersion ||
    !privacyVersion
  ) {
    return null;
  }

  const partnerType = stringValue(application["partnerType"]);
  const rawResolution = isRecord(application["companyResolution"])
    ? application["companyResolution"]
    : {};
  const etag = stringValue(application["etag"]) || responseEtag || "";
  if (!etag) return null;

  return {
    ok: true,
    application: {
      id,
      status,
      version,
      email,
      emailVerified: application["emailVerified"] === true,
      name: stringValue(application["name"]),
      phone: nullableString(application["phone"]),
      companyName: stringValue(application["companyName"]),
      website: nullableString(application["website"]),
      partnerType: isPersona(partnerType) ? partnerType : null,
      serviceAreas: stringArray(application["serviceAreas"]),
      requestedNeeds: stringArray(application["requestedNeeds"]).filter(
        isRequestedNeed,
      ),
      companyResolution: {
        choice: resolutionChoice(rawResolution["choice"]),
        candidateId: nullableString(rawResolution["candidateId"]),
        accountLabel: nullableString(rawResolution["accountLabel"]),
      },
      informationRequest: nullableString(application["informationRequest"]),
      submittedAt: nullableString(application["submittedAt"]),
      updatedAt,
      etag,
    },
    requirements: {
      termsVersion,
      privacyVersion,
      partnerTypes: stringArray(requirements["partnerTypes"]).filter(isPersona),
    },
  };
}

export async function partnerOnboardingFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<PortalV2Result<T>> {
  const response = await fetch(
    `/api/partners/onboarding/${path.replace(/^\/+|\/+$/gu, "")}`,
    {
      ...init,
      cache: "no-store",
      headers: {
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
    },
  );
  return readPortalV2Response<T>(response);
}

export function onboardingOperationKey(prefix: string): string {
  return `${prefix}:${globalThis.crypto.randomUUID()}`;
}
