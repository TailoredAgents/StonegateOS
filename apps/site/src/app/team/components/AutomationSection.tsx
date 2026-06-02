import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import {
  updateAutomationModeAction,
  updateLeadAutomationAction,
  updateSalesAutopilotPolicyAction,
} from "../actions";

type AutomationChannel = {
  channel: string;
  mode: string;
  updatedAt: string | null;
};

type SalesAutopilotPolicy = {
  mode: "off" | "partial" | "full";
  channelModes: Record<"sms" | "email" | "dm", "off" | "partial" | "full">;
  enabled: boolean;
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
  { value: "handle_price_objection", label: "Price objection save (Full only)" },
  { value: "reply_now", label: "Immediate reply (Full only)" },
] as const;

const CLOSE_LOOP_FOLLOWUP_ACTIONS = [
  {
    value: "appointment_checkin",
    label: "Pre-appointment check in",
    detail: "Light reassurance touch before a booked appointment when the booking looks shaky.",
  },
  {
    value: "post_job_checkin",
    label: "Post-job check in",
    detail: "Human-style satisfaction follow-up after the completed job, separate from review requests.",
  },
] as const;

const CLOSE_LOOP_LIVE_REPLY_ACTIONS = [
  {
    value: "appointment_support",
    label: "Booked-job support or reschedule save",
    detail: "Handles low-risk timing, logistics, and light reschedule-save conversations on booked jobs.",
  },
] as const;

const AUTOPILOT_MODE_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "partial", label: "Partial" },
  { value: "full", label: "Full" },
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

