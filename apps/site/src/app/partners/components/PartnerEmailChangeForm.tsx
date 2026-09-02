"use client";

import * as React from "react";
import { LoaderCircle, MailCheck } from "lucide-react";
import { createPortalOperationKey, partnerPortalFetch } from "../lib/portal-v2";
import {
  PartnerNotice,
  PartnerPanel,
  partnerFieldClass,
  partnerPrimaryButtonClass,
} from "./PartnerPortalUi";

export function PartnerEmailChangeForm({
  currentEmail,
  passwordSet,
  mfaRequired,
}: {
  currentEmail: string;
  passwordSet: boolean;
  mfaRequired: boolean;
}) {
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<{
    tone: "success" | "error" | "warning";
    text: string;
  } | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!formElement.reportValidity()) return;
    const form = new FormData(formElement);
    const newEmailRaw = form.get("newEmail");
    const currentPasswordRaw = form.get("currentPassword");
    const newEmail =
      typeof newEmailRaw === "string" ? newEmailRaw.trim() : "";
    const currentPassword =
      typeof currentPasswordRaw === "string" ? currentPasswordRaw : "";
    setBusy(true);
    setMessage(null);
    const result = await partnerPortalFetch<{ ok: true; message: string }>(
      "security/email-change/request",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": createPortalOperationKey("email-change"),
        },
        body: JSON.stringify({
          newEmail,
          ...(currentPassword ? { currentPassword } : {}),
        }),
      },
    ).catch(() => null);
    setBusy(false);
    if (!result?.ok) {
      const currentPasswordError =
        result?.error.fieldErrors?.["currentPassword"];
      setMessage({
        tone:
          result?.error.error === "mfa_step_up_required" ? "warning" : "error",
        text:
          currentPasswordError ??
          (result?.error.error === "mfa_step_up_required"
            ? mfaRequired
              ? "Verify this session in Two-step verification below, then submit the email change again."
              : "Sign in again, then submit the email change."
            : (result?.error.message ??
              "We couldn’t request that email change.")),
      });
      return;
    }
    formElement.reset();
    setMessage({
      tone: "success",
      text: "Check the new address for a confirmation link. For security, the same response is shown when an address cannot be used.",
    });
  }

  return (
    <PartnerPanel id="sign-in-email" className="scroll-mt-24">
      <div className="flex items-start gap-3">
        <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
          <MailCheck className="h-5 w-5" aria-hidden="true" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-slate-950">
            Change sign-in email
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
            Current email: <span className="font-semibold">{currentEmail}</span>
            . We’ll verify the new mailbox before changing your identity. The
            confirmation signs out every portal session and never signs you in
            automatically.
          </p>
        </div>
      </div>
      {message ? (
        <PartnerNotice tone={message.tone} className="mt-5">
          {message.text}
        </PartnerNotice>
      ) : null}
      <form
        onSubmit={(event) => void submit(event)}
        className="mt-5 grid gap-4 sm:grid-cols-2"
      >
        <label>
          <span className="text-sm font-semibold text-slate-700">
            New sign-in email
          </span>
          <input
            name="newEmail"
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            className={partnerFieldClass}
          />
        </label>
        {passwordSet ? (
          <label>
            <span className="text-sm font-semibold text-slate-700">
              Current password{" "}
              <span className="font-normal">(if requested)</span>
            </span>
            <input
              name="currentPassword"
              type="password"
              minLength={1}
              maxLength={128}
              autoComplete="current-password"
              className={partnerFieldClass}
            />
          </label>
        ) : null}
        <div className="sm:col-span-2">
          <button
            type="submit"
            disabled={busy}
            aria-busy={busy}
            className={partnerPrimaryButtonClass}
          >
            {busy ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <MailCheck className="h-4 w-4" aria-hidden="true" />
            )}
            {busy ? "Requesting…" : "Verify a new email"}
          </button>
        </div>
      </form>
    </PartnerPanel>
  );
}
