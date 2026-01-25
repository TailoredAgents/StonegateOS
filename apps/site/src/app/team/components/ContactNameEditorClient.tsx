"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { SubmitButton } from "@/components/SubmitButton";
import { TEAM_INPUT_COMPACT, teamButtonClass } from "./team-ui";

type InitialName = { firstName: string; lastName: string };

function splitName(fullName: string): InitialName {
  const normalized = fullName.trim().replace(/\s+/g, " ");
  if (!normalized) return { firstName: "", lastName: "" };
  const parts = normalized.split(" ");
  if (parts.length === 1) return { firstName: parts[0] ?? "", lastName: "" };
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

export function ContactNameEditorClient({
  contactId,
  contactName
}: {
  contactId: string;
  contactName: string;
}) {
  const router = useRouter();
  const initial = useMemo(() => splitName(contactName), [contactName]);
  const [open, setOpen] = useState(false);
  const [firstName, setFirstName] = useState(initial.firstName);
  const [lastName, setLastName] = useState(initial.lastName);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);

    try {
      const response = await fetch("/api/team/contacts/name", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          contactId,
          firstName: firstName.trim(),
          lastName: lastName.trim()
        })
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        const message =
          typeof data?.message === "string" && data.message.trim().length > 0
            ? data.message
            : "Unable to update contact name";
        setError(message);
        return;
      }

      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to update contact name");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="relative inline-flex">
      <button
        type="button"
        onClick={() => {
          setError(null);
          setFirstName(initial.firstName);
          setLastName(initial.lastName);
          setOpen((prev) => !prev);
        }}
        className="cursor-pointer rounded-full border border-slate-200 px-3 py-1 text-[11px] font-semibold text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
      >
        Edit name
      </button>
      {open ? (
        <div className="absolute left-0 z-20 mt-10 w-80 rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
          <form onSubmit={onSubmit} className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="text-xs font-semibold text-slate-600">
                First
                <input
                  value={firstName}
                  onChange={(e) => setFirstName(e.target.value)}
                  className={`mt-1 w-full ${TEAM_INPUT_COMPACT}`}
                  required
                />
              </label>
              <label className="text-xs font-semibold text-slate-600">
                Last
                <input
                  value={lastName}
                  onChange={(e) => setLastName(e.target.value)}
                  className={`mt-1 w-full ${TEAM_INPUT_COMPACT}`}
                />
              </label>
            </div>
            {error ? <p className="text-xs text-rose-600">{error}</p> : null}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setOpen(false)}
                className={teamButtonClass("secondary", "sm")}
              >
                Cancel
              </button>
              <SubmitButton
                className={teamButtonClass("primary", "sm")}
                pendingLabel="Saving..."
                disabled={saving}
              >
                Save
              </SubmitButton>
            </div>
            <p className="text-[11px] text-slate-500">
              Updates the contact name everywhere (Inbox, Contacts, Sales HQ).
            </p>
          </form>
        </div>
      ) : null}
    </div>
  );
}