export async function AutomationSection(): Promise<React.ReactElement> {
  const response = await callAdminApi("/api/admin/automation");
  if (!response.ok) {
    throw new Error("Failed to load automation settings");
  }

  const payload = (await response.json()) as { channels?: AutomationChannel[] };
  const channels = payload.channels ?? [];

  const autopilotResponse = await callAdminApi("/api/admin/sales/autopilot");
  if (!autopilotResponse.ok) {
    throw new Error("Failed to load Sales Autopilot settings");
  }
  const autopilotPayload = (await autopilotResponse.json()) as {
    policy?: SalesAutopilotPolicy;
    facebookReadiness?: FacebookReadiness;
    recentFacebookActions?: FacebookAction[];
  };
  const autopilot = autopilotPayload.policy;
  if (!autopilot) {
    throw new Error("Missing Sales Autopilot policy");
  }
  const selectedPlannerActions = new Set(autopilot.plannerAutoSendActions);
  const selectedLiveReplyActions = new Set(autopilot.liveReplyAutonomyActions);
  const facebookReadiness = autopilotPayload.facebookReadiness ?? {
    facebookWebhookConfigured: false,
    messengerTokenConfigured: false,
    outboxWorkerConfigured: false,
    openAiKeyConfigured: false,
    bookingEndpointReachable: false,
    calendarConfigured: false,
    serviceAreaPolicyConfigured: false,
  };
  const recentFacebookActions = autopilotPayload.recentFacebookActions ?? [];
  const readinessPassed = Object.values(facebookReadiness).filter(Boolean).length;
  const readinessTotal = Object.values(facebookReadiness).length;

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <h2 className="text-xl font-semibold text-slate-900">Messaging Automation</h2>
        <p className="mt-1 text-sm text-slate-600">
          Sales Autopilot controls drafts, follow-up automation, and eventually live-reply autonomy. Use Off, Partial, and Full to decide how much the system is allowed to do.
        </p>
        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
          <span className="font-semibold">Current mode:</span>{" "}
          <span className={autopilot.mode === "off" ? "text-slate-700" : autopilot.mode === "partial" ? "text-amber-700" : "text-emerald-700"}>
            {autopilot.mode === "off" ? "Off" : autopilot.mode === "partial" ? "Partial" : "Full"}
          </span>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <h3 className="text-base font-semibold text-slate-900">Sales Autopilot</h3>
          <p className="text-xs text-slate-500">
            Off means drafts and planning only. Partial means safe follow-ups can send automatically, but live replies still wait on you. Full is the future fully autonomous mode for channels you trust.
          </p>
          <form action={updateSalesAutopilotPolicyAction} className="mt-4 space-y-4 text-xs text-slate-600">
            <label className="flex max-w-xs flex-col gap-1">
              <span>Global mode</span>
              <select
                name="mode"
                defaultValue={autopilot.mode}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              >
                <option value="off">Off</option>
                <option value="partial">Partial</option>
                <option value="full">Full</option>
              </select>
            </label>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
              <div className="space-y-1">
                <h4 className="text-sm font-semibold text-slate-900">Channel mode overrides</h4>
                <p className="text-xs text-slate-500">
                  Set SMS, Messenger, and email independently. Off means drafts only. Partial means safe follow-ups only. Full allows live autopilot behavior on that channel.
                </p>
                <p className="text-xs text-slate-500">
                  Messenger has one extra guardrail: live DM autopilot stays approval-only until there has been a real back-and-forth, so the system does not treat the first Facebook lead card like a fully trusted conversation.
                </p>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-3">
                {(["sms", "dm", "email"] as const).map((channel) => (
                  <label key={channel} className="flex flex-col gap-1">
                    <span>{channel === "dm" ? "Messenger" : channel.toUpperCase()}</span>
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
                <h4 className="text-sm font-semibold text-slate-900">Planner follow-up auto-send</h4>
                <p className="text-xs text-slate-500">
                  Controls the newer Sales HQ and Inbox planner drafts for scheduled follow-up behavior. This matters in Partial and Full modes. Off mode still drafts, but nothing sends automatically.
                </p>
                <p className="text-xs text-slate-500">
                  Appointment check-ins use the same planner path. They are separate from the core transactional confirmations and reminders, so you can keep those working while deciding whether the agent is allowed to send extra pre-appointment reassurance touches.
                </p>
                <p className="text-xs text-slate-500">
                  Post-job check-ins also stay separate from the existing review-request automation. Use them if you want the agent to send a human-style satisfaction follow-up without replacing the current Google review request flow.
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
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Allowed channels</span>
                    {SALES_AGENT_AUTOSEND_CHANNELS.map((option) => (
                      <label key={option.value} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          name="plannerAutoSendChannels"
                          value={option.value}
                          defaultChecked={autopilot.plannerAutoSendChannels.includes(option.value)}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        {option.label}
                      </label>
                    ))}
                  </div>

                  <div className="space-y-2">
                    <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Allowed actions</span>
                    {SALES_AGENT_AUTOSEND_ACTIONS.map((option) => (
                      <label key={option.value} className="flex items-center gap-2">
                        <input
                          type="checkbox"
                          name="plannerAutoSendActions"
                          value={option.value}
                          defaultChecked={autopilot.plannerAutoSendActions.includes(option.value)}
                          className="h-4 w-4 rounded border-slate-300"
                        />
                        {option.label}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4">
                  <div className="space-y-1">
                    <h5 className="text-sm font-semibold text-slate-900">Close-loop follow-up actions</h5>
                    <p className="text-xs text-slate-600">
                      These are the post-booking and post-job planner touches. They still use the same autosend path above, but this grouping makes it easier to turn appointment and after-job behavior on intentionally.
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
                          defaultChecked={selectedPlannerActions.has(option.value)}
                          className="mt-0.5 h-4 w-4 rounded border-slate-300"
                        />
                        <span className="space-y-1">
                          <span className="block text-sm font-semibold text-slate-900">{option.label}</span>
                          <span className="block text-xs text-slate-600">{option.detail}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="rounded-2xl border border-amber-200 bg-amber-50/70 p-4">
                <div className="space-y-1">
                  <h4 className="text-sm font-semibold text-slate-900">Live reply autonomy</h4>
                  <p className="text-xs text-slate-600">
                    This is the Phase 7 gate for true autonomous salesperson behavior. Keep this off while you tune the system in suggest mode. Even in Full mode, live inbound replies will stay approval-only until this block is enabled and scoped.
                  </p>
                  <p className="text-xs text-slate-600">
                    This still runs through the same planner autosend worker above, so if planner auto-send is off, live replies will not send even if this block is enabled.
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
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Allowed live-reply channels</span>
                      {SALES_AGENT_AUTOSEND_CHANNELS.map((option) => (
                        <label key={`live-${option.value}`} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            name="liveReplyAutonomyChannels"
                            value={option.value}
                            defaultChecked={autopilot.liveReplyAutonomyChannels.includes(option.value)}
                            className="h-4 w-4 rounded border-slate-300"
                          />
                          {option.label}
                        </label>
                      ))}
                    </div>

                    <div className="space-y-2">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Allowed live-reply actions</span>
                      {SALES_AGENT_LIVE_REPLY_ACTIONS.map((option) => (
                        <label key={option.value} className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            name="liveReplyAutonomyActions"
                            value={option.value}
                            defaultChecked={autopilot.liveReplyAutonomyActions.includes(option.value)}
                            className="h-4 w-4 rounded border-slate-300"
                          />
                          {option.label}
                        </label>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-2xl border border-sky-200 bg-sky-50/70 p-4">
                    <div className="space-y-1">
                      <h5 className="text-sm font-semibold text-slate-900">Close-loop live-reply actions</h5>
                      <p className="text-xs text-slate-600">
                        This is the booked-job side of autonomy. Keep it off until you trust the agent with real appointment timing and light reschedule-save conversations.
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
                            defaultChecked={selectedLiveReplyActions.has(option.value)}
                            className="mt-0.5 h-4 w-4 rounded border-slate-300"
                          />
                          <span className="space-y-1">
                            <span className="block text-sm font-semibold text-slate-900">{option.label}</span>
                            <span className="block text-xs text-slate-600">{option.detail}</span>
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
                  <h4 className="text-sm font-semibold text-slate-900">Facebook Sales Autopilot</h4>
                  <p className="text-xs text-slate-600">
                    Junk removal only. Auto-booking requires a shown price, an offered time, and a clear customer yes.
                  </p>
                </div>
                <span className="rounded-full border border-blue-200 bg-white px-3 py-1 text-[11px] font-semibold text-blue-800">
                  Ready {readinessPassed}/{readinessTotal}
                </span>
              </div>

              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                <label className="flex flex-col gap-1">
                  <span>Closer mode</span>
                  <select
                    name="facebookCloserMode"
                    defaultValue={autopilot.facebookCloser.mode}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  >
                    <option value="off">Off</option>
                    <option value="shadow">Shadow</option>
                    <option value="assist">Assist</option>
                    <option value="auto">Auto</option>
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  <span>Max auto-book price ($)</span>
                  <input
                    name="facebookCloserMaxAutoBookDollars"
                    type="number"
                    min={150}
                    max={5000}
                    defaultValue={centsToDollars(autopilot.facebookCloser.maxAutoBookTotalCents)}
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
                    defaultValue={centsToDollars(autopilot.facebookCloser.requirePhotosAboveCents)}
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
                    defaultValue={autopilot.facebookCloser.messengerResponseWindowHours}
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                  />
                </label>
                <div className="space-y-2 pt-5">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      name="facebookCloserAllowDmSmsFallback"
                      defaultChecked={autopilot.facebookCloser.allowDmSmsFallback}
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
                {(Object.entries(FACEBOOK_READINESS_LABELS) as Array<[keyof FacebookReadiness, string]>).map(([key, label]) => (
                  <div key={key} className="flex items-center justify-between rounded-xl border border-blue-100 bg-white/80 px-3 py-2">
                    <span>{label}</span>
                    <span className={facebookReadiness[key] ? "font-semibold text-emerald-700" : "font-semibold text-amber-700"}>
                      {facebookReadiness[key] ? "Ready" : "Check"}
                    </span>
                  </div>
                ))}
              </div>

              <div className="mt-4 rounded-2xl border border-blue-100 bg-white/90 p-4">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                  <div>
                    <h5 className="text-sm font-semibold text-slate-900">Owner Coaching</h5>
                    <p className="text-xs text-slate-600">
                      Approved guidance for tone and flow. Keyword guardrails immediately route risky conversations to review.
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
                      defaultChecked={autopilot.facebookCoaching.requirePhotosBeforeQuote}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300"
                    />
                    <span>
                      <span className="block font-semibold text-slate-800">Require photos before quote/time offers</span>
                      <span className="block text-slate-500">If no photos are present, the agent asks for photos instead of quoting or offering times.</span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2">
                    <input
                      type="checkbox"
                      name="facebookCoachingRequireHumanReviewBeforeBooking"
                      defaultChecked={autopilot.facebookCoaching.requireHumanReviewBeforeBooking}
                      className="mt-0.5 h-4 w-4 rounded border-slate-300"
                    />
                    <span>
                      <span className="block font-semibold text-slate-800">Human review before auto-booking</span>
                      <span className="block text-slate-500">The agent can still draft and offer times, but confirmed bookings wait for review.</span>
                    </span>
                  </label>
                </div>

                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <label className="flex flex-col gap-1">
                    <span>Always human-review keywords</span>
                    <input
                      name="facebookCoachingHumanReviewKeywords"
                      defaultValue={keywordList(autopilot.facebookCoaching.humanReviewKeywords)}
                      placeholder="hot tub, hazmat, complaint"
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span>Block auto-reply keywords</span>
                    <input
                      name="facebookCoachingBlockedAutoReplyKeywords"
                      defaultValue={keywordList(autopilot.facebookCoaching.blockedAutoReplyKeywords)}
                      placeholder="refund, lawsuit, angry"
                      className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                    />
                  </label>
                </div>
              </div>
            </div>

            <SubmitButton
              className="inline-flex items-center rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
              pendingLabel="Saving..."
            >
              Save autopilot settings
            </SubmitButton>
          </form>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <h3 className="text-base font-semibold text-slate-900">Mode guide</h3>
          <p className="text-xs text-slate-500">
            Use this to decide how much authority the system should have while you build trust.
          </p>
          <div className="mt-4 space-y-3 text-xs text-slate-600">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <span className="font-semibold text-slate-900">Off:</span> drafts, planning, and recommendations only. No automatic sending.
            </div>
            <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <span className="font-semibold text-slate-900">Partial:</span> the system can send approved follow-up types automatically, but new live replies still wait on you.
            </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3">
              <span className="font-semibold text-slate-900">Full:</span> the system is allowed to run live channel autopilot where supported and trusted, but live replies still stay approval-only until the live reply autonomy gate below is enabled.
          </div>
          </div>

          <div className="mt-6">
            <h4 className="text-sm font-semibold text-slate-900">Recent Facebook actions</h4>
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
                      href={action.threadId ? `/team?tab=inbox&threadId=${action.threadId}` : "/team?tab=inbox"}
                      className="block bg-white px-4 py-3 transition hover:bg-slate-50"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-slate-900">{action.proposedAction}</span>
                        <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-600">
                          {action.autonomyMode}
                        </span>
                      </div>
                      <div className="mt-1 text-slate-500">
                        {action.stage} · {action.executedAction ?? "not executed"}
                      </div>
                      <div className={action.error ? "mt-1 text-rose-600" : "mt-1 text-slate-500"}>
                        {action.error ?? action.humanReviewReason ?? action.decisionReason ?? "No reason saved"}
                      </div>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <h3 className="text-base font-semibold text-slate-900">
            Legacy channel autonomy <span className="text-xs font-medium text-slate-500">(older system)</span>
          </h3>
          <p className="text-xs text-slate-500">
            These older channel settings still exist behind the scenes. Keep them for compatibility while the newer Sales Autopilot modes take over.
          </p>
          <div className="mt-4 space-y-3">
            {channels.map((channel) => (
              <form key={channel.channel} action={updateAutomationModeAction} className="flex flex-wrap items-center gap-3 text-sm">
                <input type="hidden" name="channel" value={channel.channel} />
                <span className="w-20 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600">
                  {channel.channel}
                </span>
                <select
                  name="mode"
                  defaultValue={channel.mode}
                  className="rounded-full border border-slate-200 px-3 py-2 text-xs text-slate-700"
                >
                  <option value="draft">Draft</option>
                  <option value="assist">Assist</option>
                  <option value="auto">Auto</option>
                </select>
                <SubmitButton
                  className="rounded-full border border-slate-200 px-3 py-2 text-xs text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
                  pendingLabel="Saving..."
                >
                  Update
                </SubmitButton>
                <span className="text-[10px] text-slate-500">
                  {channel.updatedAt
                    ? new Date(channel.updatedAt).toLocaleString(undefined, { timeZone: TEAM_TIME_ZONE })
                    : "Just now"}
                </span>
              </form>
            ))}
          </div>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <h3 className="text-base font-semibold text-slate-900">Lead-level kill switches</h3>
          <p className="text-xs text-slate-500">
            Pause follow-ups, mark Do Not Contact, or force human takeover for a specific lead.
          </p>
          <form action={updateLeadAutomationAction} className="mt-4 space-y-3 text-xs text-slate-600">
            <label className="flex flex-col gap-1">
              <span>Lead ID</span>
              <input
                name="leadId"
                placeholder="Lead UUID"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span>Channel</span>
              <select
                name="channel"
                defaultValue="sms"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              >
                {channels.map((channel) => (
                  <option key={channel.channel} value={channel.channel}>
                    {channel.channel.toUpperCase()}
                  </option>
                ))}
              </select>
            </label>
            <div className="grid gap-2 sm:grid-cols-3">
              <label className="flex items-center gap-2">
                <input type="checkbox" name="paused" className="h-4 w-4 rounded border-slate-300" />
                Pause
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="dnc" className="h-4 w-4 rounded border-slate-300" />
                DNC
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" name="humanTakeover" className="h-4 w-4 rounded border-slate-300" />
                Human takeover
              </label>
            </div>
            <label className="flex flex-col gap-1">
              <span>Follow-up state</span>
              <input
                name="followupState"
                placeholder="qualifying | booked | review"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex flex-col gap-1">
                <span>Follow-up step</span>
                <input
                  name="followupStep"
                  type="number"
                  min={0}
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span>Next follow-up</span>
                <input
                  name="nextFollowupAt"
                  type="datetime-local"
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
              </label>
            </div>
            <SubmitButton
              className="inline-flex items-center rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
              pendingLabel="Saving..."
            >
              Save lead override
            </SubmitButton>
          </form>
        </div>
      </div>
    </section>
  );
}
