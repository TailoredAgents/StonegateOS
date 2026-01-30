"use client";

import React, { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { SubmitButton } from "@/components/SubmitButton";
import { TEAM_INPUT_COMPACT, teamButtonClass } from "./team-ui";

export function ContactPhoneEditorClient({
  contactId,
  phone,
  email
}: {
  contactId: string;
  phone: string | null;
  email: string | null;
}) {
  const router = useRouter();
  const initialPhone = useMemo(() => phone ?? "", [phone]);
  const initialEmail = useMemo(() => email ?? "", [email]);
  const [open, setOpen] = useState(false);
  const [draftPhone, setDraftPhone] = useState(initialPhone);
  const [draftEmail, setDraftEmail] = useState(initialEmail);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);

    try {
      const phoneTrimmed = draftPhone.trim();
      const emailTrimmed = draftEmail.trim();

      const response = await fetch("/api/team/contacts/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          contactId,
          phone: phoneTrimmed.length ? phoneTrimmed : null,
          email: emailTrimmed.length ? emailTrimmed : null
        })
      });

      if (!response.ok) {
        const data = (await response.json().catch(() => null)) as { message?: string } | null;
        const message =
          typeof data?.message === "string" && data.message.trim().length > 0 ? data.message : "Unable to update contact";
        setError(message);
        return;
      }

      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to update contact");
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
          setDraftPhone(initialPhone);
          setDraftEmail(initialEmail);
          setOpen((prev) => !prev);
        }}
        className="cursor-pointer rounded-full border border-slate-200 px-3 py-1 text-[11px] font-semibold text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
      >
        Edit contact
      </button>
      {open ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-40 cursor-default bg-black/20 sm:hidden"
            aria-label="Close contact editor"
            onClick={() => setOpen(false)}
          />
          <div className="fixed inset-x-4 top-24 z-50 mt-0 w-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-xl sm:absolute sm:left-0 sm:top-auto sm:inset-x-auto sm:z-20 sm:mt-10 sm:w-96">
            <form onSubmit={onSubmit} className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <label className="text-xs font-semibold text-slate-600 sm:col-span-1">
                  Phone
                  <input
                    value={draftPhone}
                    onChange={(e) => setDraftPhone(e.target.value)}
                    className={`mt-1 w-full ${TEAM_INPUT_COMPACT}`}
                    placeholder="e.g. 6785551234"
                    autoComplete="tel"
                    inputMode="tel"
                  />
                </label>
                <label className="text-xs font-semibold text-slate-600 sm:col-span-1">
                  Email
                  <input
                    value={draftEmail}
                    onChange={(e) => setDraftEmail(e.target.value)}
                    className={`mt-1 w-full ${TEAM_INPUT_COMPACT}`}
                    placeholder="optional"
                    autoComplete="email"
                    inputMode="email"
                  />
                </label>
              </div>
              {error ? <p className="text-xs text-rose-600">{error}</p> : null}
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setOpen(false)} className={teamButtonClass("secondary", "sm")}>
                  Cancel
                </button>
                <SubmitButton className={teamButtonClass("primary", "sm")} pendingLabel="Saving..." disabled={saving}>
                  Save
                </SubmitButton>
              </div>
              <p className="text-[11px] text-slate-500">Use a real mobile number. Invalid numbers will fail SMS and calls.</p>
            </form>
          </div>
        </>
      ) : null}
    </div>
  );
}

