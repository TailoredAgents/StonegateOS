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
  agentDisplayName: string;
  plannerAutoSendEnabled: boolean;
  plannerAutoSendMinDraftAgeMinutes: number;
  plannerAutoSendChannels: string[];
  plannerAutoSendActions: string[];
};

const SALES_AGENT_AUTOSEND_CHANNELS = [
  { value: "sms", label: "SMS" },
  { value: "dm", label: "Messenger DM" },
  { value: "email", label: "Email" },
] as const;

const SALES_AGENT_AUTOSEND_ACTIONS = [
  { value: "missed_call_recovery", label: "Missed call recovery" },
  { value: "follow_up_quote", label: "Quote follow up" },
  { value: "collect_missing_info", label: "Collect missing info" },
  { value: "handle_price_objection", label: "Price objection save (Full only)" },
  { value: "reply_now", label: "Immediate reply (Full only)" },
] as const;

const AUTOPILOT_MODE_OPTIONS = [
  { value: "off", label: "Off" },
  { value: "partial", label: "Partial" },
  { value: "full", label: "Full" },
] as const;

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
  const autopilotPayload = (await autopilotResponse.json()) as { policy?: SalesAutopilotPolicy };
  const autopilot = autopilotPayload.policy;
  if (!autopilot) {
    throw new Error("Missing Sales Autopilot policy");
  }

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

            <div className="grid gap-3 sm:grid-cols-2">
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
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50/80 p-4">
              <div className="space-y-1">
                <h4 className="text-sm font-semibold text-slate-900">Planner follow-up auto-send</h4>
                <p className="text-xs text-slate-500">
                  Controls the newer Sales HQ and Inbox planner drafts. This matters in Partial and Full modes. Off mode still drafts, but nothing sends automatically. Actions marked Full only will not autosend in Partial mode even if they are checked here.
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
              <span className="font-semibold text-slate-900">Full:</span> the system is allowed to run live channel autopilot where supported and trusted.
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
