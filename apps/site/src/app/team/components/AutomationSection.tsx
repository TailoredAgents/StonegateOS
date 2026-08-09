import { randomUUID } from "node:crypto";
import React from "react";
import {
  hasTeamPermission,
  requireCurrentTeamPrincipal,
} from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { teamSurfaceHref } from "../surface-registry";
import {
  updateLeadAutomationAction,
  updateSalesAutopilotPolicyAction,
} from "../actions";
import { AutomationReviewForm } from "./AutomationReviewForm";
import { LeadAutomationControlClient } from "./LeadAutomationControlClient";

type PublicAutomationMode = "off" | "assist" | "automatic";

type AutomationChannel = {
  channel: string;
  mode: string;
  publicMode?: PublicAutomationMode;
  version: string;
  updatedAt: string | null;
};

type AutomationMetadata = {
  version: string;
  updatedAt: string | null;
  updatedBy: string | null;
  concurrencyControl: "if-match";
  idempotencyReceipts: "durable";
};

type SalesAutopilotPolicy = {
  mode: PublicAutomationMode;
  channelModes: Record<"sms" | "email" | "dm", PublicAutomationMode>;
  enabled: boolean;
  emergencyStop: boolean;
  dailyAutomaticSendCap: number;
  autoSendAfterMinutes: number;
  activityWindowMinutes: number;
  retryDelayMinutes: number;
  dmSmsFallbackAfterMinutes: number;
  dmMinSilenceBeforeSmsMinutes: number;
  dmMissingInfoFollowupDelayMinutes: number;
  dmQuoteFollowupDelayMinutes: number;
  dmObjectionFollowupDelayMinutes: number;
  agentDisplayName: string;
  plannerAutoSendEnabled: boolean;
  plannerAutoSendMinDraftAgeMinutes: number;
  plannerAutoSendChannels: string[];
  plannerAutoSendActions: string[];
  liveReplyAutonomyEnabled: boolean;
  liveReplyAutonomyChannels: string[];
  liveReplyAutonomyActions: string[];
  facebookCloser: {
    mode: "off" | "shadow" | "assist" | "auto";
    allowedServices: string[];
    maxAutoBookTotalCents: number;
    minConfidence: "medium" | "high";
    requireCustomerConfirmation: boolean;
    requirePhotosAboveCents: number;
    allowDmSmsFallback: boolean;
    emergencyStop: boolean;
    messengerResponseWindowHours: number;
  };
  facebookCoaching: {
    enabled: boolean;
    tone: "friendly" | "professional" | "concise";
    playbook: string;
    requirePhotosBeforeQuote: boolean;
    requireHumanReviewBeforeBooking: boolean;
    humanReviewKeywords: string[];
    blockedAutoReplyKeywords: string[];
  };
};

type FacebookReadiness = Record<
  | "facebookWebhookConfigured"
  | "messengerTokenConfigured"
  | "outboxWorkerConfigured"
  | "openAiKeyConfigured"
  | "bookingEndpointReachable"
  | "calendarConfigured"
  | "serviceAreaPolicyConfigured",
  boolean
>;

type FacebookAction = {
  id: string;
  contactId: string | null;
  threadId: string | null;
  stage: string;
  proposedAction: string;
  executedAction: string | null;
  autonomyMode: string;
  decisionReason: string | null;
  humanReviewReason: string | null;
  error: string | null;
  createdAt: string | null;
};

const SALES_AGENT_AUTOSEND_CHANNELS = [
  { value: "sms", label: "SMS" },
  { value: "dm", label: "Messenger DM" },
  { value: "email", label: "Email" },
] as const;

const SALES_AGENT_AUTOSEND_ACTIONS = [
  { value: "missed_call_recovery", label: "Missed call recovery" },
  { value: "dm_sms_handoff", label: "Messenger to SMS handoff" },
  { value: "follow_up_quote", label: "Quote follow up" },
  { value: "collect_missing_info", label: "Collect missing info" },
];

const SALES_AGENT_LIVE_REPLY_ACTIONS = [
  {
    value: "handle_price_objection",
    label: "Price objection save (Automatic only)",
  },
  { value: "reply_now", label: "Immediate reply (Automatic only)" },
] as const;

