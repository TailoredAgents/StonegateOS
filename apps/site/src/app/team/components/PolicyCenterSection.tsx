import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import {
  updateBookingRulesPolicyAction,
  updateBusinessHoursPolicyAction,
  updateConversationPersonaPolicyAction,
  updateCompanyProfilePolicyAction,
  updateConfirmationLoopPolicyAction,
  updateFollowUpSequencePolicyAction,
  updateInboxAlertsPolicyAction,
  updateItemPoliciesAction,
  updatePolicyAction,
  updateQuietHoursPolicyAction,
  updateServiceAreaPolicyAction,
  updateStandardJobPolicyAction,
  updateTemplatesPolicyAction
} from "../actions";

type PolicySetting = {
  key: string;
  value: Record<string, unknown>;
  updatedAt: string | null;
};

type PolicyKey =
  | "business_hours"
  | "quiet_hours"
  | "service_area"
  | "company_profile"
  | "conversation_persona"
  | "inbox_alerts"
  | "booking_rules"
  | "confirmation_loop"
  | "follow_up_sequence"
  | "standard_job"
  | "item_policies"
  | "templates";

const POLICY_LABELS: Record<PolicyKey, { title: string; description: string }> = {
  business_hours: {
    title: "Business hours",
    description: "Define operating hours per weekday and default timezone."
  },
  quiet_hours: {
    title: "Quiet hours",
    description: "When outbound messages should pause by channel."
  },
  service_area: {
    title: "Service area",
    description: "Define ZIP codes and boundaries for service coverage."
  },
  company_profile: {
    title: "Company profile",
    description: "Editable facts and sales playbook used by Inbox AI."
  },
  conversation_persona: {
    title: "Conversation persona",
    description: "System instructions used by Sales Autopilot + Inbox AI drafts."
  },
  inbox_alerts: {
    title: "Inbox alerts",
    description: "Text the assigned salesperson when new inbound messages arrive."
  },
  booking_rules: {
    title: "Booking rules",
    description: "Default booking windows, buffers, and capacity caps."
  },
  confirmation_loop: {
    title: "Confirmation loop",
    description: "Enable or disable appointment confirmation reminders."
  },
  follow_up_sequence: {
    title: "Follow-up sequence",
    description: "Configure quoted-but-not-booked follow-up cadence."
  },
  standard_job: {
    title: "Standard job definition",
    description: "Guardrails for what can be auto-booked."
  },
  item_policies: {
    title: "Item policies",
    description: "Items declined or extra fees applied."
  },
  templates: {
    title: "Templates",
    description: "First touch, follow-up, confirmations, and review copy."
  }
};

const INPUT_CLASS =
  "w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100";

const TEXTAREA_CLASS =
  "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100";

const LABEL_CLASS = "text-[11px] font-semibold uppercase tracking-wide text-slate-500";

const DEFAULT_BUSINESS_START: Record<string, string> = {
  monday: "08:00",
  tuesday: "08:00",
  wednesday: "08:00",
  thursday: "08:00",
  friday: "08:00",
  saturday: "09:00",
  sunday: "08:00"
};

const DEFAULT_BUSINESS_END: Record<string, string> = {
  monday: "18:00",
  tuesday: "18:00",
  wednesday: "18:00",
  thursday: "18:00",
  friday: "18:00",
  saturday: "14:00",
  sunday: "18:00"
};

const WEEKDAYS = [
  { key: "monday", label: "Monday" },
  { key: "tuesday", label: "Tuesday" },
  { key: "wednesday", label: "Wednesday" },
  { key: "thursday", label: "Thursday" },
  { key: "friday", label: "Friday" },
  { key: "saturday", label: "Saturday" },
  { key: "sunday", label: "Sunday" }
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readGroup(value: Record<string, unknown>, key: string): Record<string, string> {
  const group = value[key];
  if (!isRecord(group)) {
    return {};
  }
  const entries: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(group)) {
    if (typeof entryValue === "string") {
      entries[entryKey] = entryValue;
    }
  }
  return entries;
}

function formatUpdatedAt(updatedAt: string | null): string {
  return updatedAt
    ? new Date(updatedAt).toLocaleString(undefined, { timeZone: TEAM_TIME_ZONE })
    : "just now";
}

