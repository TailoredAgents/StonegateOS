"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { partnerOnboardingFetch } from "../lib/onboarding";
import { PartnerAccessHelp } from "./PartnerAccessHelp";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

export function PartnerCredentialSetupForm({
  mode,
  hasToken,
  operationKey,
  initialError = null,
  initialDetail = null,
}: {
  mode: "activation" | "reset";
  hasToken: boolean;
  operationKey: string;
  initialError?: string | null;
  initialDetail?: {
    accountName?: string;
    email?: string;
    name?: string;
    passwordAlreadySet?: boolean;
  } | null;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [tokenValid, setTokenValid] = React.useState(hasToken);
  const [error, setError] = React.useState(initialError);
  const [showPasswords, setShowPasswords] = React.useState(false);
  const errorRef = React.useRef<HTMLDivElement>(null);
  const existingPassword =
    mode === "activation" && initialDetail?.passwordAlreadySet === true;
  React.useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending || !event.currentTarget.reportValidity()) return;
    const values = new FormData(event.currentTarget);
    const submittedPassword = values.get("password");
    const password = typeof submittedPassword === "string" ? submittedPassword : "";
    const submittedConfirmation = values.get("confirmPassword");
    const confirmPassword =
      mode === "activation"
        ? password
        : typeof submittedConfirmation === "string" ? submittedConfirmation : "";
    if (password !== confirmPassword) {
      setError("The passwords do not match.");
      return;
    }
    setPending(true);
    setError(null);
    const result = await partnerOnboardingFetch<{ ok: true }>(
      mode === "activation"
        ? "activation/complete"
        : "password-recovery/complete",
      {
        method: "POST",
        headers: { "Idempotency-Key": `partner-public-form:${operationKey}` },
        body: JSON.stringify(
          mode === "activation"
            ? {
                password,
                confirmPassword,
                rememberMe: values.get("rememberMe") === "on",
              }
            : { newPassword: password, confirmPassword },
        ),
      },
    ).catch(() => null);
    setPending(false);
    if (!result?.ok) {
      if (result?.response.status === 401 || result?.response.status === 410)
        setTokenValid(false);
      setError(
        result?.response.status === 429
          ? "Too many attempts. Wait a few minutes, then try again."
          : (result?.error.message ??
              "We couldn’t save your password. Try again or contact Stonegate."),
      );
      return;
    }
    router.replace(
      mode === "activation" ? "/partners/overview" : "/partners/login?reset=1",
    );
    router.refresh();
  }

  return (
    <section className="mx-auto max-w-md">
      <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
        {mode === "reset"
          ? "Choose a new password"
          : existingPassword
            ? "Confirm your partner access"
            : "Finish setting up your access"}
      </h1>
      <p className="mt-3 text-base leading-7 text-slate-600">
        {existingPassword
          ? "Enter your current password to add this company. Your password will not change."
          : mode === "activation"
            ? "Create a password, then you can request service and check your jobs."
            : "Set a new password, then sign in again. Other sessions will be signed out."}
      </p>
      {initialDetail?.accountName ? (
        <p className="mt-4 text-sm text-slate-700">
          {initialDetail.accountName}
          <br />
          <span className="break-all">{initialDetail.email}</span>
        </p>
      ) : null}
      {error ? (
        <div
          ref={errorRef}
          tabIndex={-1}
          className="mt-5 rounded-xl focus-visible:outline-2 focus-visible:outline-offset-2"
        >
          <PartnerNotice tone="error">
            <span id="credential-error">{error}</span>
          </PartnerNotice>
        </div>
      ) : null}
      {tokenValid ? (
        <form
          method="post"
          action="/partners/form"
          onSubmit={(event) => void submit(event)}
          className="mt-6 space-y-4"
          data-partner-analytics={
            mode === "activation" ? "account_activation" : "password_reset"
          }
        >
          <input type="hidden" name="operation" value={mode} />
          <input type="hidden" name="operationKey" value={operationKey} />
          <label className="block" htmlFor={`${mode}-password`}>
            <span className="text-sm font-semibold text-slate-700">
              {existingPassword ? "Current password" : "New password"}
            </span>
            <input
              id={`${mode}-password`}
              name="password"
              type={showPasswords ? "text" : "password"}
              required
              minLength={existingPassword ? 1 : 15}
              maxLength={128}
              autoComplete={
                existingPassword ? "current-password" : "new-password"
              }
              aria-describedby={
                error ? "credential-error credential-help" : "credential-help"
              }
              className={partnerFieldClass}
            />
          </label>
          <p id="credential-help" className="text-sm text-slate-600">
            {existingPassword
              ? "Use your existing Partner Portal password."
              : "Use a unique passphrase of 15–128 characters. Password managers are welcome."}
          </p>
          {mode === "reset" ? (
            <label className="block" htmlFor="reset-confirm-password">
              <span className="text-sm font-semibold text-slate-700">
                Confirm new password
              </span>
              <input
                id="reset-confirm-password"
                name="confirmPassword"
                type={showPasswords ? "text" : "password"}
                required
                minLength={15}
                maxLength={128}
                autoComplete="new-password"
                aria-describedby={error ? "credential-error" : undefined}
                className={partnerFieldClass}
              />
            </label>
          ) : null}
          <label className="flex min-h-11 items-center gap-3 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={showPasswords}
              onChange={(event) => setShowPasswords(event.target.checked)}
              className="h-5 w-5"
            />
            Show password{mode === "reset" ? "s" : ""}
          </label>
          {mode === "activation" ? (
            <label className="flex min-h-11 items-center gap-3 text-sm text-slate-700">
              <input name="rememberMe" type="checkbox" className="h-5 w-5" />
              Keep me signed in for 30 days on this private device
            </label>
          ) : null}
          <button
            type="submit"
            disabled={pending}
            aria-busy={pending}
            className={`${partnerPrimaryButtonClass} w-full`}
          >
            {pending
              ? "Saving…"
              : mode === "activation"
                ? "Finish and sign in"
                : "Reset password"}
          </button>
        </form>
      ) : (
        <div className="mt-6 space-y-3">
          <p className="text-sm leading-6 text-slate-600">
            {mode === "activation"
              ? "Use the link Stonegate sent you. If it is missing or no longer works, contact us for a replacement."
              : "Open your password-reset email, or request a new link."}
          </p>
          {mode === "reset" ? (
            <Link
              href="/partners/forgot-password"
              className={partnerPrimaryButtonClass}
            >
              Request another reset link
            </Link>
          ) : null}
          <Link href="/partners/login" className={partnerSecondaryButtonClass}>
            Return to sign in
          </Link>
        </div>
      )}
      <PartnerAccessHelp className="mt-6 border-t border-slate-200 pt-4" />
    </section>
  );
}
