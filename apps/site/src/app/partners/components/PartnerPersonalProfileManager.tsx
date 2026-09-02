"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { LoaderCircle, Save, UserRound } from "lucide-react";
import { partnerPortalFetch } from "../lib/portal-v2";
import {
  PartnerNotice,
  PartnerPanel,
  partnerFieldClass,
  partnerPrimaryButtonClass,
} from "./PartnerPortalUi";

export type PartnerPersonalProfile = {
  displayName: string;
  updatedAt: string;
};

type PersonalProfileResponse = {
  ok: true;
  profile: PartnerPersonalProfile;
};

export function PartnerPersonalProfileManager({
  initialProfile,
  initialEtag,
}: {
  initialProfile: PartnerPersonalProfile | null;
  initialEtag: string | null;
}) {
  const router = useRouter();
  const [profile, setProfile] = React.useState(initialProfile);
  const [etag, setEtag] = React.useState(initialEtag);
  const [dirty, setDirty] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{
    tone: "success" | "error" | "warning";
    text: string;
  } | null>(null);

  React.useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (!dirty) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  async function refreshProfile(): Promise<void> {
    const result = await partnerPortalFetch<PersonalProfileResponse>(
      "personal-profile",
    ).catch(() => null);
    if (!result?.ok) return;
    setProfile(result.data.profile);
    setEtag(result.response.headers.get("etag"));
    setDirty(false);
  }

  async function save(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!etag || busy) return;
    const form = new FormData(event.currentTarget);
    const rawDisplayName = form.get("displayName");
    const displayName = (
      typeof rawDisplayName === "string" ? rawDisplayName : ""
    )
      .trim()
      .replace(/\s+/gu, " ");
    setBusy(true);
    setMessage(null);
    const result = await partnerPortalFetch<PersonalProfileResponse>(
      "personal-profile",
      {
        method: "PATCH",
        headers: { "If-Match": etag },
        body: JSON.stringify({ displayName }),
      },
    ).catch(() => null);
    setBusy(false);

    if (!result?.ok) {
      const changedElsewhere = result?.response.status === 412;
      setMessage({
        tone: changedElsewhere ? "warning" : "error",
        text: changedElsewhere
          ? "Your profile changed on another device. We refreshed it; review the latest name before saving again."
          : (result?.error.message ?? "We couldn’t save your display name."),
      });
      if (changedElsewhere) await refreshProfile();
      return;
    }

    setProfile(result.data.profile);
    setEtag(result.response.headers.get("etag"));
    setDirty(false);
    setMessage({ tone: "success", text: "Your display name was saved." });
    router.refresh();
  }

  if (!profile) {
    return (
      <PartnerPanel>
        <PartnerNotice tone="warning">
          Your personal profile is temporarily unavailable. No profile details
          were changed.
        </PartnerNotice>
      </PartnerPanel>
    );
  }

  return (
    <div data-partner-unsaved={dirty ? "true" : undefined}>
      <PartnerPanel>
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
            <UserRound className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              Personal profile
            </h2>
            <p
              id="partner-display-name-help"
              className="mt-1 max-w-2xl text-sm leading-6 text-slate-600"
            >
              This name identifies you in partner messages and activity. It
              follows your identity across every Stonegate partner account you
              can access; it does not change your sign-in email, permissions, or
              CRM contacts.
            </p>
          </div>
        </div>

        {message ? (
          <PartnerNotice tone={message.tone} className="mt-5">
            {message.text}
          </PartnerNotice>
        ) : null}

        <form
          key={`${profile.displayName}:${profile.updatedAt}`}
          className="mt-5 flex flex-col gap-4 sm:flex-row sm:items-end"
          onChange={() => setDirty(true)}
          onSubmit={(event) => void save(event)}
        >
          <label className="min-w-0 flex-1">
            <span className="text-sm font-semibold text-slate-700">
              Display name
            </span>
            <input
              name="displayName"
              type="text"
              autoComplete="name"
              required
              minLength={2}
              maxLength={120}
              defaultValue={profile.displayName}
              aria-describedby="partner-display-name-help"
              className={partnerFieldClass}
            />
          </label>
          <button
            type="submit"
            disabled={!dirty || busy || !etag}
            aria-busy={busy}
            className={partnerPrimaryButtonClass}
          >
            {busy ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <Save className="h-4 w-4" aria-hidden="true" />
            )}
            {busy ? "Saving…" : "Save display name"}
          </button>
        </form>
      </PartnerPanel>
    </div>
  );
}
