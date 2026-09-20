"use client";
import { useEffect, useRef, useState } from "react";
import {
  loadPartnerOwnerAlerts,
  savePartnerOwnerAlerts,
  testPartnerOwnerAlert,
  type PartnerOwnerAlertPayload,
} from "../actions/partner-owner-alerts";
import { TEAM_INPUT_COMPACT, teamButtonClass } from "./team-ui";
export function PartnerOwnerAlertSettings() {
  const [data, setData] = useState<PartnerOwnerAlertPayload | null>(null),
    [enabled, setEnabled] = useState(false),
    [ownerId, setOwnerId] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const saveAttempt = useRef<{ fingerprint: string; key: string } | null>(null),
    testAttempt = useRef<string | null>(null);
  async function load() {
    setBusy(true);
    const result = await loadPartnerOwnerAlerts().catch(() => ({
      ok: false as const,
      message: "Owner alerts are temporarily unavailable.",
    }));
    setBusy(false);
    if (result.ok) {
      setData(result.data);
      setEnabled(result.data.settings.enabled);
      setOwnerId(result.data.settings.ownerTeamMemberId ?? "");
      setMessage("");
      saveAttempt.current = null;
      testAttempt.current = null;
    } else setMessage(result.message);
  }
  useEffect(() => {
    void load();
  }, []);
  async function save() {
    if (!data || busy) return;
    const input = {
      enabled,
      ownerTeamMemberId: ownerId || null,
      revision: data.settings.revision,
    };
    const fingerprint = JSON.stringify(input);
    if (saveAttempt.current?.fingerprint !== fingerprint)
      saveAttempt.current = {
        fingerprint,
        key: `owner-alert-settings:${crypto.randomUUID()}`,
      };
    setBusy(true);
    const result = await savePartnerOwnerAlerts({
      ...input,
      key: saveAttempt.current.key,
    }).catch(() => ({
      ok: false as const,
      message: "The settings could not be confirmed. Retry this same update.",
    }));
    setBusy(false);
    if (result.ok) {
      setData(result.data);
      setMessage("Owner alert settings saved.");
      saveAttempt.current = null;
      testAttempt.current = null;
    } else setMessage(result.message);
  }
  async function test() {
    if (!data || busy) return;
    testAttempt.current ??= `owner-alert-test:${crypto.randomUUID()}`;
    setBusy(true);
    const result = await testPartnerOwnerAlert({
      revision: data.settings.revision,
      key: testAttempt.current,
    }).catch(() => ({
      ok: false,
      message: "The test result could not be confirmed. Retry the same test.",
    }));
    setBusy(false);
    setMessage(result.message);
    if (result.ok) testAttempt.current = null;
  }
  const selected = data?.owners.find((owner) => owner.id === ownerId);
  const dirty =
    !!data &&
    (enabled !== data.settings.enabled ||
      ownerId !== (data.settings.ownerTeamMemberId ?? ""));
  return (
    <section
      className="max-w-3xl space-y-4 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-5"
      aria-labelledby="partner-owner-alerts-heading"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="partner-owner-alerts-heading" className="text-lg font-semibold">
          Owner request alerts
        </h2>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            if (
              !dirty ||
              window.confirm("Discard your unsaved alert settings and reload?")
            )
              void load();
          }}
          className={teamButtonClass("secondary", "sm")}
        >
          Reload settings
        </button>
      </div>
      <p className="text-sm text-[color:var(--team-text-muted)]">
        Send the selected owner a text when new partner service requests arrive.
        Opening the review stops reminders; it does not confirm the service.
      </p>
      {message ? (
        <p
          role="status"
          className="rounded-lg border border-[color:var(--team-border)] p-3 text-sm"
        >
          {message}
        </p>
      ) : null}
      {!data ? (
        <p>{busy ? "Loading settings…" : "Settings unavailable."}</p>
      ) : (
        <>
          <p className="text-sm">
            Current recipient:{" "}
            <strong>{data.settings.ownerName ?? "No owner selected"}</strong>
            {data.settings.phoneLastFour
              ? ` · phone ending ${data.settings.phoneLastFour}`
              : ""}
            . Alerts are {data.settings.enabled ? "on" : "off"}.
          </p>
          {data.canManage ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
              className="space-y-4"
            >
              <fieldset disabled={busy} className="space-y-4">
                <div className="text-sm">
                  <label className="block" htmlFor="partner-alert-owner">
                    Owner
                  </label>
                  <select
                    id="partner-alert-owner"
                    value={ownerId}
                    onChange={(event) => setOwnerId(event.target.value)}
                    className={`${TEAM_INPUT_COMPACT} mt-1`}
                    required={enabled}
                  >
                    <option value="">Choose an owner</option>
                    {data.owners.map((owner) => (
                      <option key={owner.id} value={owner.id}>
                        {owner.name}
                        {owner.phoneLastFour
                          ? ` · phone ending ${owner.phoneLastFour}`
                          : " · no phone configured"}
                      </option>
                    ))}
                  </select>
                </div>
                <label className="flex min-h-11 items-center gap-3 text-sm">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) => setEnabled(event.target.checked)}
                    className="h-5 w-5 accent-teal-700"
                  />
                  Send owner request alerts
                </label>
                {enabled && !selected?.ready ? (
                  <p className="text-sm text-amber-900">
                    This owner is not ready to receive alerts. Check the owner’s
                    phone and messaging settings.
                  </p>
                ) : null}
                <div className="flex flex-wrap gap-3">
                  <button
                    type="submit"
                    disabled={busy || !dirty || (enabled && !selected?.ready)}
                    className={teamButtonClass("primary")}
                  >
                    {busy ? "Working…" : "Save alert settings"}
                  </button>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      dirty ||
                      !data.settings.ready ||
                      !data.settings.ownerTeamMemberId
                    }
                    onClick={() => void test()}
                    className={teamButtonClass("secondary")}
                  >
                    Send test text
                  </button>
                </div>
              </fieldset>
            </form>
          ) : (
            <p className="text-sm">Only an owner can change these settings.</p>
          )}
          {data.deliveryProblems.length ? (
            <details className="border-t border-[color:var(--team-border)] pt-3">
              <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold">
                Delivery needs attention ({data.deliveryProblems.length})
              </summary>
              <ul className="space-y-2 text-sm">
                {data.deliveryProblems.map((problem) => (
                  <li key={problem.id} className="break-words">
                    {problem.kind.replaceAll("_", " ")} ·{" "}
                    {problem.state.replaceAll("_", " ")}
                    {problem.detail
                      ? ` · ${problem.detail.replaceAll("_", " ")}`
                      : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      )}
    </section>
  );
}
