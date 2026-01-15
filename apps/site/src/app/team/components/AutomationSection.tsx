import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import { updateAutomationModeAction, updateLeadAutomationAction, updateSalesAutopilotPolicyAction } from "../actions";

type AutomationChannel = {
  channel: string;
  mode: string;
  updatedAt: string | null;
};

type SalesAutopilotPolicy = {
  enabled: boolean;
  autoSendAfterMinutes: number;
  activityWindowMinutes: number;
  retryDelayMinutes: number;
  dmSmsFallbackAfterMinutes: number;
  dmMinSilenceBeforeSmsMinutes: number;
  agentDisplayName: string;
};

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

  const legacyDisabled = autopilot.enabled;

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <h2 className="text-xl font-semibold text-slate-900">Messaging Automation</h2>
        <p className="mt-1 text-sm text-slate-600">
          Sales Autopilot controls Inbox drafting and optional auto-send. Legacy modes only apply when Autopilot is off.
        </p>
        <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs text-slate-700">
          <span className="font-semibold">Sales Autopilot:</span>{" "}
          <span className={autopilot.enabled ? "text-emerald-700" : "text-slate-700"}>
            {autopilot.enabled ? "ON (legacy modes disabled)" : "OFF (legacy modes active)"}
          </span>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <h3 className="text-base font-semibold text-slate-900">Sales Autopilot</h3>
          <p className="text-xs text-slate-500">
            Drafts replies immediately. Auto-sends after inactivity based on these settings. Messenger is draft-first and only auto-sends after a second real message.
          </p>
          <form action={updateSalesAutopilotPolicyAction} className="mt-4 space-y-4 text-xs text-slate-600">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="autopilot_enabled"
                defaultChecked={autopilot.enabled}
                className="h-4 w-4 rounded border-slate-300"
              />
              Enabled
            </label>

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
                <span>DM → SMS fallback after (minutes)</span>
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

            <SubmitButton
              className="inline-flex items-center rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
              pendingLabel="Saving..."
            >
              Save autopilot settings
            </SubmitButton>
          </form>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <h3 className="text-base font-semibold text-slate-900">
            Channel autonomy <span className="text-xs font-medium text-slate-500">(legacy)</span>
          </h3>
          <p className="text-xs text-slate-500">
            Draft = AI writes but waits. Assist = auto replies, human books. Auto = full automation.
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
                  disabled={legacyDisabled}
                  className="rounded-full border border-slate-200 px-3 py-2 text-xs text-slate-700"
                >
                  <option value="draft">Draft</option>
                  <option value="assist">Assist</option>
                  <option value="auto">Auto</option>
                </select>
                <SubmitButton
                  disabled={legacyDisabled}
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
          {legacyDisabled ? (
            <p className="mt-4 text-xs text-slate-500">
              Legacy modes are disabled because Sales Autopilot is enabled.
            </p>
          ) : null}
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
