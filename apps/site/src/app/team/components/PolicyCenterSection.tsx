import { randomUUID } from "node:crypto";
import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import {
  PolicyCard,
  PolicyCenterWorkspace,
} from "./PolicyCenterWorkspaceClient";
import {
  POLICY_CARD_DEFINITIONS,
  POLICY_TEMPLATE_CHANNELS,
  formatPolicyEditor,
  type PolicyCardId,
} from "./policy-center-model";
import { SystemHealthBanner } from "./SystemHealthBanner";
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
  updateReviewRequestPolicyAction,
  updateSalesAutopilotSignatureAction,
  updateServiceAreaPolicyAction,
  updateStandardJobPolicyAction,
  updateTemplatesPolicyAction,
} from "../actions";

type PolicySetting = {
  key: string;
  value: Record<string, unknown>;
  version: string;
  updatedAt: string | null;
  updatedBy: string | null;
};

type SystemHealthFinding = {
  id: string;
  severity: "blocker" | "warning";
  title: string;
  detail: string;
  fix: string[];
};

type SystemHealthPayload = {
  ok?: boolean;
  generatedAt?: string;
  blockers: SystemHealthFinding[];
  warnings: SystemHealthFinding[];
};

type PolicyKey = Exclude<PolicyCardId, "sales_autopilot_signature">;

const POLICY_LABELS = Object.fromEntries(
  POLICY_CARD_DEFINITIONS.filter(
    (definition) => definition.id !== "sales_autopilot_signature",
  ).map(({ id, title, description }) => [id, { title, description }]),
) as Record<PolicyKey, { title: string; description: string }>;

const INPUT_CLASS =
  "min-h-[44px] w-full rounded-2xl border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:focus:ring-primary-800";

const TEXTAREA_CLASS =
  "w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:focus:ring-primary-800";

const LABEL_CLASS =
  "text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400";

const DEFAULT_BUSINESS_START: Record<string, string> = {
  monday: "08:00",
  tuesday: "08:00",
  wednesday: "08:00",
  thursday: "08:00",
  friday: "08:00",
  saturday: "09:00",
  sunday: "08:00",
};

const DEFAULT_BUSINESS_END: Record<string, string> = {
  monday: "18:00",
  tuesday: "18:00",
  wednesday: "18:00",
  thursday: "18:00",
  friday: "18:00",
  saturday: "14:00",
  sunday: "18:00",
};