const CLOSE_LOOP_FOLLOWUP_ACTIONS = [
  {
    value: "appointment_checkin",
    label: "Pre-appointment check in",
    detail:
      "Light reassurance touch before a booked appointment when the booking looks shaky.",
  },
  {
    value: "post_job_checkin",
    label: "Post-job check in",
    detail:
      "Human-style satisfaction follow-up after the completed job, separate from review requests.",
  },
] as const;

const CLOSE_LOOP_LIVE_REPLY_ACTIONS = [
  {
    value: "appointment_support",
    label: "Booked-job support or reschedule save",
    detail:
      "Handles low-risk timing, logistics, and light reschedule-save conversations on booked jobs.",
  },
] as const;

const AUTOPILOT_MODE_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "assist", label: "Assist" },
  { value: "automatic", label: "Automatic" },
] as const;

const FACEBOOK_READINESS_LABELS: Record<keyof FacebookReadiness, string> = {
  facebookWebhookConfigured: "Facebook webhook configured",
  messengerTokenConfigured: "Messenger token configured",
  outboxWorkerConfigured: "Outbox worker running",
  openAiKeyConfigured: "OpenAI key configured",
  bookingEndpointReachable: "Booking endpoint reachable",
  calendarConfigured: "Calendar configured",
  serviceAreaPolicyConfigured: "Service-area policy configured",
};

function centsToDollars(cents: number): string {
  return String(Math.round((Number.isFinite(cents) ? cents : 0) / 100));
}

function keywordList(values: string[]): string {
  return values.join(", ");
}

function isCanonicalSettingsVersion(value: string | null): value is string {
  if (value === "absent") return true;
  if (!value) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString() === value;
}