function AdvancedJsonEditor(props: { setting: PolicySetting | undefined }) {
  const setting = props.setting;
  if (!setting) {
    return null;
  }
  return (
    <details className="mt-4">
      <summary className="cursor-pointer text-xs font-semibold text-slate-500">Advanced JSON</summary>
      <form action={updatePolicyAction} className="mt-3 space-y-3">
        <input type="hidden" name="key" value={setting.key} />
        <textarea
          name="value"
          rows={6}
          defaultValue={JSON.stringify(setting.value ?? {}, null, 2)}
          className={TEXTAREA_CLASS}
        />
        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <span>Last updated {formatUpdatedAt(setting.updatedAt)}</span>
          <SubmitButton
            className="rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-slate-200/60 transition hover:bg-slate-800"
            pendingLabel="Saving..."
          >
            Save JSON
          </SubmitButton>
        </div>
      </form>
    </details>
  );
}

export async function PolicyCenterSection(): Promise<React.ReactElement> {
  const response = await callAdminApi("/api/admin/policy");
  if (!response.ok) {
    throw new Error("Failed to load policy settings");
  }

  const payload = (await response.json()) as { settings?: PolicySetting[] };
  const settings = payload.settings ?? [];
  const settingsByKey = new Map(settings.map((setting) => [setting.key, setting]));

  const businessSetting = settingsByKey.get("business_hours");
  const businessValue = isRecord(businessSetting?.value) ? businessSetting!.value : {};
  const businessWeekly = isRecord(businessValue["weekly"]) ? (businessValue["weekly"] as Record<string, unknown>) : {};
  const businessTimezone =
    typeof businessValue["timezone"] === "string" && businessValue["timezone"].trim().length > 0
      ? businessValue["timezone"]
      : "America/New_York";
  const hasMultipleBusinessWindows = WEEKDAYS.some(({ key }) => {
    const windows = Array.isArray(businessWeekly[key]) ? businessWeekly[key] : [];
    return windows.length > 1;
  });

  const quietSetting = settingsByKey.get("quiet_hours");
  const quietValue = isRecord(quietSetting?.value) ? quietSetting!.value : {};
  const quietChannels = isRecord(quietValue["channels"]) ? (quietValue["channels"] as Record<string, unknown>) : {};
  const quietSms: Record<string, unknown> = isRecord(quietChannels["sms"]) ? quietChannels["sms"] : {};
  const quietEmail: Record<string, unknown> = isRecord(quietChannels["email"]) ? quietChannels["email"] : {};
  const quietDm: Record<string, unknown> = isRecord(quietChannels["dm"]) ? quietChannels["dm"] : {};

  const serviceSetting = settingsByKey.get("service_area");
  const serviceValue = isRecord(serviceSetting?.value) ? serviceSetting!.value : {};
  const serviceMode =
    serviceValue["mode"] === "ga_only"
      ? "ga_only"
      : serviceValue["mode"] === "ga_above_macon"
        ? "ga_above_macon"
        : "zip_allowlist";
  const zipAllowlist = Array.isArray(serviceValue["zipAllowlist"])
    ? serviceValue["zipAllowlist"].filter((zip): zip is string => typeof zip === "string")
    : [];

  const companySetting = settingsByKey.get("company_profile");
  const companyValue = isRecord(companySetting?.value) ? companySetting!.value : {};
  const companyBusinessName =
    typeof companyValue["businessName"] === "string" && companyValue["businessName"].trim().length > 0
      ? companyValue["businessName"]
      : "Stonegate Junk Removal";
  const companyPrimaryPhone =
    typeof companyValue["primaryPhone"] === "string" && companyValue["primaryPhone"].trim().length > 0
      ? companyValue["primaryPhone"]
      : "(404) 777-2631";
  const companyServiceAreaSummary =
    typeof companyValue["serviceAreaSummary"] === "string" && companyValue["serviceAreaSummary"].trim().length > 0
      ? companyValue["serviceAreaSummary"]
      : "North Metro Atlanta within about 50 miles of Woodstock, Georgia (ZIP allowlist).";
  const companyTrailerAndPricingSummary =
    typeof companyValue["trailerAndPricingSummary"] === "string" && companyValue["trailerAndPricingSummary"].trim().length > 0
      ? companyValue["trailerAndPricingSummary"]
      : "We use a 7x16x4 dump trailer. Pricing is strictly based on trailer volume in quarter trailer increments. Photos help us estimate quickly.";
  const companyWhatWeDo =
    typeof companyValue["whatWeDo"] === "string" && companyValue["whatWeDo"].trim().length > 0
      ? companyValue["whatWeDo"]
      : "Junk removal and hauling for household and light commercial items.";
  const companyWhatWeDontDo =
    typeof companyValue["whatWeDontDo"] === "string" && companyValue["whatWeDontDo"].trim().length > 0
      ? companyValue["whatWeDontDo"]
      : "We do not service out of area locations. We do not take hazmat, oils, or paints. Ask if unsure.";
  const companyBookingStyle =
    typeof companyValue["bookingStyle"] === "string" && companyValue["bookingStyle"].trim().length > 0
      ? companyValue["bookingStyle"]
      : "Offer 2 concrete options and move to booking. Ask for ZIP, item details, and preferred timing. If photos are available, request them.";
  const companyAgentNotes =
    typeof companyValue["agentNotes"] === "string" && companyValue["agentNotes"].trim().length > 0
      ? companyValue["agentNotes"]
      : "Keep replies short, friendly, and human. Avoid lists and avoid dash characters. No links.";

  const personaSetting = settingsByKey.get("conversation_persona");
  const personaValue = isRecord(personaSetting?.value) ? personaSetting!.value : {};
  const personaSystemPrompt =
    typeof personaValue["systemPrompt"] === "string" && personaValue["systemPrompt"].trim().length > 0
      ? personaValue["systemPrompt"]
      : "";

  const inboxAlertsSetting = settingsByKey.get("inbox_alerts");
  const inboxAlertsValue = isRecord(inboxAlertsSetting?.value) ? inboxAlertsSetting!.value : {};
  const inboxAlertsSms = inboxAlertsValue["sms"] !== false;
  const inboxAlertsDm = inboxAlertsValue["dm"] === true;
  const inboxAlertsEmail = inboxAlertsValue["email"] === true;

  const bookingSetting = settingsByKey.get("booking_rules");
  const bookingValue = isRecord(bookingSetting?.value) ? bookingSetting!.value : {};

  const confirmationSetting = settingsByKey.get("confirmation_loop");
  const confirmationValue = isRecord(confirmationSetting?.value) ? confirmationSetting!.value : {};
  const confirmationWindowsMinutes = Array.isArray(confirmationValue["windowsMinutes"])
    ? confirmationValue["windowsMinutes"].filter((value): value is number => typeof value === "number")
    : [];
  const confirmationWindowHours = confirmationWindowsMinutes.map((value) => value / 60);

  const followupSetting = settingsByKey.get("follow_up_sequence");
  const followupValue = isRecord(followupSetting?.value) ? followupSetting!.value : {};
  const followupStepsMinutes = Array.isArray(followupValue["stepsMinutes"])
    ? followupValue["stepsMinutes"].filter((value): value is number => typeof value === "number")
    : [];
  const followupStepHours = followupStepsMinutes.map((value) => value / 60);

  const standardSetting = settingsByKey.get("standard_job");
  const standardValue = isRecord(standardSetting?.value) ? standardSetting!.value : {};

  const itemSetting = settingsByKey.get("item_policies");
  const itemValue = isRecord(itemSetting?.value) ? itemSetting!.value : {};
  const itemDeclined = Array.isArray(itemValue["declined"])
    ? itemValue["declined"].filter((item): item is string => typeof item === "string")
    : [];
  const itemExtraFees = Array.isArray(itemValue["extraFees"])
    ? itemValue["extraFees"].filter((item): item is Record<string, unknown> => isRecord(item))
    : [];

  const templatesSetting = settingsByKey.get("templates");
  const templatesValue = isRecord(templatesSetting?.value) ? templatesSetting!.value : {};
  const templatesFirstTouch = readGroup(templatesValue, "first_touch");
  const templatesFollowUp = readGroup(templatesValue, "follow_up");
  const templatesConfirmations = readGroup(templatesValue, "confirmations");
  const templatesReviews = readGroup(templatesValue, "reviews");
  const templatesOutOfArea = readGroup(templatesValue, "out_of_area");

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <h2 className="text-xl font-semibold text-slate-900">Policy Center</h2>
        <p className="mt-1 text-sm text-slate-600">
          Update business rules and templates without code changes. Changes are logged automatically.
        </p>
      </header>

      <div className="space-y-4">
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">{POLICY_LABELS.business_hours.title}</h3>
            <p className="text-xs text-slate-500">{POLICY_LABELS.business_hours.description}</p>
          </div>
          <form action={updateBusinessHoursPolicyAction} className="mt-4 space-y-4">
            <div>
              <label className={LABEL_CLASS}>Timezone</label>
              <input name="timezone" defaultValue={businessTimezone} className={INPUT_CLASS} />
            </div>
            <div className="space-y-3">
              {WEEKDAYS.map(({ key, label }) => {
                const windows = Array.isArray(businessWeekly[key]) ? businessWeekly[key] : [];
                const primary = windows.length > 0 && isRecord(windows[0]) ? windows[0] : null;
                const start =
                  primary && typeof primary["start"] === "string"
                    ? primary["start"]
                    : DEFAULT_BUSINESS_START[key] ?? "08:00";
                const end =
                  primary && typeof primary["end"] === "string"
                    ? primary["end"]
                    : DEFAULT_BUSINESS_END[key] ?? "18:00";
                const closed = windows.length === 0;

                return (
                  <div key={key} className="grid gap-3 sm:grid-cols-[120px_1fr_1fr_120px] sm:items-center">
                    <span className="text-xs font-semibold text-slate-700">{label}</span>
                    <input type="time" name={`${key}_start`} defaultValue={start} className={INPUT_CLASS} />
                    <input type="time" name={`${key}_end`} defaultValue={end} className={INPUT_CLASS} />
                    <label className="flex items-center gap-2 text-xs text-slate-600">
                      <input type="checkbox" name={`${key}_closed`} defaultChecked={closed} />
                      Closed
                    </label>
                  </div>
                );
              })}
            </div>
            {hasMultipleBusinessWindows ? (
              <p className="text-[11px] text-amber-600">
                Multiple windows are configured on some days. Use Advanced JSON to edit all windows.
              </p>
            ) : null}
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Last updated {formatUpdatedAt(businessSetting?.updatedAt ?? null)}</span>
              <SubmitButton
                className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                pendingLabel="Saving..."
              >
                Save business hours
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={businessSetting} />
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">{POLICY_LABELS.quiet_hours.title}</h3>
            <p className="text-xs text-slate-500">{POLICY_LABELS.quiet_hours.description}</p>
          </div>
          <form action={updateQuietHoursPolicyAction} className="mt-4 space-y-3">
            {[
              { key: "sms", label: "SMS", value: quietSms },
              { key: "email", label: "Email", value: quietEmail },
              { key: "dm", label: "DM", value: quietDm }
            ].map((channel) => {
              const start =
                typeof channel.value["start"] === "string"
                  ? channel.value["start"]
                  : channel.key === "email"
                    ? "19:00"
                    : "20:00";
              const end =
                typeof channel.value["end"] === "string"
                  ? channel.value["end"]
                  : channel.key === "email"
                    ? "07:00"
                    : "08:00";
              const always = start === end;
              return (
                <div key={channel.key} className="grid gap-3 sm:grid-cols-[100px_1fr_1fr_140px] sm:items-center">
                  <span className="text-xs font-semibold text-slate-700">{channel.label}</span>
                  <input type="time" name={`${channel.key}_start`} defaultValue={start} className={INPUT_CLASS} />
                  <input type="time" name={`${channel.key}_end`} defaultValue={end} className={INPUT_CLASS} />
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    <input type="checkbox" name={`${channel.key}_always`} defaultChecked={always} />
                    24/7 send
                  </label>
                </div>
              );
            })}
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Last updated {formatUpdatedAt(quietSetting?.updatedAt ?? null)}</span>
              <SubmitButton
                className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                pendingLabel="Saving..."
              >
                Save quiet hours
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={quietSetting} />
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">{POLICY_LABELS.service_area.title}</h3>
            <p className="text-xs text-slate-500">{POLICY_LABELS.service_area.description}</p>
          </div>
          <form action={updateServiceAreaPolicyAction} className="mt-4 space-y-4">
            <div>
              <label className={LABEL_CLASS}>Coverage</label>
              <select
                name="mode"
                defaultValue={serviceMode}
                className={INPUT_CLASS}
              >
                <option value="ga_above_macon">Georgia above Macon</option>
                <option value="ga_only">Georgia only (all GA ZIPs)</option>
                <option value="zip_allowlist">ZIP allowlist (advanced)</option>
              </select>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={LABEL_CLASS}>Home base</label>
                <input
                  name="homeBase"
                  defaultValue={typeof serviceValue["homeBase"] === "string" ? serviceValue["homeBase"] : ""}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Radius (miles)</label>
                <input
                  name="radiusMiles"
                  type="number"
                  step="1"
                  defaultValue={typeof serviceValue["radiusMiles"] === "number" ? serviceValue["radiusMiles"] : 50}
                  className={INPUT_CLASS}
                />
              </div>
            </div>
            <div>
              <label className={LABEL_CLASS}>ZIP allowlist</label>
              <textarea
                name="zipAllowlist"
                rows={4}
                defaultValue={zipAllowlist.join(", ")}
                className={TEXTAREA_CLASS}
                disabled={serviceMode === "ga_only" || serviceMode === "ga_above_macon"}
              />
              <p className="mt-2 text-[11px] text-slate-500">
                When Coverage is set to Georgia only or Georgia above Macon, this list is ignored.
              </p>
            </div>
            {serviceMode === "ga_only" ? (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                Any Georgia ZIP code is allowed. Out-of-state ZIP codes are treated as out of area.
              </div>
            ) : null}
            {serviceMode === "ga_above_macon" ? (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                Georgia ZIP codes north of Macon are allowed. ZIP codes south of Macon are treated as out of area.
              </div>
            ) : null}
            <div>
              <label className={LABEL_CLASS}>Notes</label>
              <input
                name="notes"
                defaultValue={typeof serviceValue["notes"] === "string" ? serviceValue["notes"] : ""}
                className={INPUT_CLASS}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Last updated {formatUpdatedAt(serviceSetting?.updatedAt ?? null)}</span>
              <SubmitButton
                className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                pendingLabel="Saving..."
              >
                Save service area
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={serviceSetting} />
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">{POLICY_LABELS.company_profile.title}</h3>
            <p className="text-xs text-slate-500">{POLICY_LABELS.company_profile.description}</p>
          </div>
          <form action={updateCompanyProfilePolicyAction} className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={LABEL_CLASS}>Business name</label>
                <input name="businessName" defaultValue={companyBusinessName} className={INPUT_CLASS} required />
              </div>
              <div>
                <label className={LABEL_CLASS}>Primary phone</label>
                <input name="primaryPhone" defaultValue={companyPrimaryPhone} className={INPUT_CLASS} />
              </div>
            </div>
            <div>
              <label className={LABEL_CLASS}>Service area summary</label>
              <textarea
                name="serviceAreaSummary"
                rows={3}
                defaultValue={companyServiceAreaSummary}
                className={TEXTAREA_CLASS}
              />
            </div>
            <div>
              <label className={LABEL_CLASS}>Trailer and pricing summary</label>
              <textarea
                name="trailerAndPricingSummary"
                rows={3}
                defaultValue={companyTrailerAndPricingSummary}
                className={TEXTAREA_CLASS}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={LABEL_CLASS}>What we do</label>
                <textarea name="whatWeDo" rows={4} defaultValue={companyWhatWeDo} className={TEXTAREA_CLASS} />
              </div>
              <div>
                <label className={LABEL_CLASS}>What we do not do</label>
                <textarea
                  name="whatWeDontDo"
                  rows={4}
                  defaultValue={companyWhatWeDontDo}
                  className={TEXTAREA_CLASS}
                />
              </div>
            </div>
            <div>
              <label className={LABEL_CLASS}>Booking style</label>
              <textarea name="bookingStyle" rows={3} defaultValue={companyBookingStyle} className={TEXTAREA_CLASS} />
            </div>
            <div>
              <label className={LABEL_CLASS}>Agent notes</label>
              <textarea name="agentNotes" rows={3} defaultValue={companyAgentNotes} className={TEXTAREA_CLASS} />
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Last updated {formatUpdatedAt(companySetting?.updatedAt ?? null)}</span>
              <SubmitButton
                className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                pendingLabel="Saving..."
              >
                Save company profile
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={companySetting} />
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">{POLICY_LABELS.conversation_persona.title}</h3>
            <p className="text-xs text-slate-500">{POLICY_LABELS.conversation_persona.description}</p>
          </div>
          <form action={updateConversationPersonaPolicyAction} className="mt-4 space-y-4">
            <div>
              <label className={LABEL_CLASS}>System prompt</label>
              <textarea
                name="systemPrompt"
                rows={12}
                defaultValue={personaSystemPrompt}
                className={TEXTAREA_CLASS}
                placeholder="Write the AI's system instructions here (tone, constraints, what to ask for, service area rules, etc.)"
                required
              />
              <p className="mt-2 text-[11px] text-slate-500">
                This is the main instruction block used for draft replies in the Unified Inbox and Sales Autopilot.
              </p>
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Last updated {formatUpdatedAt(personaSetting?.updatedAt ?? null)}</span>
              <SubmitButton
                className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                pendingLabel="Saving..."
              >
                Save persona
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={personaSetting} />
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">{POLICY_LABELS.inbox_alerts.title}</h3>
            <p className="text-xs text-slate-500">{POLICY_LABELS.inbox_alerts.description}</p>
          </div>
          <form action={updateInboxAlertsPolicyAction} className="mt-4 space-y-4">
            <div className="space-y-2">
              <label className="flex items-center gap-3 text-sm text-slate-700">
                <input name="sms" type="checkbox" defaultChecked={inboxAlertsSms} className="h-4 w-4" />
                Alert on inbound SMS
              </label>
              <label className="flex items-center gap-3 text-sm text-slate-700">
                <input name="dm" type="checkbox" defaultChecked={inboxAlertsDm} className="h-4 w-4" />
                Alert on inbound Messenger
              </label>
              <label className="flex items-center gap-3 text-sm text-slate-700">
                <input name="email" type="checkbox" defaultChecked={inboxAlertsEmail} className="h-4 w-4" />
                Alert on inbound email
              </label>
              <p className="text-[11px] text-slate-500">
                Alerts are sent as an SMS to the assigned salesperson’s phone (set in Access).
              </p>
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Last updated {formatUpdatedAt(inboxAlertsSetting?.updatedAt ?? null)}</span>
              <SubmitButton
                className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                pendingLabel="Saving..."
              >
                Save alerts
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={inboxAlertsSetting} />
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">{POLICY_LABELS.booking_rules.title}</h3>
            <p className="text-xs text-slate-500">{POLICY_LABELS.booking_rules.description}</p>
          </div>
          <form action={updateBookingRulesPolicyAction} className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={LABEL_CLASS}>Booking window (days)</label>
                <input
                  name="bookingWindowDays"
                  type="number"
                  step="1"
                  defaultValue={
                    typeof bookingValue["bookingWindowDays"] === "number" ? bookingValue["bookingWindowDays"] : 30
                  }
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Travel buffer (minutes)</label>
                <input
                  name="bufferMinutes"
                  type="number"
                  step="5"
                  defaultValue={typeof bookingValue["bufferMinutes"] === "number" ? bookingValue["bufferMinutes"] : 30}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Max jobs per day</label>
                <input
                  name="maxJobsPerDay"
                  type="number"
                  step="1"
                  defaultValue={typeof bookingValue["maxJobsPerDay"] === "number" ? bookingValue["maxJobsPerDay"] : 6}
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Max jobs per crew</label>
                <input
                  name="maxJobsPerCrew"
                  type="number"
                  step="1"
                  defaultValue={typeof bookingValue["maxJobsPerCrew"] === "number" ? bookingValue["maxJobsPerCrew"] : 3}
                  className={INPUT_CLASS}
                />
              </div>
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Last updated {formatUpdatedAt(bookingSetting?.updatedAt ?? null)}</span>
              <SubmitButton
                className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                pendingLabel="Saving..."
              >
                Save booking rules
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={bookingSetting} />
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">{POLICY_LABELS.confirmation_loop.title}</h3>
            <p className="text-xs text-slate-500">{POLICY_LABELS.confirmation_loop.description}</p>
          </div>
          <form action={updateConfirmationLoopPolicyAction} className="mt-4 space-y-4">
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" name="enabled" defaultChecked={confirmationValue["enabled"] === true} />
              Enabled
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              {[0, 1, 2].map((index) => (
                <div key={index}>
                  <label className={LABEL_CLASS}>Window {index + 1} (hours)</label>
                  <input
                    name={`window_hours_${index + 1}`}
                    type="number"
                    step="1"
                    defaultValue={typeof confirmationWindowHours[index] === "number" ? confirmationWindowHours[index] : ""}
                    className={INPUT_CLASS}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Last updated {formatUpdatedAt(confirmationSetting?.updatedAt ?? null)}</span>
              <SubmitButton
                className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                pendingLabel="Saving..."
              >
                Save confirmation loop
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={confirmationSetting} />
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">{POLICY_LABELS.follow_up_sequence.title}</h3>
            <p className="text-xs text-slate-500">{POLICY_LABELS.follow_up_sequence.description}</p>
          </div>
          <form action={updateFollowUpSequencePolicyAction} className="mt-4 space-y-4">
            <label className="flex items-center gap-2 text-xs text-slate-600">
              <input type="checkbox" name="enabled" defaultChecked={followupValue["enabled"] !== false} />
              Enabled
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((index) => (
                <div key={index}>
                  <label className={LABEL_CLASS}>Step {index + 1} (hours)</label>
                  <input
                    name={`step_hours_${index + 1}`}
                    type="number"
                    step="1"
                    defaultValue={typeof followupStepHours[index] === "number" ? followupStepHours[index] : ""}
                    className={INPUT_CLASS}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Last updated {formatUpdatedAt(followupSetting?.updatedAt ?? null)}</span>
              <SubmitButton
                className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                pendingLabel="Saving..."
              >
                Save follow-up sequence
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={followupSetting} />
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">{POLICY_LABELS.standard_job.title}</h3>
            <p className="text-xs text-slate-500">{POLICY_LABELS.standard_job.description}</p>
          </div>
          <form action={updateStandardJobPolicyAction} className="mt-4 space-y-4">
            <div>
              <label className={LABEL_CLASS}>Allowed services (comma-separated)</label>
              <input
                name="allowedServices"
                defaultValue={
                  Array.isArray(standardValue["allowedServices"])
                    ? standardValue["allowedServices"].join(", ")
                    : ""
                }
                className={INPUT_CLASS}
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={LABEL_CLASS}>Max volume (cubic yards)</label>
                <input
                  name="maxVolumeCubicYards"
                  type="number"
                  step="1"
                  defaultValue={
                    typeof standardValue["maxVolumeCubicYards"] === "number" ? standardValue["maxVolumeCubicYards"] : 12
                  }
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Max item count</label>
                <input
                  name="maxItemCount"
                  type="number"
                  step="1"
                  defaultValue={typeof standardValue["maxItemCount"] === "number" ? standardValue["maxItemCount"] : 20}
                  className={INPUT_CLASS}
                />
              </div>
            </div>
            <div>
              <label className={LABEL_CLASS}>Notes</label>
              <input
                name="notes"
                defaultValue={typeof standardValue["notes"] === "string" ? standardValue["notes"] : ""}
                className={INPUT_CLASS}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Last updated {formatUpdatedAt(standardSetting?.updatedAt ?? null)}</span>
              <SubmitButton
                className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                pendingLabel="Saving..."
              >
                Save standard job
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={standardSetting} />
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">{POLICY_LABELS.item_policies.title}</h3>
            <p className="text-xs text-slate-500">{POLICY_LABELS.item_policies.description}</p>
          </div>
          <form action={updateItemPoliciesAction} className="mt-4 space-y-4">
            <div>
              <label className={LABEL_CLASS}>Declined items (comma-separated)</label>
              <input name="declined" defaultValue={itemDeclined.join(", ")} className={INPUT_CLASS} />
            </div>
            <div className="space-y-2">
              <span className={LABEL_CLASS}>Extra fees</span>
              {[0, 1, 2, 3, 4].map((index) => {
                const row = itemExtraFees[index];
                const item = row && typeof row["item"] === "string" ? row["item"] : "";
                const fee = row && typeof row["fee"] === "number" ? row["fee"] : "";
                return (
                  <div key={index} className="grid gap-3 sm:grid-cols-[1fr_160px]">
                    <input
                      name={`fee_item_${index + 1}`}
                      placeholder="Item"
                      defaultValue={item}
                      className={INPUT_CLASS}
                    />
                    <input
                      name={`fee_amount_${index + 1}`}
                      type="number"
                      step="1"
                      placeholder="Fee"
                      defaultValue={fee}
                      className={INPUT_CLASS}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Last updated {formatUpdatedAt(itemSetting?.updatedAt ?? null)}</span>
              <SubmitButton
                className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                pendingLabel="Saving..."
              >
                Save item policies
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={itemSetting} />
        </div>
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">{POLICY_LABELS.templates.title}</h3>
            <p className="text-xs text-slate-500">{POLICY_LABELS.templates.description}</p>
          </div>
          <form action={updateTemplatesPolicyAction} className="mt-4 space-y-6">
            <div className="space-y-3">
              <p className={LABEL_CLASS}>First touch</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  { key: "sms", label: "SMS" },
                  { key: "email", label: "Email" },
                  { key: "dm", label: "DM" },
                  { key: "call", label: "Call" },
                  { key: "web", label: "Web" }
                ].map((channel) => (
                  <div key={channel.key}>
                    <label className="text-[11px] font-semibold text-slate-500">{channel.label}</label>
                    <textarea
                      name={`first_touch_${channel.key}`}
                      rows={3}
                      defaultValue={templatesFirstTouch[channel.key] ?? ""}
                      className={TEXTAREA_CLASS}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <p className={LABEL_CLASS}>Follow-up</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  { key: "sms", label: "SMS" },
                  { key: "email", label: "Email" }
                ].map((channel) => (
                  <div key={channel.key}>
                    <label className="text-[11px] font-semibold text-slate-500">{channel.label}</label>
                    <textarea
                      name={`follow_up_${channel.key}`}
                      rows={3}
                      defaultValue={templatesFollowUp[channel.key] ?? ""}
                      className={TEXTAREA_CLASS}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <p className={LABEL_CLASS}>Confirmations</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  { key: "sms", label: "SMS" },
                  { key: "email", label: "Email" }
                ].map((channel) => (
                  <div key={channel.key}>
                    <label className="text-[11px] font-semibold text-slate-500">{channel.label}</label>
                    <textarea
                      name={`confirmations_${channel.key}`}
                      rows={3}
                      defaultValue={templatesConfirmations[channel.key] ?? ""}
                      className={TEXTAREA_CLASS}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <p className={LABEL_CLASS}>Reviews</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  { key: "sms", label: "SMS" },
                  { key: "email", label: "Email" }
                ].map((channel) => (
                  <div key={channel.key}>
                    <label className="text-[11px] font-semibold text-slate-500">{channel.label}</label>
                    <textarea
                      name={`reviews_${channel.key}`}
                      rows={3}
                      defaultValue={templatesReviews[channel.key] ?? ""}
                      className={TEXTAREA_CLASS}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="space-y-3">
              <p className={LABEL_CLASS}>Out of area</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  { key: "sms", label: "SMS" },
                  { key: "email", label: "Email" },
                  { key: "web", label: "Web" }
                ].map((channel) => (
                  <div key={channel.key}>
                    <label className="text-[11px] font-semibold text-slate-500">{channel.label}</label>
                    <textarea
                      name={`out_of_area_${channel.key}`}
                      rows={3}
                      defaultValue={templatesOutOfArea[channel.key] ?? ""}
                      className={TEXTAREA_CLASS}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>Last updated {formatUpdatedAt(templatesSetting?.updatedAt ?? null)}</span>
              <SubmitButton
                className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                pendingLabel="Saving..."
              >
                Save templates
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={templatesSetting} />
        </div>
      </div>
    </section>
  );
}