const WEEKDAYS = [
  { key: "monday", label: "Monday" },
  { key: "tuesday", label: "Tuesday" },
  { key: "wednesday", label: "Wednesday" },
  { key: "thursday", label: "Thursday" },
  { key: "friday", label: "Friday" },
  { key: "saturday", label: "Saturday" },
  { key: "sunday", label: "Sunday" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readGroup(
  value: Record<string, unknown>,
  key: string,
): Record<string, string> {
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
  if (!updatedAt) {
    return "Not saved yet (using the system default)";
  }
  const parsed = new Date(updatedAt);
  if (Number.isNaN(parsed.getTime())) {
    return "Saved timestamp unavailable";
  }
  return parsed.toLocaleString(undefined, { timeZone: TEAM_TIME_ZONE });
}

function canonicalPolicyVersion(updatedAt: unknown): string | null {
  if (updatedAt === null) return "absent";
  if (typeof updatedAt !== "string") return null;
  const parsed = new Date(updatedAt);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === updatedAt
    ? updatedAt
    : null;
}

function policyRevisionKey(
  setting: PolicySetting | undefined,
  fallbackValue: unknown,
): string {
  return setting?.updatedAt ?? `default:${JSON.stringify(fallbackValue)}`;
}

function PolicyExpectedVersionField({
  setting,
}: {
  setting: PolicySetting | undefined;
}): React.ReactElement {
  return (
    <>
      <input
        type="hidden"
        name="expectedVersion"
        value={setting ? setting.version : "absent"}
      />
      <input
        type="hidden"
        name="idempotencyKey"
        value={`policy:${setting?.key ?? "unavailable"}:${randomUUID()}`}
      />
    </>
  );
}

function PolicyCardShell({
  id,
  setting,
  revisionKey,
  metadataUnavailable = false,
  canWrite,
  currentMemberId,
  currentMemberLabel,
  children,
}: {
  id: PolicyCardId;
  setting?: PolicySetting;
  revisionKey: string;
  metadataUnavailable?: boolean;
  canWrite: boolean;
  currentMemberId: string;
  currentMemberLabel: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <PolicyCard
      id={id}
      canWrite={canWrite}
      updatedAtLabel={formatUpdatedAt(setting?.updatedAt ?? null)}
      editorLabel={
        metadataUnavailable
          ? "Not exposed by this endpoint"
          : formatPolicyEditor(
              setting?.updatedBy,
              currentMemberId,
              currentMemberLabel,
              Boolean(setting?.updatedAt),
            )
      }
      metadataUnavailable={metadataUnavailable}
      revisionKey={revisionKey}
    >
      {children}
    </PolicyCard>
  );
}

function AdvancedJsonEditor(props: { setting: PolicySetting | undefined }) {
  const setting = props.setting;
  if (!setting) {
    return null;
  }
  const editorId = `policy-expert-json-${setting.key}`;
  const helpId = `${editorId}-help`;
  return (
    <details className="mt-4">
      <summary className="cursor-pointer rounded-xl text-xs font-semibold text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:text-slate-300">
        Expert: raw JSON
      </summary>
      <form action={updatePolicyAction} className="mt-3 space-y-3">
        <input type="hidden" name="key" value={setting.key} />
        <PolicyExpectedVersionField setting={setting} />
        <div
          id={helpId}
          className="rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs leading-5 text-amber-950 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100"
        >
          Use the structured fields above whenever possible. Raw JSON can expose
          advanced values. Invalid shapes are rejected, and the loaded policy
          version prevents stale JSON from overwriting a teammate&apos;s save.
        </div>
        <label
          htmlFor={editorId}
          className="text-xs font-semibold text-slate-700 dark:text-slate-200"
        >
          Raw policy JSON
        </label>
        <textarea
          id={editorId}
          name="value"
          rows={6}
          required
          spellCheck={false}
          aria-describedby={helpId}
          defaultValue={JSON.stringify(setting.value ?? {}, null, 2)}
          className={TEXTAREA_CLASS}
        />
        <div className="flex items-center justify-between text-[11px] text-slate-500">
          <span>Last updated {formatUpdatedAt(setting.updatedAt)}</span>
          <SubmitButton
            className="min-h-[44px] w-full rounded-full bg-slate-900 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-slate-200/60 transition hover:bg-slate-800 sm:w-auto"
            pendingLabel="Saving..."
          >
            Save JSON
          </SubmitButton>
        </div>
      </form>
    </details>
  );
}

export async function PolicyCenterSection({
  systemHealth,
}: {
  systemHealth?: SystemHealthPayload | null;
}): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const canWrite = hasTeamPermission(principal, "policy.write");
  const currentMemberLabel = principal.name?.trim() || principal.label;
  const response = await callAdminApiAs(principal, "/api/admin/policy");
  if (!response.ok) {
    throw new Error("Failed to load policy settings");
  }

  const payload = (await response.json()) as { settings?: PolicySetting[] };
  const settings = payload.settings ?? [];
  const settingsByKey = new Map(
    settings.map((setting) => [setting.key, setting]),
  );

  const businessSetting = settingsByKey.get("business_hours");
  const businessValue = isRecord(businessSetting?.value)
    ? businessSetting.value
    : {};
  const businessWeekly = isRecord(businessValue["weekly"])
    ? businessValue["weekly"]
    : {};
  const businessTimezone =
    typeof businessValue["timezone"] === "string" &&
    businessValue["timezone"].trim().length > 0
      ? businessValue["timezone"]
      : "America/New_York";
  const hasMultipleBusinessWindows = WEEKDAYS.some(({ key }) => {
    const windows = Array.isArray(businessWeekly[key])
      ? businessWeekly[key]
      : [];
    return windows.length > 1;
  });

  const quietSetting = settingsByKey.get("quiet_hours");
  const quietValue = isRecord(quietSetting?.value) ? quietSetting.value : {};
  const quietChannels = isRecord(quietValue["channels"])
    ? quietValue["channels"]
    : {};
  const quietSms: Record<string, unknown> = isRecord(quietChannels["sms"])
    ? quietChannels["sms"]
    : {};
  const quietEmail: Record<string, unknown> = isRecord(quietChannels["email"])
    ? quietChannels["email"]
    : {};
  const quietDm: Record<string, unknown> = isRecord(quietChannels["dm"])
    ? quietChannels["dm"]
    : {};

  const serviceSetting = settingsByKey.get("service_area");
  const serviceValue = isRecord(serviceSetting?.value)
    ? serviceSetting.value
    : {};
  const serviceMode =
    serviceValue["mode"] === "ga_only"
      ? "ga_only"
      : serviceValue["mode"] === "ga_above_macon"
        ? "ga_above_macon"
        : "zip_allowlist";
  const zipAllowlist = Array.isArray(serviceValue["zipAllowlist"])
    ? serviceValue["zipAllowlist"].filter(
        (zip): zip is string => typeof zip === "string",
      )
    : [];
  const cityAllowlist = Array.isArray(serviceValue["cityAllowlist"])
    ? serviceValue["cityAllowlist"].filter(
        (city): city is string => typeof city === "string",
      )
    : [];

  const companySetting = settingsByKey.get("company_profile");
  const companyValue = isRecord(companySetting?.value)
    ? companySetting.value
    : {};
  const companyBusinessName =
    typeof companyValue["businessName"] === "string" &&
    companyValue["businessName"].trim().length > 0
      ? companyValue["businessName"]
      : "Stonegate Junk Removal";
  const companyPrimaryPhone =
    typeof companyValue["primaryPhone"] === "string" &&
    companyValue["primaryPhone"].trim().length > 0
      ? companyValue["primaryPhone"]
      : "(404) 777-2631";
  const companyDiscountPercent = (() => {
    const raw = companyValue["discountPercent"];
    const num =
      typeof raw === "number"
        ? raw
        : typeof raw === "string"
          ? Number(raw)
          : NaN;
    if (!Number.isFinite(num)) return 0.15;
    return Math.min(0.9, Math.max(0, num));
  })();
  const companyServiceAreaSummary =
    typeof companyValue["serviceAreaSummary"] === "string" &&
    companyValue["serviceAreaSummary"].trim().length > 0
      ? companyValue["serviceAreaSummary"]
      : "North Metro Atlanta and north-central Georgia. Broad local location is fine early in the conversation, and the exact address can wait until the customer is ready to close unless the job appears out of state.";
  const companyTrailerAndPricingSummary =
    typeof companyValue["trailerAndPricingSummary"] === "string" &&
    companyValue["trailerAndPricingSummary"].trim().length > 0
      ? companyValue["trailerAndPricingSummary"]
      : "We use a 7x16x4 dump trailer. Pricing is strictly based on trailer volume in quarter trailer increments. Photos help us estimate quickly.";
  const companyWhatWeDo =
    typeof companyValue["whatWeDo"] === "string" &&
    companyValue["whatWeDo"].trim().length > 0
      ? companyValue["whatWeDo"]
      : "Junk removal and hauling for household and light commercial items.";
  const companyWhatWeDontDo =
    typeof companyValue["whatWeDontDo"] === "string" &&
    companyValue["whatWeDontDo"].trim().length > 0
      ? companyValue["whatWeDontDo"]
      : "We do not service out of area locations. We do not take hazmat, oils, or paints. Ask if unsure.";
  const companyBookingStyle =
    typeof companyValue["bookingStyle"] === "string" &&
    companyValue["bookingStyle"].trim().length > 0
      ? companyValue["bookingStyle"]
      : "Offer 2 concrete options and move to booking. Do not stop the sale to ask for ZIP, city, or exact address early unless the lead appears out of state. Get item details, photos, and preferred timing first, then confirm the exact address later when closing.";
  const companyAgentNotes =
    typeof companyValue["agentNotes"] === "string" &&
    companyValue["agentNotes"].trim().length > 0
      ? companyValue["agentNotes"]
      : "Keep replies short, friendly, and human. Avoid lists and avoid dash characters. No links. Do not keep asking for ZIP, city, or exact address early in the sale. Broad local location is good enough until the customer is ready to close unless the job appears outside Georgia.";
  const companyOutboundCallRecordingNotice =
    typeof companyValue["outboundCallRecordingNotice"] === "string"
      ? companyValue["outboundCallRecordingNotice"]
      : "This call may be recorded for quality and training.";

  let salesAutopilotName = "Devon";
  let salesAutopilotSignatureSetting: PolicySetting | undefined;
  try {
    const autopilotResponse = await callAdminApiAs(
      principal,
      "/api/admin/sales/autopilot",
    );
    if (autopilotResponse.ok) {
      const autopilotPayload = (await autopilotResponse
        .json()
        .catch(() => null)) as {
        policy?: { agentDisplayName?: string };
        metadata?: { updatedAt?: unknown; updatedBy?: unknown };
      } | null;
      const candidate = autopilotPayload?.policy?.agentDisplayName;
      const version = canonicalPolicyVersion(
        autopilotPayload?.metadata?.updatedAt,
      );
      const updatedBy = autopilotPayload?.metadata?.updatedBy;
      if (
        typeof candidate === "string" &&
        candidate.trim().length > 0 &&
        version !== null &&
        (updatedBy === null || typeof updatedBy === "string")
      ) {
        salesAutopilotName = candidate.trim();
        salesAutopilotSignatureSetting = {
          key: "sales_autopilot_signature",
          value: { agentDisplayName: salesAutopilotName },
          version,
          updatedAt: version === "absent" ? null : version,
          updatedBy,
        };
      }
    }
  } catch {
    salesAutopilotName = "Devon";
  }

  const personaSetting = settingsByKey.get("conversation_persona");
  const personaValue = isRecord(personaSetting?.value)
    ? personaSetting.value
    : {};
  const personaSystemPrompt =
    typeof personaValue["systemPrompt"] === "string" &&
    personaValue["systemPrompt"].trim().length > 0
      ? personaValue["systemPrompt"]
      : "";

  const inboxAlertsSetting = settingsByKey.get("inbox_alerts");
  const inboxAlertsValue = isRecord(inboxAlertsSetting?.value)
    ? inboxAlertsSetting.value
    : {};
  const inboxAlertsSms = inboxAlertsValue["sms"] !== false;
  const inboxAlertsDm = inboxAlertsValue["dm"] === true;
  const inboxAlertsEmail = inboxAlertsValue["email"] === true;

  const bookingSetting = settingsByKey.get("booking_rules");
  const bookingValue = isRecord(bookingSetting?.value)
    ? bookingSetting.value
    : {};

  const confirmationSetting = settingsByKey.get("confirmation_loop");
  const confirmationValue = isRecord(confirmationSetting?.value)
    ? confirmationSetting.value
    : {};
  const confirmationWindowsMinutes = Array.isArray(
    confirmationValue["windowsMinutes"],
  )
    ? confirmationValue["windowsMinutes"].filter(
        (value): value is number => typeof value === "number",
      )
    : [];
  const confirmationWindowHours = confirmationWindowsMinutes.map(
    (value) => value / 60,
  );

  const followupSetting = settingsByKey.get("follow_up_sequence");
  const followupValue = isRecord(followupSetting?.value)
    ? followupSetting.value
    : {};
  const followupStepsMinutes = Array.isArray(followupValue["stepsMinutes"])
    ? followupValue["stepsMinutes"].filter(
        (value): value is number => typeof value === "number",
      )
    : [];
  const followupStepHours = followupStepsMinutes.map((value) => value / 60);

  const standardSetting = settingsByKey.get("standard_job");
  const standardValue = isRecord(standardSetting?.value)
    ? standardSetting.value
    : {};

  const itemSetting = settingsByKey.get("item_policies");
  const itemValue = isRecord(itemSetting?.value) ? itemSetting.value : {};
  const itemDeclined = Array.isArray(itemValue["declined"])
    ? itemValue["declined"].filter(
        (item): item is string => typeof item === "string",
      )
    : [];
  const itemExtraFees = Array.isArray(itemValue["extraFees"])
    ? itemValue["extraFees"].filter((item): item is Record<string, unknown> =>
        isRecord(item),
      )
    : [];

  const templatesSetting = settingsByKey.get("templates");
  const templatesValue = isRecord(templatesSetting?.value)
    ? templatesSetting.value
    : {};
  const templatesFirstTouch = readGroup(templatesValue, "first_touch");
  const templatesFollowUp = readGroup(templatesValue, "follow_up");
  const templatesConfirmations = readGroup(templatesValue, "confirmations");
  const templatesReviews = readGroup(templatesValue, "reviews");
  const templatesOutOfArea = readGroup(templatesValue, "out_of_area");

  const reviewRequestSetting = settingsByKey.get("review_request");
  const reviewRequestValue = isRecord(reviewRequestSetting?.value)
    ? reviewRequestSetting.value
    : {};
  const reviewRequestEnabled = reviewRequestValue["enabled"] !== false;
  const reviewRequestUrl =
    typeof reviewRequestValue["reviewUrl"] === "string" &&
    reviewRequestValue["reviewUrl"].trim().length > 0
      ? reviewRequestValue["reviewUrl"]
      : "https://g.page/r/Ce6kQH50C8_dEAI/review";

  const normalizedHealth =
    systemHealth &&
    Array.isArray(systemHealth.blockers) &&
    Array.isArray(systemHealth.warnings)
      ? systemHealth
      : null;

  return (
    <section className="space-y-6">
      {normalizedHealth ? (
        <SystemHealthBanner health={normalizedHealth} />
      ) : null}
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <h2 className="text-xl font-semibold text-slate-900">Policy Center</h2>
        <p className="mt-1 text-sm text-slate-600">
          Update business rules and templates without code changes. Changes are
          logged automatically.
        </p>
      </header>

      <PolicyCenterWorkspace canWrite={canWrite}>
        <PolicyCardShell
          id="business_hours"
          setting={businessSetting}
          revisionKey={policyRevisionKey(businessSetting, businessValue)}
          canWrite={canWrite}
          currentMemberId={principal.memberId}
          currentMemberLabel={currentMemberLabel}
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">
              {POLICY_LABELS.business_hours.title}
            </h3>
            <p className="text-xs text-slate-500">
              {POLICY_LABELS.business_hours.description}
            </p>
          </div>
          <form
            action={updateBusinessHoursPolicyAction}
            className="mt-4 space-y-4"
          >
            <PolicyExpectedVersionField setting={businessSetting} />
            <div>
              <label className={LABEL_CLASS}>Timezone</label>
              <input
                name="timezone"
                defaultValue={businessTimezone}
                required
                maxLength={100}
                aria-describedby="business-timezone-help"
                className={INPUT_CLASS}
              />
              <p
                id="business-timezone-help"
                className="mt-1 text-[11px] text-slate-500"
              >
                Use an IANA timezone such as America/New_York.
              </p>
            </div>
            <div className="space-y-3">
              {WEEKDAYS.map(({ key, label }) => {
                const windows = Array.isArray(businessWeekly[key])
                  ? businessWeekly[key]
                  : [];
                const primary =
                  windows.length > 0 && isRecord(windows[0])
                    ? windows[0]
                    : null;
                const start =
                  primary && typeof primary["start"] === "string"
                    ? primary["start"]
                    : (DEFAULT_BUSINESS_START[key] ?? "08:00");
                const end =
                  primary && typeof primary["end"] === "string"
                    ? primary["end"]
                    : (DEFAULT_BUSINESS_END[key] ?? "18:00");
                const closed = windows.length === 0;

                return (
                  <div
                    key={key}
                    className="grid gap-3 sm:grid-cols-[120px_1fr_1fr_120px] sm:items-center"
                  >
                    <span className="text-xs font-semibold text-slate-700">
                      {label}
                    </span>
                    <input
                      type="time"
                      name={`${key}_start`}
                      defaultValue={start}
                      required
                      className={INPUT_CLASS}
                    />
                    <input
                      type="time"
                      name={`${key}_end`}
                      defaultValue={end}
                      required
                      className={INPUT_CLASS}
                    />
                    <label className="flex min-h-[44px] items-center gap-2 text-xs text-slate-600">
                      <input
                        type="checkbox"
                        name={`${key}_closed`}
                        defaultChecked={closed}
                      />
                      Closed
                    </label>
                  </div>
                );
              })}
            </div>
            {hasMultipleBusinessWindows ? (
              <p className="text-[11px] text-amber-600">
                Multiple windows are configured on some days. Use Advanced JSON
                to edit all windows.
              </p>
            ) : null}
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                Last updated{" "}
                {formatUpdatedAt(businessSetting?.updatedAt ?? null)}
              </span>
              <SubmitButton
                disabled={hasMultipleBusinessWindows}
                className="w-full rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 sm:w-auto"
                pendingLabel="Saving..."
              >
                Save business hours
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={businessSetting} />
        </PolicyCardShell>
        <PolicyCardShell
          id="quiet_hours"
          setting={quietSetting}
          revisionKey={policyRevisionKey(quietSetting, quietValue)}
          canWrite={canWrite}
          currentMemberId={principal.memberId}
          currentMemberLabel={currentMemberLabel}
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">
              {POLICY_LABELS.quiet_hours.title}
            </h3>
            <p className="text-xs text-slate-500">
              {POLICY_LABELS.quiet_hours.description}
            </p>
          </div>
          <form
            action={updateQuietHoursPolicyAction}
            className="mt-4 space-y-3"
          >
            <PolicyExpectedVersionField setting={quietSetting} />
            {[
              { key: "sms", label: "SMS", value: quietSms },
              { key: "email", label: "Email", value: quietEmail },
              { key: "dm", label: "DM", value: quietDm },
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
                <div
                  key={channel.key}
                  className="grid gap-3 sm:grid-cols-[100px_1fr_1fr_140px] sm:items-center"
                >
                  <span className="text-xs font-semibold text-slate-700">
                    {channel.label}
                  </span>
                  <input
                    type="time"
                    name={`${channel.key}_start`}
                    defaultValue={start}
                    required
                    className={INPUT_CLASS}
                  />
                  <input
                    type="time"
                    name={`${channel.key}_end`}
                    defaultValue={end}
                    required
                    className={INPUT_CLASS}
                  />
                  <label className="flex min-h-[44px] items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      name={`${channel.key}_always`}
                      defaultChecked={always}
                    />
                    24/7 send
                  </label>
                </div>
              );
            })}
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                Last updated {formatUpdatedAt(quietSetting?.updatedAt ?? null)}
              </span>
              <SubmitButton
                className="w-full rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 sm:w-auto"
                pendingLabel="Saving..."
              >
                Save quiet hours
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={quietSetting} />
        </PolicyCardShell>
        <PolicyCardShell
          id="service_area"
          setting={serviceSetting}
          revisionKey={policyRevisionKey(serviceSetting, serviceValue)}
          canWrite={canWrite}
          currentMemberId={principal.memberId}
          currentMemberLabel={currentMemberLabel}
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">
              {POLICY_LABELS.service_area.title}
            </h3>
            <p className="text-xs text-slate-500">
              {POLICY_LABELS.service_area.description}
            </p>
          </div>
          <form
            action={updateServiceAreaPolicyAction}
            className="mt-4 space-y-4"
          >
            <PolicyExpectedVersionField setting={serviceSetting} />
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
                  maxLength={200}
                  defaultValue={
                    typeof serviceValue["homeBase"] === "string"
                      ? serviceValue["homeBase"]
                      : ""
                  }
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Radius (miles)</label>
                <input
                  name="radiusMiles"
                  type="number"
                  step="1"
                  min="0"
                  max="500"
                  required
                  defaultValue={
                    typeof serviceValue["radiusMiles"] === "number"
                      ? serviceValue["radiusMiles"]
                      : 50
                  }
                  className={INPUT_CLASS}
                />
              </div>
            </div>
            <div>
              <label className={LABEL_CLASS}>Core service cities</label>
              <textarea
                name="cityAllowlist"
                rows={3}
                defaultValue={cityAllowlist.join(", ")}
                className={TEXTAREA_CLASS}
              />
              <p className="mt-2 text-[11px] text-slate-500">
                These cities are the main service-area signal for sales. If a
                customer gives one of these cities, the agent should proceed
                without asking for ZIP.
              </p>
            </div>
            <div>
              <label className={LABEL_CLASS}>Legacy ZIP list</label>
              <input
                type="hidden"
                name="zipAllowlistPreserved"
                value={zipAllowlist.join(", ")}
              />
              <textarea
                name="zipAllowlist"
                rows={4}
                defaultValue={zipAllowlist.join(", ")}
                className={TEXTAREA_CLASS}
                disabled={
                  serviceMode === "ga_only" || serviceMode === "ga_above_macon"
                }
              />
              <p className="mt-2 text-[11px] text-slate-500">
                This is kept only as legacy background data. Sales flow now uses
                core cities instead of ZIPs, and this list is preserved even
                when ignored.
              </p>
            </div>
            {serviceMode === "ga_only" ? (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                Any Georgia ZIP code is allowed. Out-of-state ZIP codes are
                treated as out of area.
              </div>
            ) : null}
            {serviceMode === "ga_above_macon" ? (
              <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-600">
                Georgia ZIP codes north of Macon are allowed. ZIP codes south of
                Macon are treated as out of area.
              </div>
            ) : null}
            <div>
              <label className={LABEL_CLASS}>Notes</label>
              <input
                name="notes"
                defaultValue={
                  typeof serviceValue["notes"] === "string"
                    ? serviceValue["notes"]
                    : ""
                }
                className={INPUT_CLASS}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                Last updated{" "}
                {formatUpdatedAt(serviceSetting?.updatedAt ?? null)}
              </span>
              <SubmitButton
                className="w-full rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 sm:w-auto"
                pendingLabel="Saving..."
              >
                Save service area
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={serviceSetting} />
        </PolicyCardShell>
        <PolicyCardShell
          id="company_profile"
          setting={companySetting}
          revisionKey={policyRevisionKey(companySetting, companyValue)}
          canWrite={canWrite}
          currentMemberId={principal.memberId}
          currentMemberLabel={currentMemberLabel}
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">
              {POLICY_LABELS.company_profile.title}
            </h3>
            <p className="text-xs text-slate-500">
              {POLICY_LABELS.company_profile.description}
            </p>
          </div>
          <form
            action={updateCompanyProfilePolicyAction}
            className="mt-4 space-y-4"
          >
            <PolicyExpectedVersionField setting={companySetting} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={LABEL_CLASS}>Business name</label>
                <input
                  name="businessName"
                  defaultValue={companyBusinessName}
                  maxLength={200}
                  className={INPUT_CLASS}
                  required
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Primary phone</label>
                <input
                  name="primaryPhone"
                  defaultValue={companyPrimaryPhone}
                  maxLength={50}
                  className={INPUT_CLASS}
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={LABEL_CLASS}>
                  Instant quote discount (%)
                </label>
                <input
                  name="discountPercent"
                  type="number"
                  inputMode="decimal"
                  min="0"
                  max="90"
                  step="0.1"
                  defaultValue={Math.round(companyDiscountPercent * 1000) / 10}
                  className={INPUT_CLASS}
                />
                <p className="mt-1 text-[11px] text-slate-500">
                  Enter 15 for a 15% discount (used by /quote).
                </p>
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
                <textarea
                  name="whatWeDo"
                  rows={4}
                  defaultValue={companyWhatWeDo}
                  className={TEXTAREA_CLASS}
                />
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
              <textarea
                name="bookingStyle"
                rows={3}
                defaultValue={companyBookingStyle}
                className={TEXTAREA_CLASS}
              />
            </div>
            <div>
              <label className={LABEL_CLASS}>Agent notes</label>
              <textarea
                name="agentNotes"
                rows={3}
                defaultValue={companyAgentNotes}
                className={TEXTAREA_CLASS}
              />
            </div>
            <div>
              <label className={LABEL_CLASS}>
                Outbound call recording notice
              </label>
              <textarea
                name="outboundCallRecordingNotice"
                rows={2}
                defaultValue={companyOutboundCallRecordingNotice}
                className={TEXTAREA_CLASS}
                placeholder="Spoken to customers on outbound calls before connecting."
              />
              <p className="mt-2 text-[11px] text-slate-500">
                Leave blank to skip the notice. This is spoken to the customer
                on CRM initiated outbound calls.
              </p>
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                Last updated{" "}
                {formatUpdatedAt(companySetting?.updatedAt ?? null)}
              </span>
              <SubmitButton
                className="w-full rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 sm:w-auto"
                pendingLabel="Saving..."
              >
                Save company profile
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={companySetting} />
        </PolicyCardShell>
        <PolicyCardShell
          id="sales_autopilot_signature"
          setting={salesAutopilotSignatureSetting}
          revisionKey={`sales-autopilot:${salesAutopilotSignatureSetting?.version ?? "unavailable"}:${salesAutopilotName}`}
          canWrite={canWrite && Boolean(salesAutopilotSignatureSetting)}
          currentMemberId={principal.memberId}
          currentMemberLabel={currentMemberLabel}
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">
              Sales agent name
            </h3>
            <p className="text-xs text-slate-500">
              Name used by Sales Autopilot when drafting and sending messages.
            </p>
          </div>
          <form
            action={updateSalesAutopilotSignatureAction}
            className="mt-4 space-y-4"
          >
            {salesAutopilotSignatureSetting ? (
              <PolicyExpectedVersionField
                setting={salesAutopilotSignatureSetting}
              />
            ) : null}
            {!salesAutopilotSignatureSetting ? (
              <p
                role="alert"
                className="rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-xs text-rose-900 dark:border-rose-800 dark:bg-rose-950/50 dark:text-rose-100"
              >
                Sales agent settings could not be verified. Reload this page;
                saving is disabled so an unknown version cannot be overwritten.
              </p>
            ) : null}
            <div>
              <label className={LABEL_CLASS}>Name</label>
              <input
                name="agentDisplayName"
                defaultValue={salesAutopilotName}
                className={INPUT_CLASS}
                required
              />
              <p className="mt-1 text-[11px] text-slate-500">
                Advanced cadence settings live under Messaging Automation.
              </p>
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                Last updated{" "}
                {formatUpdatedAt(
                  salesAutopilotSignatureSetting?.updatedAt ?? null,
                )}
              </span>
              <SubmitButton
                className="w-full rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 sm:w-auto"
                pendingLabel="Saving..."
              >
                Save name
              </SubmitButton>
            </div>
          </form>
        </PolicyCardShell>
        <PolicyCardShell
          id="conversation_persona"
          setting={personaSetting}
          revisionKey={policyRevisionKey(personaSetting, personaValue)}
          canWrite={canWrite}
          currentMemberId={principal.memberId}
          currentMemberLabel={currentMemberLabel}
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">
              {POLICY_LABELS.conversation_persona.title}
            </h3>
            <p className="text-xs text-slate-500">
              {POLICY_LABELS.conversation_persona.description}
            </p>
          </div>
          <form
            action={updateConversationPersonaPolicyAction}
            className="mt-4 space-y-4"
          >
            <PolicyExpectedVersionField setting={personaSetting} />
            <div>
              <label className={LABEL_CLASS}>System prompt</label>
              <textarea
                name="systemPrompt"
                rows={12}
                maxLength={4000}
                defaultValue={personaSystemPrompt}
                className={TEXTAREA_CLASS}
                placeholder="Write the AI's system instructions here (tone, constraints, what to ask for, service area rules, etc.)"
                required
              />
              <p className="mt-2 text-[11px] text-slate-500">
                This is the main instruction block used for draft replies in the
                Unified Inbox and Sales Autopilot.
              </p>
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                Last updated{" "}
                {formatUpdatedAt(personaSetting?.updatedAt ?? null)}
              </span>
              <SubmitButton
                className="w-full rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 sm:w-auto"
                pendingLabel="Saving..."
              >
                Save persona
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={personaSetting} />
        </PolicyCardShell>
        <PolicyCardShell
          id="inbox_alerts"
          setting={inboxAlertsSetting}
          revisionKey={policyRevisionKey(inboxAlertsSetting, inboxAlertsValue)}
          canWrite={canWrite}
          currentMemberId={principal.memberId}
          currentMemberLabel={currentMemberLabel}
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">
              {POLICY_LABELS.inbox_alerts.title}
            </h3>
            <p className="text-xs text-slate-500">
              {POLICY_LABELS.inbox_alerts.description}
            </p>
          </div>
          <form
            action={updateInboxAlertsPolicyAction}
            className="mt-4 space-y-4"
          >
            <PolicyExpectedVersionField setting={inboxAlertsSetting} />
            <div className="space-y-2">
              <label className="flex min-h-[44px] items-center gap-3 text-sm text-slate-700">
                <input
                  name="sms"
                  type="checkbox"
                  defaultChecked={inboxAlertsSms}
                  className="h-4 w-4"
                />
                Alert on inbound SMS
              </label>
              <label className="flex min-h-[44px] items-center gap-3 text-sm text-slate-700">
                <input
                  name="dm"
                  type="checkbox"
                  defaultChecked={inboxAlertsDm}
                  className="h-4 w-4"
                />
                Alert on inbound Messenger
              </label>
              <label className="flex min-h-[44px] items-center gap-3 text-sm text-slate-700">
                <input
                  name="email"
                  type="checkbox"
                  defaultChecked={inboxAlertsEmail}
                  className="h-4 w-4"
                />
                Alert on inbound email
              </label>
              <p className="text-[11px] text-slate-500">
                Alerts are sent as an SMS to the assigned salesperson’s phone
                (set in Access).
              </p>
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                Last updated{" "}
                {formatUpdatedAt(inboxAlertsSetting?.updatedAt ?? null)}
              </span>
              <SubmitButton
                className="w-full rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 sm:w-auto"
                pendingLabel="Saving..."
              >
                Save alerts
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={inboxAlertsSetting} />
        </PolicyCardShell>
        <PolicyCardShell
          id="booking_rules"
          setting={bookingSetting}
          revisionKey={policyRevisionKey(bookingSetting, bookingValue)}
          canWrite={canWrite}
          currentMemberId={principal.memberId}
          currentMemberLabel={currentMemberLabel}
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">
              {POLICY_LABELS.booking_rules.title}
            </h3>
            <p className="text-xs text-slate-500">
              {POLICY_LABELS.booking_rules.description}
            </p>
          </div>
          <form
            action={updateBookingRulesPolicyAction}
            className="mt-4 space-y-4"
          >
            <PolicyExpectedVersionField setting={bookingSetting} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className={LABEL_CLASS}>Booking window (days)</label>
                <input
                  name="bookingWindowDays"
                  type="number"
                  step="1"
                  min="1"
                  max="365"
                  required
                  defaultValue={
                    typeof bookingValue["bookingWindowDays"] === "number"
                      ? bookingValue["bookingWindowDays"]
                      : 30
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
                  min="0"
                  max="1440"
                  required
                  defaultValue={
                    typeof bookingValue["bufferMinutes"] === "number"
                      ? bookingValue["bufferMinutes"]
                      : 30
                  }
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Max jobs per day</label>
                <input
                  name="maxJobsPerDay"
                  type="number"
                  step="1"
                  min="0"
                  max="100"
                  required
                  defaultValue={
                    typeof bookingValue["maxJobsPerDay"] === "number"
                      ? bookingValue["maxJobsPerDay"]
                      : 6
                  }
                  className={INPUT_CLASS}
                />
              </div>
              <div>
                <label className={LABEL_CLASS}>Max jobs per crew</label>
                <input
                  name="maxJobsPerCrew"
                  type="number"
                  step="1"
                  min="0"
                  max="100"
                  required
                  defaultValue={
                    typeof bookingValue["maxJobsPerCrew"] === "number"
                      ? bookingValue["maxJobsPerCrew"]
                      : 3
                  }
                  className={INPUT_CLASS}
                />
              </div>
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                Last updated{" "}
                {formatUpdatedAt(bookingSetting?.updatedAt ?? null)}
              </span>
              <SubmitButton
                className="w-full rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 sm:w-auto"
                pendingLabel="Saving..."
              >
                Save booking rules
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={bookingSetting} />
        </PolicyCardShell>
        <PolicyCardShell
          id="confirmation_loop"
          setting={confirmationSetting}
          revisionKey={policyRevisionKey(
            confirmationSetting,
            confirmationValue,
          )}
          canWrite={canWrite}
          currentMemberId={principal.memberId}
          currentMemberLabel={currentMemberLabel}
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">
              {POLICY_LABELS.confirmation_loop.title}
            </h3>
            <p className="text-xs text-slate-500">
              {POLICY_LABELS.confirmation_loop.description}
            </p>
          </div>
          <form
            action={updateConfirmationLoopPolicyAction}
            className="mt-4 space-y-4"
          >
            <PolicyExpectedVersionField setting={confirmationSetting} />
            <label className="flex min-h-[44px] items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={confirmationValue["enabled"] === true}
              />
              Enabled
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              {[0, 1, 2].map((index) => (
                <div key={index}>
                  <label className={LABEL_CLASS}>
                    Window {index + 1} (hours)
                  </label>
                  <input
                    name={`window_hours_${index + 1}`}
                    type="number"
                    step="1"
                    min="1"
                    max="8760"
                    defaultValue={
                      typeof confirmationWindowHours[index] === "number"
                        ? confirmationWindowHours[index]
                        : ""
                    }
                    className={INPUT_CLASS}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                Last updated{" "}
                {formatUpdatedAt(confirmationSetting?.updatedAt ?? null)}
              </span>
              <SubmitButton
                className="w-full rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 sm:w-auto"
                pendingLabel="Saving..."
              >
                Save confirmation loop
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={confirmationSetting} />
        </PolicyCardShell>
        <PolicyCardShell
          id="follow_up_sequence"
          setting={followupSetting}
          revisionKey={policyRevisionKey(followupSetting, followupValue)}
          canWrite={canWrite}
          currentMemberId={principal.memberId}
          currentMemberLabel={currentMemberLabel}
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">
              {POLICY_LABELS.follow_up_sequence.title}
            </h3>
            <p className="text-xs text-slate-500">
              {POLICY_LABELS.follow_up_sequence.description}
            </p>
          </div>
          <form
            action={updateFollowUpSequencePolicyAction}
            className="mt-4 space-y-4"
          >
            <PolicyExpectedVersionField setting={followupSetting} />
            <label className="flex min-h-[44px] items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={followupValue["enabled"] !== false}
              />
              Enabled
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              {[0, 1, 2, 3].map((index) => (
                <div key={index}>
                  <label className={LABEL_CLASS}>
                    Step {index + 1} (hours)
                  </label>
                  <input
                    name={`step_hours_${index + 1}`}
                    type="number"
                    step="1"
                    min="1"
                    max="8760"
                    defaultValue={
                      typeof followupStepHours[index] === "number"
                        ? followupStepHours[index]
                        : ""
                    }
                    className={INPUT_CLASS}
                  />
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                Last updated{" "}
                {formatUpdatedAt(followupSetting?.updatedAt ?? null)}
              </span>
              <SubmitButton
                className="w-full rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 sm:w-auto"
                pendingLabel="Saving..."
              >
                Save follow-up sequence
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={followupSetting} />
        </PolicyCardShell>
        <PolicyCardShell
          id="standard_job"
          setting={standardSetting}
          revisionKey={policyRevisionKey(standardSetting, standardValue)}
          canWrite={canWrite}
          currentMemberId={principal.memberId}
          currentMemberLabel={currentMemberLabel}
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">
              {POLICY_LABELS.standard_job.title}
            </h3>
            <p className="text-xs text-slate-500">
              {POLICY_LABELS.standard_job.description}
            </p>
          </div>
          <form
            action={updateStandardJobPolicyAction}
            className="mt-4 space-y-4"
          >
            <PolicyExpectedVersionField setting={standardSetting} />
            <div>
              <label className={LABEL_CLASS}>
                Allowed services (comma-separated)
              </label>
              <input
                name="allowedServices"
                required
                maxLength={4000}
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
                  min="0"
                  max="10000"
                  required
                  defaultValue={
                    typeof standardValue["maxVolumeCubicYards"] === "number"
                      ? standardValue["maxVolumeCubicYards"]
                      : 12
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
                  min="0"
                  max="100000"
                  required
                  defaultValue={
                    typeof standardValue["maxItemCount"] === "number"
                      ? standardValue["maxItemCount"]
                      : 20
                  }
                  className={INPUT_CLASS}
                />
              </div>
            </div>
            <div>
              <label className={LABEL_CLASS}>Notes</label>
              <input
                name="notes"
                defaultValue={
                  typeof standardValue["notes"] === "string"
                    ? standardValue["notes"]
                    : ""
                }
                className={INPUT_CLASS}
              />
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                Last updated{" "}
                {formatUpdatedAt(standardSetting?.updatedAt ?? null)}
              </span>
              <SubmitButton
                className="w-full rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 sm:w-auto"
                pendingLabel="Saving..."
              >
                Save standard job
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={standardSetting} />
        </PolicyCardShell>
        <PolicyCardShell
          id="item_policies"
          setting={itemSetting}
          revisionKey={policyRevisionKey(itemSetting, itemValue)}
          canWrite={canWrite}
          currentMemberId={principal.memberId}
          currentMemberLabel={currentMemberLabel}
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">
              {POLICY_LABELS.item_policies.title}
            </h3>
            <p className="text-xs text-slate-500">
              {POLICY_LABELS.item_policies.description}
            </p>
          </div>
          <form action={updateItemPoliciesAction} className="mt-4 space-y-4">
            <PolicyExpectedVersionField setting={itemSetting} />
            <div>
              <label className={LABEL_CLASS}>
                Declined items (comma-separated)
              </label>
              <input
                name="declined"
                defaultValue={itemDeclined.join(", ")}
                className={INPUT_CLASS}
              />
            </div>
            <div className="space-y-2">
              <span className={LABEL_CLASS}>Extra fees</span>
              {[0, 1, 2, 3, 4].map((index) => {
                const row = itemExtraFees[index];
                const item =
                  row && typeof row["item"] === "string" ? row["item"] : "";
                const fee =
                  row && typeof row["fee"] === "number" ? row["fee"] : "";
                return (
                  <div
                    key={index}
                    className="grid gap-3 sm:grid-cols-[1fr_160px]"
                  >
                    <input
                      name={`fee_item_${index + 1}`}
                      placeholder="Item"
                      maxLength={200}
                      defaultValue={item}
                      className={INPUT_CLASS}
                    />
                    <input
                      name={`fee_amount_${index + 1}`}
                      type="number"
                      step="1"
                      min="0"
                      max="1000000"
                      placeholder="Fee"
                      defaultValue={fee}
                      className={INPUT_CLASS}
                    />
                  </div>
                );
              })}
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                Last updated {formatUpdatedAt(itemSetting?.updatedAt ?? null)}
              </span>
              <SubmitButton
                className="w-full rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 sm:w-auto"
                pendingLabel="Saving..."
              >
                Save item policies
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={itemSetting} />
        </PolicyCardShell>
        <PolicyCardShell
          id="templates"
          setting={templatesSetting}
          revisionKey={policyRevisionKey(templatesSetting, templatesValue)}
          canWrite={canWrite}
          currentMemberId={principal.memberId}
          currentMemberLabel={currentMemberLabel}
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">
              {POLICY_LABELS.templates.title}
            </h3>
            <p className="text-xs text-slate-500">
              {POLICY_LABELS.templates.description}
            </p>
          </div>
          <form action={updateTemplatesPolicyAction} className="mt-4 space-y-6">
            <PolicyExpectedVersionField setting={templatesSetting} />
            <div className="space-y-3">
              <p className={LABEL_CLASS}>First touch</p>
              <div className="grid gap-3 sm:grid-cols-2">
                {POLICY_TEMPLATE_CHANNELS.first_touch.map((channel) => (
                  <div key={channel.key}>
                    <label
                      htmlFor={`policy-template-first-touch-${channel.key}`}
                      className="text-[11px] font-semibold text-slate-500"
                    >
                      {channel.label}
                    </label>
                    <textarea
                      id={`policy-template-first-touch-${channel.key}`}
                      name={`first_touch_${channel.key}`}
                      rows={3}
                      maxLength={8000}
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
                {POLICY_TEMPLATE_CHANNELS.follow_up.map((channel) => (
                  <div key={channel.key}>
                    <label
                      htmlFor={`policy-template-follow-up-${channel.key}`}
                      className="text-[11px] font-semibold text-slate-500"
                    >
                      {channel.label}
                    </label>
                    <textarea
                      id={`policy-template-follow-up-${channel.key}`}
                      name={`follow_up_${channel.key}`}
                      rows={3}
                      maxLength={8000}
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
                {POLICY_TEMPLATE_CHANNELS.confirmations.map((channel) => (
                  <div key={channel.key}>
                    <label
                      htmlFor={`policy-template-confirmations-${channel.key}`}
                      className="text-[11px] font-semibold text-slate-500"
                    >
                      {channel.label}
                    </label>
                    <textarea
                      id={`policy-template-confirmations-${channel.key}`}
                      name={`confirmations_${channel.key}`}
                      rows={3}
                      maxLength={8000}
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
                {POLICY_TEMPLATE_CHANNELS.reviews.map((channel) => (
                  <div key={channel.key}>
                    <label
                      htmlFor={`policy-template-reviews-${channel.key}`}
                      className="text-[11px] font-semibold text-slate-500"
                    >
                      {channel.label}
                    </label>
                    <textarea
                      id={`policy-template-reviews-${channel.key}`}
                      name={`reviews_${channel.key}`}
                      rows={3}
                      maxLength={8000}
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
                {POLICY_TEMPLATE_CHANNELS.out_of_area.map((channel) => (
                  <div key={channel.key}>
                    <label
                      htmlFor={`policy-template-out-of-area-${channel.key}`}
                      className="text-[11px] font-semibold text-slate-500"
                    >
                      {channel.label}
                    </label>
                    <textarea
                      id={`policy-template-out-of-area-${channel.key}`}
                      name={`out_of_area_${channel.key}`}
                      rows={3}
                      maxLength={8000}
                      defaultValue={templatesOutOfArea[channel.key] ?? ""}
                      className={TEXTAREA_CLASS}
                    />
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                Last updated{" "}
                {formatUpdatedAt(templatesSetting?.updatedAt ?? null)}
              </span>
              <SubmitButton
                className="w-full rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 sm:w-auto"
                pendingLabel="Saving..."
              >
                Save templates
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={templatesSetting} />
        </PolicyCardShell>

        <PolicyCardShell
          id="review_request"
          setting={reviewRequestSetting}
          revisionKey={policyRevisionKey(
            reviewRequestSetting,
            reviewRequestValue,
          )}
          canWrite={canWrite}
          currentMemberId={principal.memberId}
          currentMemberLabel={currentMemberLabel}
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-base font-semibold text-slate-900">
              {POLICY_LABELS.review_request.title}
            </h3>
            <p className="text-xs text-slate-500">
              {POLICY_LABELS.review_request.description}
            </p>
          </div>
          <form
            action={updateReviewRequestPolicyAction}
            className="mt-4 space-y-4"
          >
            <PolicyExpectedVersionField setting={reviewRequestSetting} />
            <label className="flex min-h-[44px] items-center gap-2 text-sm text-slate-700">
              <input
                type="checkbox"
                name="enabled"
                defaultChecked={reviewRequestEnabled}
              />
              Send review request after completion
            </label>
            <div>
              <label className={LABEL_CLASS}>Google review link</label>
              <input
                name="reviewUrl"
                defaultValue={reviewRequestUrl}
                inputMode="url"
                required
                maxLength={2048}
                className={INPUT_CLASS}
              />
              <p className="mt-1 text-xs text-slate-500">
                Example: https://g.page/r/Ce6kQH50C8_dEAI/review
              </p>
            </div>
            <div className="flex items-center justify-between text-[11px] text-slate-500">
              <span>
                Last updated{" "}
                {formatUpdatedAt(reviewRequestSetting?.updatedAt ?? null)}
              </span>
              <SubmitButton
                className="w-full rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700 sm:w-auto"
                pendingLabel="Saving..."
              >
                Save review settings
              </SubmitButton>
            </div>
          </form>
          <AdvancedJsonEditor setting={reviewRequestSetting} />
        </PolicyCardShell>
      </PolicyCenterWorkspace>
    </section>
  );
}
