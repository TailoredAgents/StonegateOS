"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  CreditCard,
  LoaderCircle,
  Save,
  UserRound,
} from "lucide-react";
import {
  createPortalOperationKey,
  partnerPortalFetch,
  withPortalSupportReference,
} from "../lib/portal-v2";
import {
  PartnerNotice,
  PartnerPanel,
  partnerFieldClass,
  partnerPrimaryButtonClass,
} from "./PartnerPortalUi";

type Contact = {
  name: string | null;
  email: string | null;
  phoneE164: string | null;
};

type BillingAddress = {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
};

export type PartnerAccountProfile = {
  id: string;
  organization: { name: string; website: string | null };
  serviceContact: Contact;
  billing: {
    contact: Contact;
    address: BillingAddress;
    defaultPoNumber: string | null;
    costCenterGuidance: string | null;
  } | null;
  permissions: {
    canEditOrganization: boolean;
    canEditBilling: boolean;
    canViewBilling: boolean;
  };
  revision: number;
  updatedAt: string;
};

type ProfileResponse = { ok: true; profile: PartnerAccountProfile };

function field(value: string | null): string {
  return value ?? "";
}

function nullable(value: string): string | null {
  const trimmed = value.trim();
  return trimmed || null;
}

function formText(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

function contactFromForm(form: FormData, prefix: string): Contact {
  return {
    name: nullable(formText(form, `${prefix}Name`)),
    email: nullable(formText(form, `${prefix}Email`))?.toLowerCase() ?? null,
    phoneE164: nullable(formText(form, `${prefix}Phone`)),
  };
}

function organizationFormKey(profile: PartnerAccountProfile): string {
  return JSON.stringify([profile.organization, profile.serviceContact]);
}

function billingFormKey(profile: PartnerAccountProfile): string {
  return JSON.stringify(profile.billing);
}

export function PartnerAccountProfileManager({
  initialProfile,
  initialEtag,
}: {
  initialProfile: PartnerAccountProfile | null;
  initialEtag: string | null;
}) {
  const router = useRouter();
  const [profile, setProfile] = React.useState(initialProfile);
  const [etag, setEtag] = React.useState(initialEtag);
  const [organizationDirty, setOrganizationDirty] = React.useState(false);
  const [billingDirty, setBillingDirty] = React.useState(false);
  const [busy, setBusy] = React.useState<"organization" | "billing" | null>(
    null,
  );
  const [message, setMessage] = React.useState<{
    tone: "success" | "error" | "warning";
    text: string;
  } | null>(null);
  const dirty = organizationDirty || billingDirty;

  React.useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function refreshProfile(): Promise<void> {
    const result = await partnerPortalFetch<ProfileResponse>(
      "account-profile",
    ).catch(() => null);
    if (!result?.ok) return;
    setProfile(result.data.profile);
    setEtag(result.response.headers.get("etag"));
    setOrganizationDirty(false);
    setBillingDirty(false);
  }

  async function save(
    section: "organization" | "billing",
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!etag || busy) return;
    setBusy(section);
    setMessage(null);
    const result = await partnerPortalFetch<ProfileResponse>(
      "account-profile",
      {
        method: "PATCH",
        headers: {
          "If-Match": etag,
          "Idempotency-Key": createPortalOperationKey(
            `account-profile-${section}`,
          ),
        },
        body: JSON.stringify(payload),
      },
    ).catch(() => null);
    setBusy(null);
    if (!result?.ok) {
      const changedElsewhere = result?.response.status === 412;
      setMessage({
        tone: changedElsewhere ? "warning" : "error",
        text: withPortalSupportReference(
          changedElsewhere
            ? "These account settings changed elsewhere. We refreshed them; review the latest values before saving again."
            : (result?.error.message ??
                "We couldn’t save these account settings."),
          result?.error.correlationId,
        ),
      });
      if (changedElsewhere) await refreshProfile();
      return;
    }
    setProfile(result.data.profile);
    setEtag(result.response.headers.get("etag"));
    if (section === "organization") setOrganizationDirty(false);
    if (section === "billing") setBillingDirty(false);
    setMessage({
      tone: "success",
      text:
        section === "organization"
          ? "Company and main service contact saved."
          : "Billing details saved for future bookings.",
    });
    router.refresh();
  }

  if (!profile) {
    return (
      <PartnerPanel>
        <PartnerNotice tone="warning">
          Organization and billing settings are temporarily unavailable. No
          account details were changed.
        </PartnerNotice>
      </PartnerPanel>
    );
  }
  const billing = profile.billing;

  return (
    <div
      className="space-y-5"
      data-partner-unsaved={dirty ? "true" : undefined}
    >
      {message ? (
        <PartnerNotice tone={message.tone}>{message.text}</PartnerNotice>
      ) : null}

      <PartnerPanel>
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
            <Building2 className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              Company details for smoother service
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
              Keep your company name and main contact current so questions about
              a job reach the right person. Updating these details does not
              change who can access this account.
            </p>
          </div>
        </div>
        {!profile.permissions.canEditOrganization ? (
          <PartnerNotice tone="warning" className="mt-5">
            You can view these account-wide details, but an account
            administrator must edit them.
          </PartnerNotice>
        ) : null}
        <form
          key={organizationFormKey(profile)}
          className="mt-5 grid gap-4 sm:grid-cols-2"
          onChange={() => setOrganizationDirty(true)}
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void save("organization", {
              organization: {
                name: formText(form, "organizationName").trim(),
                website: nullable(formText(form, "organizationWebsite")),
              },
              serviceContact: contactFromForm(form, "serviceContact"),
            });
          }}
        >
          <label>
            <span className="text-sm font-semibold text-slate-700">
              Organization name
            </span>
            <input
              name="organizationName"
              required
              maxLength={160}
              defaultValue={profile.organization.name}
              disabled={!profile.permissions.canEditOrganization}
              className={partnerFieldClass}
            />
          </label>
          <label>
            <span className="text-sm font-semibold text-slate-700">
              Website
            </span>
            <input
              name="organizationWebsite"
              type="url"
              maxLength={2048}
              placeholder="https://example.com"
              defaultValue={field(profile.organization.website)}
              disabled={!profile.permissions.canEditOrganization}
              className={partnerFieldClass}
            />
          </label>
          <div className="sm:col-span-2 mt-1 flex items-center gap-2 border-t border-slate-200 pt-4">
            <UserRound className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <h3 className="font-semibold text-slate-900">
              Primary service contact
            </h3>
          </div>
          <label>
            <span className="text-sm font-semibold text-slate-700">Name</span>
            <input
              name="serviceContactName"
              maxLength={160}
              defaultValue={field(profile.serviceContact.name)}
              disabled={!profile.permissions.canEditOrganization}
              className={partnerFieldClass}
            />
          </label>
          <label>
            <span className="text-sm font-semibold text-slate-700">Email</span>
            <input
              name="serviceContactEmail"
              type="email"
              maxLength={254}
              defaultValue={field(profile.serviceContact.email)}
              disabled={!profile.permissions.canEditOrganization}
              className={partnerFieldClass}
            />
          </label>
          <label>
            <span className="text-sm font-semibold text-slate-700">
              Phone <span className="font-normal">(optional, E.164)</span>
            </span>
            <input
              name="serviceContactPhone"
              type="tel"
              maxLength={16}
              placeholder="+15551234567"
              defaultValue={field(profile.serviceContact.phoneE164)}
              disabled={!profile.permissions.canEditOrganization}
              className={partnerFieldClass}
            />
          </label>
          {profile.permissions.canEditOrganization ? (
            <div className="flex items-end sm:justify-end">
              <button
                type="submit"
                disabled={!organizationDirty || busy !== null || !etag}
                aria-busy={busy === "organization"}
                className={partnerPrimaryButtonClass}
              >
                {busy === "organization" ? (
                  <LoaderCircle
                    className="h-4 w-4 animate-spin motion-reduce:animate-none"
                    aria-hidden="true"
                  />
                ) : (
                  <Save className="h-4 w-4" aria-hidden="true" />
                )}
                {busy === "organization" ? "Saving…" : "Save company details"}
              </button>
            </div>
          ) : null}
        </form>
      </PartnerPanel>

      <PartnerPanel>
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-sky-50 text-sky-700 ring-1 ring-sky-100">
            <CreditCard className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              Billing defaults for faster booking
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
              Save the billing recipient, address, PO default, and cost-center
              guidance once so future bookings are quicker and more consistent.
              These defaults do not change contracted rates, terms, or existing
              invoices.
            </p>
          </div>
        </div>
        {!profile.permissions.canViewBilling || !billing ? (
          <PartnerNotice tone="warning" className="mt-5">
            Only account administrators and Billing/Approver users can view
            billing details. No financial contact or address data is shown for
            your role.
          </PartnerNotice>
        ) : (
          <>
            {!profile.permissions.canEditBilling ? (
              <PartnerNotice tone="warning" className="mt-5">
                You can view these billing details, but an account administrator
                or Billing/Approver must edit them.
              </PartnerNotice>
            ) : null}
            <form
              key={billingFormKey(profile)}
              className="mt-5 grid gap-4 sm:grid-cols-2"
              onChange={() => setBillingDirty(true)}
              onSubmit={(event) => {
                event.preventDefault();
                const form = new FormData(event.currentTarget);
                const line1 = nullable(formText(form, "billingAddressLine1"));
                const line2 = nullable(formText(form, "billingAddressLine2"));
                const city = nullable(formText(form, "billingAddressCity"));
                const state = nullable(formText(form, "billingAddressState"));
                const postalCode = nullable(
                  formText(form, "billingAddressPostalCode"),
                );
                const country =
                  nullable(
                    formText(form, "billingAddressCountry"),
                  )?.toUpperCase() ?? null;
                const addressEmpty =
                  !line1 && !line2 && !city && !state && !postalCode;
                void save("billing", {
                  billing: {
                    contact: contactFromForm(form, "billingContact"),
                    address: addressEmpty
                      ? {
                          line1: null,
                          line2: null,
                          city: null,
                          state: null,
                          postalCode: null,
                          country: null,
                        }
                      : {
                          line1,
                          line2,
                          city,
                          state,
                          postalCode,
                          country,
                        },
                    defaultPoNumber: nullable(
                      formText(form, "defaultPoNumber"),
                    ),
                    costCenterGuidance: nullable(
                      formText(form, "costCenterGuidance"),
                    ),
                  },
                });
              }}
            >
              <label>
                <span className="text-sm font-semibold text-slate-700">
                  Contact name
                </span>
                <input
                  name="billingContactName"
                  maxLength={160}
                  defaultValue={field(billing.contact.name)}
                  disabled={!profile.permissions.canEditBilling}
                  className={partnerFieldClass}
                />
              </label>
              <label>
                <span className="text-sm font-semibold text-slate-700">
                  Contact email
                </span>
                <input
                  name="billingContactEmail"
                  type="email"
                  maxLength={254}
                  defaultValue={field(billing.contact.email)}
                  disabled={!profile.permissions.canEditBilling}
                  className={partnerFieldClass}
                />
              </label>
              <label>
                <span className="text-sm font-semibold text-slate-700">
                  Contact phone{" "}
                  <span className="font-normal">(optional, E.164)</span>
                </span>
                <input
                  name="billingContactPhone"
                  type="tel"
                  maxLength={16}
                  placeholder="+15551234567"
                  defaultValue={field(billing.contact.phoneE164)}
                  disabled={!profile.permissions.canEditBilling}
                  className={partnerFieldClass}
                />
              </label>
              <label>
                <span className="text-sm font-semibold text-slate-700">
                  Address line 1
                </span>
                <input
                  name="billingAddressLine1"
                  maxLength={200}
                  defaultValue={field(billing.address.line1)}
                  disabled={!profile.permissions.canEditBilling}
                  className={partnerFieldClass}
                />
              </label>
              <label>
                <span className="text-sm font-semibold text-slate-700">
                  Address line 2
                </span>
                <input
                  name="billingAddressLine2"
                  maxLength={200}
                  defaultValue={field(billing.address.line2)}
                  disabled={!profile.permissions.canEditBilling}
                  className={partnerFieldClass}
                />
              </label>
              <label>
                <span className="text-sm font-semibold text-slate-700">
                  City
                </span>
                <input
                  name="billingAddressCity"
                  maxLength={120}
                  defaultValue={field(billing.address.city)}
                  disabled={!profile.permissions.canEditBilling}
                  className={partnerFieldClass}
                />
              </label>
              <label>
                <span className="text-sm font-semibold text-slate-700">
                  State / region
                </span>
                <input
                  name="billingAddressState"
                  maxLength={64}
                  defaultValue={field(billing.address.state)}
                  disabled={!profile.permissions.canEditBilling}
                  className={partnerFieldClass}
                />
              </label>
              <div className="grid grid-cols-[1fr_7rem] gap-3">
                <label>
                  <span className="text-sm font-semibold text-slate-700">
                    Postal code
                  </span>
                  <input
                    name="billingAddressPostalCode"
                    maxLength={20}
                    defaultValue={field(billing.address.postalCode)}
                    disabled={!profile.permissions.canEditBilling}
                    className={partnerFieldClass}
                  />
                </label>
                <label>
                  <span className="text-sm font-semibold text-slate-700">
                    Country
                  </span>
                  <input
                    name="billingAddressCountry"
                    maxLength={2}
                    defaultValue={billing.address.country ?? "US"}
                    disabled={!profile.permissions.canEditBilling}
                    className={partnerFieldClass}
                  />
                </label>
              </div>
              <label>
                <span className="text-sm font-semibold text-slate-700">
                  Default PO / reference
                </span>
                <input
                  name="defaultPoNumber"
                  maxLength={80}
                  defaultValue={field(billing.defaultPoNumber)}
                  disabled={!profile.permissions.canEditBilling}
                  className={partnerFieldClass}
                />
              </label>
              <label className="sm:col-span-2">
                <span className="text-sm font-semibold text-slate-700">
                  Cost-center guidance
                </span>
                <textarea
                  name="costCenterGuidance"
                  maxLength={500}
                  rows={3}
                  defaultValue={field(billing.costCenterGuidance)}
                  disabled={!profile.permissions.canEditBilling}
                  className={partnerFieldClass}
                  placeholder="Example: Select the property’s active cost center; ask the billing contact if none matches."
                />
              </label>
              {profile.permissions.canEditBilling ? (
                <div className="sm:col-span-2 flex justify-end">
                  <button
                    type="submit"
                    disabled={!billingDirty || busy !== null || !etag}
                    aria-busy={busy === "billing"}
                    className={partnerPrimaryButtonClass}
                  >
                    {busy === "billing" ? (
                      <LoaderCircle
                        className="h-4 w-4 animate-spin motion-reduce:animate-none"
                        aria-hidden="true"
                      />
                    ) : (
                      <Save className="h-4 w-4" aria-hidden="true" />
                    )}
                    {busy === "billing" ? "Saving…" : "Save billing details"}
                  </button>
                </div>
              ) : null}
            </form>
          </>
        )}
      </PartnerPanel>
    </div>
  );
}