export async function AutomationSection(): Promise<React.ReactElement> {
  const principal = await requireCurrentTeamPrincipal();
  const hasWritePermission = hasTeamPermission(principal, "automation.write");
  const response = await callAdminApiAs(principal, "/api/admin/automation");
  const payload = response.ok
    ? ((await response.json().catch(() => null)) as {
        channels?: AutomationChannel[];
      } | null)
    : null;
  const channels = payload?.channels ?? [];
  const channelsError = response.ok
    ? null
    : `Channel compatibility settings could not be loaded (${response.status}).`;

  const autopilotResponse = await callAdminApiAs(
    principal,
    "/api/admin/sales/autopilot",
  );
  const autopilotPayload = autopilotResponse.ok
    ? ((await autopilotResponse.json().catch(() => null)) as {
        policy?: SalesAutopilotPolicy;
        publicPolicy?: SalesAutopilotPolicy;
        facebookReadiness?: FacebookReadiness;
        recentFacebookActions?: FacebookAction[];
        metadata?: AutomationMetadata;
      } | null)
    : null;
  const autopilot =
    autopilotPayload?.publicPolicy ?? autopilotPayload?.policy ?? null;
  if (!autopilot) {
    return (
      <section className="space-y-4" aria-labelledby="automation-heading">
        <header className="rounded-3xl border border-slate-200 bg-white p-6">
          <h2
            id="automation-heading"
            className="text-xl font-semibold text-slate-900"
          >
            Messaging Automation
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            Automation settings are temporarily unavailable. No settings were
            changed.
          </p>
        </header>
        <div
          role="alert"
          className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-800"
        >
          Sales Autopilot could not be loaded ({autopilotResponse.status}).
          Refresh to retry. If this continues, leave automation in its current
          state and contact an administrator.
        </div>
      </section>
    );
  }
  const selectedPlannerActions = new Set(autopilot.plannerAutoSendActions);
  const selectedLiveReplyActions = new Set(autopilot.liveReplyAutonomyActions);
  const facebookReadiness = autopilotPayload?.facebookReadiness ?? {
    facebookWebhookConfigured: false,
    messengerTokenConfigured: false,
    outboxWorkerConfigured: false,
    openAiKeyConfigured: false,
    bookingEndpointReachable: false,
    calendarConfigured: false,
    serviceAreaPolicyConfigured: false,
  };
  const recentFacebookActions = autopilotPayload?.recentFacebookActions ?? [];
  const settingsVersion = autopilotPayload?.metadata?.version ?? null;
  const hasMutationSafetyMetadata = Boolean(
    isCanonicalSettingsVersion(settingsVersion) &&
      autopilotPayload?.metadata?.concurrencyControl === "if-match" &&
      autopilotPayload?.metadata?.idempotencyReceipts === "durable",
  );
  const canWrite = hasWritePermission && hasMutationSafetyMetadata;
  const idempotencyKey = `automation-settings-${randomUUID()}`;
  const readinessPassed =
    Object.values(facebookReadiness).filter(Boolean).length;
  const readinessTotal = Object.values(facebookReadiness).length;

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <h2
          id="automation-heading"
          className="text-xl font-semibold text-slate-900"
        >
          Messaging Automation
        </h2>
        <p className="mt-1 text-sm text-slate-600">
          Use one clear model everywhere: Off, Assist, or Automatic. Safety
          rules always take priority over the selected mode.
        </p>
        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
          <span className="font-semibold">Current mode:</span>{" "}
          <span
            className={
              autopilot.mode === "off"
                ? "text-slate-700"
                : autopilot.mode === "assist"
                  ? "text-amber-700"
                  : "text-emerald-700"
            }
          >
            {autopilot.mode === "off"
              ? "Off"
              : autopilot.mode === "assist"
                ? "Assist"
                : "Automatic"}
          </span>
          {autopilot.emergencyStop ? (
            <span className="ml-3 rounded-full bg-rose-100 px-2 py-1 font-semibold text-rose-800">
              Emergency stop active
            </span>
          ) : null}
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <h3 className="text-base font-semibold text-slate-900">
            Sales Autopilot
          </h3>
          <p className="text-xs text-slate-500">
            Off prevents automatic work. Assist prepares work for a person to
            approve. Automatic can perform only the specifically enabled,
            eligible actions.
          </p>
          {hasWritePermission && !hasMutationSafetyMetadata ? (
            <p
              role="alert"
              className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs font-medium text-rose-800"
            >
              Safe save metadata could not be verified. Editing is disabled;
              refresh before making changes.
            </p>
          ) : null}
          <AutomationReviewForm
            action={updateSalesAutopilotPolicyAction}
            canWrite={canWrite}
            expectedVersion={settingsVersion ?? "unavailable"}
            idempotencyKey={idempotencyKey}
          >
            <label className="flex min-h-11 items-start gap-3 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-rose-950">
              <input
                type="checkbox"
                name="emergencyStop"
                defaultChecked={autopilot.emergencyStop}
                className="mt-0.5 h-5 w-5 rounded border-rose-300"
              />
              <span>
                <span className="block text-sm font-semibold">
                  Global emergency stop
                </span>
                <span className="block text-xs">
                  Forces Sales Autopilot messaging and booking decisions off
                  across channels. Drafts and human-approved work remain
                  available.
                </span>
              </span>
            </label>
            <label className="flex max-w-xs flex-col gap-1">
              <span>Global mode</span>
              <select
                name="mode"
                defaultValue={autopilot.mode}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              >
                <option value="off">Off</option>
                <option value="assist">Assist</option>
                <option value="automatic">Automatic</option>
              </select>
            </label>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
              <div className="space-y-1">
                <h4 className="text-sm font-semibold text-slate-900">
                  Channel mode overrides
                </h4>
                <p className="text-xs text-slate-500">
                  Set SMS, Messenger, and email independently. Off blocks
                  automatic work, Assist requires approval, and Automatic can
                  perform eligible actions.
                </p>
                <p className="text-xs text-slate-500">
                  Messenger has one extra guardrail: live DM autopilot stays
                  approval-only until there has been a real back-and-forth, so
                  the system does not treat the first Facebook lead card like a
                  fully trusted conversation.
                </p>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {(["sms", "dm", "email"] as const).map((channel) => (
                  <label key={channel} className="flex flex-col gap-1">
                    <span>
                      {channel === "dm" ? "Messenger" : channel.toUpperCase()}
                    </span>
                    <select
                      name={`channelMode_${channel}`}
                      defaultValue={autopilot.channelModes[channel]}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    >
                      {AUTOPILOT_MODE_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span>Daily automatic-send cap</span>
                <input
                  name="dailyAutomaticSendCap"
                  type="number"
                  min={1}
                  max={1000}
                  step={1}
                  defaultValue={autopilot.dailyAutomaticSendCap}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Auto-send after (minutes)</span>
                <input
                  name="autoSendAfterMinutes"
                  type="number"
                  min={15}
                  max={120}
                  defaultValue={autopilot.autoSendAfterMinutes}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Activity window (minutes)</span>
                <input
                  name="activityWindowMinutes"
                  type="number"
                  min={1}
                  max={120}
                  defaultValue={autopilot.activityWindowMinutes}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Retry delay (minutes)</span>
                <input
                  name="retryDelayMinutes"
                  type="number"
                  min={1}
                  max={60}
                  defaultValue={autopilot.retryDelayMinutes}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Agent name</span>
                <input
                  name="agentDisplayName"
                  defaultValue={autopilot.agentDisplayName}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
            </div>

            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <label className="flex flex-col gap-1">
                <span>DM to SMS fallback after (minutes)</span>
                <input
                  name="dmSmsFallbackAfterMinutes"
                  type="number"
                  min={15}
                  max={1440}
                  defaultValue={autopilot.dmSmsFallbackAfterMinutes}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Min DM silence before SMS (minutes)</span>
                <input
                  name="dmMinSilenceBeforeSmsMinutes"
                  type="number"
                  min={5}
                  max={720}
                  defaultValue={autopilot.dmMinSilenceBeforeSmsMinutes}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>DM missing-info delay (minutes)</span>
                <input
                  name="dmMissingInfoFollowupDelayMinutes"
                  type="number"
                  min={5}
                  max={1440}
                  defaultValue={autopilot.dmMissingInfoFollowupDelayMinutes}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>DM quote follow-up delay (minutes)</span>
                <input
                  name="dmQuoteFollowupDelayMinutes"
                  type="number"
                  min={15}
                  max={4320}
                  defaultValue={autopilot.dmQuoteFollowupDelayMinutes}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>DM objection / hesitation delay (minutes)</span>
                <input
                  name="dmObjectionFollowupDelayMinutes"
                  type="number"
                  min={15}
                  max={7200}
                  defaultValue={autopilot.dmObjectionFollowupDelayMinutes}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
              <div className="space-y-1">
                <h4 className="text-sm font-semibold text-slate-900">
                  Planner follow-up auto-send
                </h4>
                <p className="text-xs text-slate-500">
                  Controls the newer Sales HQ and Inbox planner drafts for
                  scheduled follow-up behavior. Assist keeps drafts waiting for
                  approval. Automatic may send eligible follow-ups. Off blocks
                  automatic work.
                </p>
                <p className="text-xs text-slate-500">
                  Appointment check-ins use the same planner path. They are
                  separate from the core transactional confirmations and
                  reminders, so you can keep those working while deciding
                  whether the agent is allowed to send extra pre-appointment
                  reassurance touches.
                </p>
                <p className="text-xs text-slate-500">
                  Post-job check-ins also stay separate from the existing
                  review-request automation. Use them if you want the agent to
                  send a human-style satisfaction follow-up without replacing
                  the current Google review request flow.
                </p>
              </div>

              <div className="mt-4 space-y-4">
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    name="plannerAutoSendEnabled"
                    defaultChecked={autopilot.plannerAutoSendEnabled}
                    className="h-4 w-4 rounded border-slate-300"
                  />
                  Enable planner auto-send
                </label>

                <label className="flex max-w-xs flex-col gap-1">
                  <span>Minimum draft age before send (minutes)</span>
                  <input
                    name="plannerAutoSendMinDraftAgeMinutes"
                    type="number"
                    min={1}
                    max={1440}
                    defaultValue={autopilot.plannerAutoSendMinDraftAgeMinutes}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  />
                </label>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Allowed channels
                    </span>
                    {SALES_AGENT_AUTOSEND_CHANNELS.map((option) => (
                      <label
                        key={option.value}
                        className="flex items-center gap-2"
                      >
                        <input
                          type="checkbox"
                          name="plannerAutoSendChannels"
                          value={option.value}
                          defaultChecked={autopilot.plannerAutoSendChannels.includes(
                            option.value,
                          )}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        {option.label}
                      </label>
                    ))}
                  </div>

                  <div className="space-y-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      Allowed actions
                    </span>
                    {SALES_AGENT_AUTOSEND_ACTIONS.map((option) => (
                      <label
                        key={option.value}
                        className="flex items-center gap-2"
                      >
                        <input
                          type="checkbox"
                          name="plannerAutoSendActions"
                          value={option.value}
                          defaultChecked={autopilot.plannerAutoSendActions.includes(
                            option.value,
                          )}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        {option.label}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4">
                  <div className="space-y-1">
                    <h5 className="text-sm font-semibold text-slate-900">
                      Close-loop follow-up actions
                    </h5>
                    <p className="text-xs text-slate-600">
                      These are the post-booking and post-job planner touches.
                      They still use the same autosend path above, but this
                      grouping makes it easier to turn appointment and after-job
                      behavior on intentionally.
                    </p>
                  </div>

                  <div className="mt-3 space-y-3">
                    {CLOSE_LOOP_FOLLOWUP_ACTIONS.map((option) => (
                      <label
                        key={option.value}
                        className="flex items-start gap-3 rounded-2xl border border-sky-200 bg-white/80 px-3 py-3"
                      >
                        <input
                          type="checkbox"
                          name="plannerAutoSendActions"
                          value={option.value}
                          defaultChecked={selectedPlannerActions.has(
                            option.value,
                          )}
                          className="mt-0.5 h-4 w-4 rounded border-slate-300"
                        />
                        <span className="space-y-1">
                          <span className="block text-sm font-semibold text-slate-900">
                            {option.label}
                          </span>
                          <span className="block text-xs text-slate-600">
                            {option.detail}
                          </span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
                <div className="space-y-1">
                  <h4 className="text-sm font-semibold text-slate-900">
                    Live reply autonomy
                  </h4>
                  <p className="text-xs text-slate-600">
                    This is the Phase 7 gate for true autonomous salesperson
                    behavior. Keep this off while you tune the system in suggest
                    mode. Even in Automatic, live inbound replies stay
                    approval-only until this block is enabled and scoped.
                  </p>
                  <p className="text-xs text-slate-600">
                    This still runs through the same planner autosend worker
                    above, so if planner auto-send is off, live replies will not
                    send even if this block is enabled.
                  </p>
                </div>

                <div className="mt-4 space-y-4">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name="liveReplyAutonomyEnabled"
                      defaultChecked={autopilot.liveReplyAutonomyEnabled}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    Enable live reply autonomy
                  </label>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        Allowed live-reply channels
                      </span>
                      {SALES_AGENT_AUTOSEND_CHANNELS.map((option) => (
                        <label
                          key={`live-${option.value}`}
                          className="flex items-center gap-2"
                        >
                          <input
                            type="checkbox"
                            name="liveReplyAutonomyChannels"
                            value={option.value}
                            defaultChecked={autopilot.liveReplyAutonomyChannels.includes(
                              option.value,
                            )}
                            className="h-4 w-4 rounded border-slate-300"
                          />
                          {option.label}
                        </label>
                      ))}
                    </div>

                    <div className="space-y-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                        Allowed live-reply actions
                      </span>
                      {SALES_AGENT_LIVE_REPLY_ACTIONS.map((option) => (
                        <label
                          key={option.value}
                          className="flex items-center gap-2"
                        >
                          <input
                            type="checkbox"
                            name="liveReplyAutonomyActions"
                            value={option.value}
                            defaultChecked={autopilot.liveReplyAutonomyActions.includes(
                              option.value,
                            )}
                            className="h-4 w-4 rounded border-slate-300"
                          />
                          {option.label}
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4">
                    <div className="space-y-1">
                      <h5 className="text-sm font-semibold text-slate-900">
                        Close-loop live-reply actions
                      </h5>
                      <p className="text-xs text-slate-600">
                        This is the booked-job side of autonomy. Keep it off
                        until you trust the agent with real appointment timing
                        and light reschedule-save conversations.
                      </p>
                    </div>

                    <div className="mt-3 space-y-3">
                      {CLOSE_LOOP_LIVE_REPLY_ACTIONS.map((option) => (
                        <label
                          key={option.value}
                          className="flex items-start gap-3 rounded-2xl border border-sky-200 bg-white/80 px-3 py-3"
                        >
                          <input
                            type="checkbox"
                            name="liveReplyAutonomyActions"
                            value={option.value}
                            defaultChecked={selectedLiveReplyActions.has(
                              option.value,
                            )}
                            className="mt-0.5 h-4 w-4 rounded border-slate-300"
                          />
                          <span className="space-y-1">
                            <span className="block text-sm font-semibold text-slate-900">
                              {option.label}
                            </span>
                            <span className="block text-xs text-slate-600">
                              {option.detail}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl border border-blue-200 bg-blue-50/70 p-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div>
                  <h4 className="text-sm font-semibold text-slate-900">
                    Facebook Sales Autopilot
                  </h4>
                  <p className="text-xs text-slate-600">
                    Junk removal only. Auto-booking requires a shown price, an
                    offered time, and a clear customer yes.
                  </p>
                </div>
                <span className="rounded-full border border-blue-200 bg-white px-3 py-1 text-[11px] font-semibold text-blue-800">
                  Ready {readinessPassed}/{readinessTotal}
                </span>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <div className="rounded-xl border border-slate-200 bg-white px-3 py-2">
                  <input
                    type="hidden"
                    name="facebookCloserMode"
                    value={autopilot.facebookCloser.mode}
                  />
                  <span className="block font-semibold text-slate-800">
                    Facebook compatibility behavior
                  </span>
                  <span className="block text-slate-500">
                    Preserved internally and governed by the Off, Assist, or
                    Automatic settings above.
                  </span>
                </div>
                <label className="flex flex-col gap-1">
                  <span>Max auto-book price ($)</span>
                  <input
                    name="facebookCloserMaxAutoBookDollars"
                    type="number"
                    min={150}
                    max={5000}
                    defaultValue={centsToDollars(
                      autopilot.facebookCloser.maxAutoBookTotalCents,
                    )}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span>Minimum confidence</span>
                  <select
                    name="facebookCloserMinConfidence"
                    defaultValue={autopilot.facebookCloser.minConfidence}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  >
                    <option value="medium">Medium</option>
                    <option value="high">High</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span>Require photos above ($)</span>
                  <input
                    name="facebookCloserRequirePhotosAboveDollars"
                    type="number"
                    min={0}
                    max={5000}
                    defaultValue={centsToDollars(
                      autopilot.facebookCloser.requirePhotosAboveCents,
                    )}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span>Messenger response window (hours)</span>
                  <input
                    name="facebookCloserMessengerResponseWindowHours"
                    type="number"
                    min={1}
                    max={24}
                    defaultValue={
                      autopilot.facebookCloser.messengerResponseWindowHours
                    }
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  />
                </label>
                <div className="space-y-2 pt-5">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name="facebookCloserAllowDmSmsFallback"
                      defaultChecked={
                        autopilot.facebookCloser.allowDmSmsFallback
                      }
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    DM-to-SMS fallback
                  </label>
                  <label className="flex items-center gap-2 text-rose-700">
                    <input
                      type="checkbox"
                      name="facebookCloserEmergencyStop"
                      defaultChecked={autopilot.facebookCloser.emergencyStop}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    Emergency stop
                  </label>
                </div>
              </div>

              <div className="mt-4 grid gap-2 sm:grid-cols-2">
                {(
                  Object.entries(FACEBOOK_READINESS_LABELS) as Array<
                    [keyof FacebookReadiness, string]
                  >
                ).map(([key, label]) => (
                  <div
                    key={key}
                    className="flex items-center justify-between rounded-xl border border-blue-100 bg-white/80 px-3 py-2"
                  >
                    <span>{label}</span>
                    <span
                      className={
                        facebookReadiness[key]
                          ? "font-semibold text-emerald-700"
                          : "font-semibold text-amber-700"
                      }
                    >
                      {facebookReadiness[key] ? "Ready" : "Check"}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-4 rounded-2xl border border-blue-100 bg-white/90 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h5 className="text-sm font-semibold text-slate-900">
                      Owner Coaching
                    </h5>
                    <p className="text-xs text-slate-600">
                      Approved guidance for tone and flow. Keyword guardrails
                      immediately route risky conversations to review.
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-xs font-semibold text-blue-900">
                    <input
                      type="checkbox"
                      name="facebookCoachingEnabled"
                      defaultChecked={autopilot.facebookCoaching.enabled}
                      className="h-4 w-4 rounded border-slate-300"
                    />
                    Coaching active
                  </label>
                </div>

                <div className="mt-4 grid gap-3 lg:grid-cols-[220px_1fr]">
                  <label className="flex flex-col gap-1">
                    <span>Tone</span>
                    <select
                      name="facebookCoachingTone"
                      defaultValue={autopilot.facebookCoaching.tone}
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    >
                      <option value="friendly">Friendly</option>
                      <option value="professional">Professional</option>
                      <option value="concise">Concise</option>
                    </select>
                  </label>
                  <label className="flex flex-col gap-1">
                    <span>Approved playbook</span>
                    <textarea
                      name="facebookCoachingPlaybook"
                      defaultValue={autopilot.facebookCoaching.playbook}
                      rows={5}
                      maxLength={3000}
                      className="min-h-32 rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    />
                  </label>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                    <input
                      type="checkbox"
                      name="facebookCoachingRequirePhotosBeforeQuote"
                      defaultChecked={
                        autopilot.facebookCoaching.requirePhotosBeforeQuote
                      }
                      className="mt-0.5 h-4 w-4 rounded border-slate-300"
                    />
                    <span>
                      <span className="block font-semibold text-slate-800">
                        Require photos before quote/time offers
                      </span>
                      <span className="block text-slate-500">
                        If no photos are present, the agent asks for photos
                        instead of quoting or offering times.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                    <input
                      type="checkbox"
                      name="facebookCoachingRequireHumanReviewBeforeBooking"
                      defaultChecked={
                        autopilot.facebookCoaching
                          .requireHumanReviewBeforeBooking
                      }
                      className="mt-0.5 h-4 w-4 rounded border-slate-300"
                    />
                    <span>
                      <span className="block font-semibold text-slate-800">
                        Human review before auto-booking
                      </span>
                      <span className="block text-slate-500">
                        The agent can still draft and offer times, but confirmed
                        bookings wait for review.
                      </span>
                    </span>
                  </label>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span>Always human-review keywords</span>
                    <input
                      name="facebookCoachingHumanReviewKeywords"
                      defaultValue={keywordList(
                        autopilot.facebookCoaching.humanReviewKeywords,
                      )}
                      placeholder="hot tub, hazmat, complaint"
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span>Block auto-reply keywords</span>
                    <input
                      name="facebookCoachingBlockedAutoReplyKeywords"
                      defaultValue={keywordList(
                        autopilot.facebookCoaching.blockedAutoReplyKeywords,
                      )}
                      placeholder="refund, lawsuit, angry"
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    />
                  </label>
                </div>
              </div>
            </div>
          </AutomationReviewForm>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <h3 className="text-base font-semibold text-slate-900">Mode guide</h3>
          <p className="text-xs text-slate-500">
            Use this to decide how much authority the system should have while
            you build trust.
          </p>
          <div className="mt-4 space-y-3 text-xs text-slate-600">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <span className="font-semibold text-slate-900">Off:</span> drafts,
              planning, and recommendations only. No automatic sending.
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <span className="font-semibold text-slate-900">Assist:</span>{" "}
              drafts and recommendations are prepared, but a person approves the
              action before it happens.
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <span className="font-semibold text-slate-900">Automatic:</span>{" "}
              eligible actions may run only when all safety gates and the
              specific action allowlist pass.
            </div>
          </div>

          <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-950">
            <h4 className="text-sm font-semibold">Effective safety order</h4>
            <p className="mt-1">
              The first matching rule wins. A later mode can never bypass an
              earlier safety rule.
            </p>
            <ol className="mt-3 list-decimal space-y-2 pl-5">
              <li>Do Not Contact</li>
              <li>Human takeover or lead/channel pause</li>
              <li>Quiet hours or sending cap</li>
              <li>Channel mode override</li>
              <li>Global mode</li>
            </ol>
            <p className="mt-3 font-semibold text-rose-800">
              The global emergency stop forces Off before any automatic action
              can execute.
            </p>
          </div>

          <div className="mt-6">
            <h4 className="text-sm font-semibold text-slate-900">
              Recent Facebook actions
            </h4>
            <div className="mt-3 overflow-hidden rounded-2xl border border-slate-200">
              {recentFacebookActions.length === 0 ? (
                <div className="bg-slate-50 px-4 py-3 text-xs text-slate-500">
                  No autonomous Facebook decisions recorded yet.
                </div>
              ) : (
                <div className="divide-y divide-slate-200 text-xs">
                  {recentFacebookActions.map((action) => (
                    <a
                      key={action.id}
                      href={
                        action.threadId
                          ? teamSurfaceHref("inbox", {
                              query: { threadId: action.threadId },
                            })
                          : teamSurfaceHref("inbox")
                      }
                      className="block bg-white px-4 py-3 transition hover:bg-slate-50"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900">
                          {action.proposedAction}
                        </span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                          {action.autonomyMode}
                        </span>
                      </div>
                      <div className="mt-1 text-slate-500">
                        {action.stage} ·{" "}
                        {action.executedAction ?? "not executed"}
                      </div>
                      <div
                        className={
                          action.error
                            ? "mt-1 text-rose-600"
                            : "mt-1 text-slate-500"
                        }
                      >
                        {action.error ??
                          action.humanReviewReason ??
                          action.decisionReason ??
                          "No reason saved"}
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <details className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <summary className="min-h-11 cursor-pointer text-base font-semibold text-slate-900">
            Advanced compatibility status
          </summary>
          <p className="mt-2 text-xs text-slate-500">
            Older channel records remain readable for compatibility. Saving the
            public channel modes above keeps these records synchronized; they
            are no longer a second control surface.
          </p>
          {channelsError ? (
            <p
              role="alert"
              className="mt-3 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800"
            >
              {channelsError} Refresh to retry.
            </p>
          ) : channels.length === 0 ? (
            <p
              role="status"
              className="mt-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600"
            >
              No compatibility channels are configured.
            </p>
          ) : (
            <dl className="mt-4 space-y-3">
              {channels.map((channel) => {
                const publicMode =
                  channel.publicMode ??
                  (channel.mode === "auto"
                    ? "automatic"
                    : channel.mode === "assist"
                      ? "assist"
                      : "off");
                return (
                  <div
                    key={channel.channel}
                    className="flex min-h-11 flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs"
                  >
                    <dt className="w-24 font-semibold uppercase tracking-wide text-slate-700">
                      {channel.channel}
                    </dt>
                    <dd className="font-semibold text-slate-900">
                      {publicMode === "automatic"
                        ? "Automatic"
                        : publicMode === "assist"
                          ? "Assist"
                          : "Off"}
                    </dd>
                    <dd className="ml-auto text-slate-500">
                      {channel.updatedAt
                        ? new Date(channel.updatedAt).toLocaleString(
                            undefined,
                            {
                              timeZone: TEAM_TIME_ZONE,
                            },
                          )
                        : "Default compatibility value"}
                    </dd>
                  </div>
                );
              })}
            </dl>
          )}
        </details>

        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <h3 className="text-base font-semibold text-slate-900">
            Lead-level kill switches
          </h3>
          <p className="text-xs text-slate-500">
            Pause follow-ups, mark Do Not Contact, or force human takeover for a
            specific lead.
          </p>
          <LeadAutomationControlClient
            action={updateLeadAutomationAction}
            channels={channels.map((channel) => channel.channel)}
            canWrite={canWrite}
          />
        </div>
      </div>
    </section>
  );
}
