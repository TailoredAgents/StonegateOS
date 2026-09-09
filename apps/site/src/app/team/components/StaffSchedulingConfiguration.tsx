"use client";
import { useEffect, useRef, useState } from "react";
import { formEntryText } from "@/lib/form-entry-text";
import type { StaffSchedulingConfigurationData as Configuration } from "../lib/staff-scheduling-contract";
import {
  loadStaffSchedulingConfiguration,
  saveStaffSchedulingConfiguration,
} from "../actions/scheduling-resources";
const FIELD =
  "mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base";
const BUTTON =
  "inline-flex min-h-11 items-center justify-center rounded-lg bg-primary-900 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50";
function value(form: FormData, name: string) {
  return formEntryText(form.get(name)).trim();
}
function keys(form: FormData, name: string) {
  return value(form, name)
    .split(/[\s,]+/u)
    .filter(Boolean);
}
function Impact() {
  return (
    <>
      <label className="block text-sm font-semibold">
        Reason
        <textarea
          name="reason"
          required
          minLength={12}
          maxLength={1000}
          className={FIELD}
        />
      </label>
      <label className="flex min-h-11 items-start gap-2 text-sm">
        <input
          type="checkbox"
          name="acknowledgeImpact"
          required
          className="mt-1 h-5 w-5"
        />
        <span>
          I will review existing jobs and holds affected by this change. Saved
          jobs are not automatically moved or canceled.
        </span>
      </label>
    </>
  );
}
export function StaffSchedulingConfiguration({
  canEdit,
}: {
  canEdit: boolean;
}) {
  const [config, setConfig] = useState<Configuration | null>(null),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false),
    [selectedId, setSelectedId] = useState("");
  const pending = useRef<{ fingerprint: string; key: string } | null>(null);
  async function refresh() {
    setBusy(true);
    const result = await loadStaffSchedulingConfiguration();
    setBusy(false);
    if (!result.ok) setMessage(result.message);
    else setConfig(result.data);
  }
  useEffect(() => {
    void refresh();
  }, []);
  async function save(
    form: HTMLFormElement,
    operation: "resource" | "requirement" | "remove_requirement",
  ) {
    if (!config || busy || !form.reportValidity()) return;
    const fields = new FormData(form),
      common = {
        operation,
        reason: value(fields, "reason"),
        acknowledgeImpact: fields.get("acknowledgeImpact") === "on",
      };
    const payload =
      operation === "resource"
        ? {
            ...common,
            ...(selectedId ? { id: selectedId } : {}),
            capacityPoolKey: value(fields, "capacityPoolKey"),
            kind: value(fields, "kind"),
            label: value(fields, "label"),
            capacityUnits: Number(value(fields, "capacityUnits")),
            skillKeys: keys(fields, "skillKeys"),
            active: fields.get("active") === "on",
          }
        : operation === "remove_requirement"
          ? {
              ...common,
              profileId: value(fields, "profileId"),
              resourceKind: value(fields, "resourceKind"),
            }
          : {
              ...common,
              profileId: value(fields, "profileId"),
              resourceKind: value(fields, "resourceKind"),
              quantity: Number(value(fields, "quantity")),
              capacityUnits: Number(value(fields, "capacityUnits")),
              requiredSkillKeys: keys(fields, "requiredSkillKeys"),
            };
    const fingerprint = JSON.stringify({ version: config.version, payload });
    if (pending.current?.fingerprint !== fingerprint)
      pending.current = {
        fingerprint,
        key: `resource-config:${crypto.randomUUID()}`,
      };
    setBusy(true);
    const result = await saveStaffSchedulingConfiguration({
      version: config.version,
      key: pending.current.key,
      payload,
    });
    setBusy(false);
    setMessage(result.message);
    if (result.ok) {
      pending.current = null;
      await refresh();
    }
  }
  const selected = config?.resources.find(
    (resource) => resource.id === selectedId,
  );
  return (
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Scheduling resources</h1>
        <button
          type="button"
          disabled={busy}
          className={BUTTON}
          onClick={() => void refresh()}
        >
          Refresh
        </button>
      </div>
      <p className="max-w-3xl text-sm leading-6 text-slate-600">
        Define real crews, trucks, and equipment, then specify what each service
        needs. These are operational resources, not payroll or commission
        settings. Adding named resources replaces the matching pooled
        placeholder for new reservations. Existing pooled assignments must be
        reconciled before their resources are considered free.
      </p>
      {message ? (
        <p
          role="status"
          className="rounded-lg border border-slate-200 bg-white p-3"
        >
          {message}
        </p>
      ) : null}
      {!config ? (
        <p role="status">
          {busy ? "Loading…" : "Configuration is unavailable."}
        </p>
      ) : (
        <>
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <caption className="p-3 text-left font-semibold">
                Configured resources
              </caption>
              <thead>
                <tr>
                  {["Resource", "Kind", "Pool", "Capacity", "Status"].map(
                    (label) => (
                      <th key={label} className="px-3 py-2">
                        {label}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {config.resources.map((resource) => (
                  <tr key={resource.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">
                      {resource.label}
                      {resource.source === "compatibility_pool"
                        ? " (pooled placeholder)"
                        : ""}
                    </td>
                    <td className="px-3 py-2">{resource.kind}</td>
                    <td className="px-3 py-2">{resource.capacityPoolKey}</td>
                    <td className="px-3 py-2">{resource.capacityUnits}</td>
                    <td className="px-3 py-2">
                      {resource.active ? "Active" : "Inactive"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {canEdit ? (
            <div className="grid gap-6 lg:grid-cols-2">
              <form
                method="post"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(event.currentTarget, "resource");
                }}
                className="space-y-3 rounded-xl border border-slate-200 bg-white p-5"
              >
                <h2 className="text-lg font-semibold">
                  Create or edit a resource
                </h2>
                <label className="block text-sm font-semibold">
                  Resource
                  <select
                    value={selectedId}
                    onChange={(event) => setSelectedId(event.target.value)}
                    className={FIELD}
                  >
                    <option value="">Create a new resource</option>
                    {config.resources
                      .filter((resource) => resource.source === "staff")
                      .map((resource) => (
                        <option key={resource.id} value={resource.id}>
                          {resource.label}
                        </option>
                      ))}
                  </select>
                </label>
                <fieldset
                  key={selectedId}
                  disabled={busy}
                  className="space-y-3"
                >
                  <label className="block text-sm font-semibold">
                    Name
                    <input
                      name="label"
                      required
                      maxLength={160}
                      defaultValue={selected?.label}
                      className={FIELD}
                    />
                  </label>
                  <label className="block text-sm font-semibold">
                    Kind
                    <select
                      name="kind"
                      defaultValue={selected?.kind ?? "crew"}
                      className={FIELD}
                    >
                      {["crew", "truck", "equipment"].map((kind) => (
                        <option key={kind}>{kind}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm font-semibold">
                    Capacity pool
                    <select
                      name="capacityPoolKey"
                      defaultValue={selected?.capacityPoolKey}
                      className={FIELD}
                    >
                      {config.pools
                        .filter((pool) => pool.active)
                        .map((pool) => (
                          <option key={pool.key} value={pool.key}>
                            {pool.key} · {pool.capacityUnits} units
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="block text-sm font-semibold">
                    Capacity units
                    <input
                      name="capacityUnits"
                      type="number"
                      required
                      min={1}
                      max={10000}
                      defaultValue={selected?.capacityUnits ?? 1}
                      className={FIELD}
                    />
                  </label>
                  <label className="block text-sm font-semibold">
                    Skills (comma separated)
                    <input
                      name="skillKeys"
                      defaultValue={selected?.skillKeys.join(", ")}
                      placeholder="heavy_lift, demolition"
                      className={FIELD}
                    />
                    <span className="font-normal text-slate-600">
                      Use lowercase letters, numbers, underscores or hyphens.
                    </span>
                  </label>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      name="active"
                      defaultChecked={selected?.active ?? true}
                      className="h-5 w-5"
                    />
                    Active for new reservations
                  </label>
                  <Impact />
                  <button className={BUTTON} disabled={busy}>
                    Save resource
                  </button>
                </fieldset>
              </form>
              <form
                method="post"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save(event.currentTarget, "requirement");
                }}
                className="space-y-3 rounded-xl border border-slate-200 bg-white p-5"
              >
                <h2 className="text-lg font-semibold">
                  Service resource requirements
                </h2>
                <p className="text-sm text-slate-600">
                  Saving replaces this resource kind’s requirement on the
                  selected profile. Other kinds remain unchanged.
                </p>
                <fieldset disabled={busy} className="space-y-3">
                  <label className="block text-sm font-semibold">
                    Service profile
                    <select name="profileId" required className={FIELD}>
                      {config.profiles
                        .filter((profile) => profile.active)
                        .map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.serviceKey} v{profile.version} ·{" "}
                            {profile.capacityPoolKey}
                          </option>
                        ))}
                    </select>
                  </label>
                  <label className="block text-sm font-semibold">
                    Resource kind
                    <select name="resourceKind" className={FIELD}>
                      {["crew", "truck", "equipment"].map((kind) => (
                        <option key={kind}>{kind}</option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm font-semibold">
                    Number of resources
                    <input
                      type="number"
                      name="quantity"
                      min={1}
                      max={20}
                      required
                      defaultValue={1}
                      className={FIELD}
                    />
                  </label>
                  <label className="block text-sm font-semibold">
                    Units per resource
                    <input
                      type="number"
                      name="capacityUnits"
                      min={1}
                      max={100}
                      required
                      defaultValue={1}
                      className={FIELD}
                    />
                  </label>
                  <label className="block text-sm font-semibold">
                    Required skills
                    <input
                      name="requiredSkillKeys"
                      placeholder="heavy_lift"
                      className={FIELD}
                    />
                  </label>
                  <Impact />
                  <button
                    className={BUTTON}
                    disabled={
                      busy || !config.profiles.some((profile) => profile.active)
                    }
                  >
                    Save service requirement
                  </button>
                  <button
                    type="button"
                    className="inline-flex min-h-11 items-center px-3 font-semibold text-rose-800 underline"
                    disabled={busy}
                    onClick={(event) =>
                      void save(event.currentTarget.form!, "remove_requirement")
                    }
                  >
                    Remove this kind’s requirement
                  </button>
                </fieldset>
              </form>
            </div>
          ) : (
            <p className="text-sm">
              Your role can view resource configuration but cannot change it.
            </p>
          )}
          <section className="rounded-xl border border-slate-200 bg-white p-5">
            <h2 className="text-lg font-semibold">
              Current service requirements
            </h2>
            <ul className="mt-3 divide-y divide-slate-200">
              {config.requirements.map((requirement) => (
                <li key={requirement.id} className="py-3 text-sm">
                  {config.profiles.find(
                    (profile) => profile.id === requirement.schedulingProfileId,
                  )?.serviceKey ?? "Service"}{" "}
                  · {requirement.quantity} {requirement.resourceKind} ·{" "}
                  {requirement.capacityUnits} units each
                  {requirement.requiredSkillKeys.length
                    ? ` · ${requirement.requiredSkillKeys.join(", ")}`
                    : ""}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </section>
  );
}
