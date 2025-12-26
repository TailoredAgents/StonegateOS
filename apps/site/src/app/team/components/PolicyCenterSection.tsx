import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { callAdminApi } from "../lib/api";
import { updatePolicyAction } from "../actions";

type PolicySetting = {
  key: string;
  value: Record<string, unknown>;
  updatedAt: string | null;
};

const POLICY_LABELS: Record<string, { title: string; description: string }> = {
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
  booking_rules: {
    title: "Booking rules",
    description: "Default booking windows, buffers, and capacity caps."
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

export async function PolicyCenterSection(): Promise<React.ReactElement> {
  const response = await callAdminApi("/api/admin/policy");
  if (!response.ok) {
    throw new Error("Failed to load policy settings");
  }

  const payload = (await response.json()) as { settings?: PolicySetting[] };
  const settings = payload.settings ?? [];

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <h2 className="text-xl font-semibold text-slate-900">Policy Center</h2>
        <p className="mt-1 text-sm text-slate-600">
          Update business rules and templates without code changes. Changes are logged automatically.
        </p>
      </header>

      <div className="space-y-4">
        {settings.map((setting) => {
          const label = POLICY_LABELS[setting.key] ?? {
            title: setting.key,
            description: "Policy configuration"
          };
          return (
            <div
              key={setting.key}
              className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur"
            >
              <div className="flex flex-col gap-1">
                <h3 className="text-base font-semibold text-slate-900">{label.title}</h3>
                <p className="text-xs text-slate-500">{label.description}</p>
              </div>
              <form action={updatePolicyAction} className="mt-4 space-y-3">
                <input type="hidden" name="key" value={setting.key} />
                <textarea
                  name="value"
                  rows={6}
                  defaultValue={JSON.stringify(setting.value ?? {}, null, 2)}
                  className="w-full rounded-2xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                />
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span>
                    Last updated {setting.updatedAt ? new Date(setting.updatedAt).toLocaleString() : "just now"}
                  </span>
                  <SubmitButton
                    className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
                    pendingLabel="Saving..."
                  >
                    Save policy
                  </SubmitButton>
                </div>
              </form>
            </div>
          );
        })}
      </div>
    </section>
  );
}
