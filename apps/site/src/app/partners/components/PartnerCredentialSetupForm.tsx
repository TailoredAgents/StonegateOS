"use client";

import * as React from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  MailCheck,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  onboardingOperationKey,
  partnerOnboardingFetch,
} from "../lib/onboarding";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

type Mode = "activation" | "reset";

export function PartnerCredentialSetupForm({
  mode,
  hasToken,
}: {
  mode: Mode;
  hasToken: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const [inspecting, setInspecting] = React.useState(
    mode === "activation" && hasToken,
  );
  const [tokenValid, setTokenValid] = React.useState(hasToken);
  const [detail, setDetail] = React.useState<{
    accountName?: string;
    email?: string;
    name?: string;
    passwordAlreadySet?: boolean;
  } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [showPasswords, setShowPasswords] = React.useState(false);
  const [resendEmail, setResendEmail] = React.useState("");
  const [resendSent, setResendSent] = React.useState(false);

  React.useEffect(() => {
    if (mode !== "activation" || !hasToken) return;
    let current = true;
    void partnerOnboardingFetch<{
      ok: true;
      activation?: {
        accountName?: string;
        email?: string;
        expiresAt?: string;
        name?: string;
        passwordAlreadySet?: boolean;
      };
    }>("activation/inspect", {
      method: "POST",
      body: JSON.stringify({}),
    })
      .then((result) => {
        if (!current) return;
        setInspecting(false);
        if (!result.ok) {
          const linkInvalid =
            result.response.status === 401 || result.response.status === 410;
          setTokenValid(!linkInvalid);
          setError(
            linkInvalid
              ? "That activation link is invalid, expired, or already used."
              : result.response.status === 429
                ? "Too many activation attempts were made. Wait a few minutes before continuing."
                : (result.error.message ??
                  "We couldn’t verify that activation link. Try again shortly."),
          );
          return;
        }
        const activation = result.data.activation;
        if (!activation?.accountName || !activation.email) {
          setTokenValid(false);
          setError("That activation link could not be verified.");
          return;
        }
        setDetail({
          accountName: activation.accountName,
          email: activation.email,
          name: activation.name,
          passwordAlreadySet: activation.passwordAlreadySet === true,
        });
      })
      .catch(() => {
        if (!current) return;
        setInspecting(false);
        setError("We couldn’t verify that activation link. Try again shortly.");
      });
    return () => {
      current = false;
    };
  }, [hasToken, mode]);

  async function submit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const data = new FormData(form);
    const password = data.get("password");
    const confirmPassword = data.get("confirmPassword");
    if (typeof password !== "string" || typeof confirmPassword !== "string")
      return;
    if (password !== confirmPassword) {
      setError("The password and confirmation do not match.");
      return;
    }
    setPending(true);
    setError(null);
    const path =
      mode === "activation"
        ? "activation/complete"
        : "password-recovery/complete";
    const result = await partnerOnboardingFetch<{
      ok: true;
      redirectTo?: string;
    }>(path, {
      method: "POST",
      headers: {
        "Idempotency-Key": onboardingOperationKey(`partner-${mode}`),
      },
      body: JSON.stringify(
        mode === "activation"
          ? {
              password,
              confirmPassword,
              rememberMe: data.get("rememberMe") === "on",
            }
          : { newPassword: password, confirmPassword },
      ),
    }).catch(() => null);
    setPending(false);
    if (!result?.ok) {
      if (result?.response.status === 401 || result?.response.status === 410) {
        setTokenValid(false);
      }
      setError(
        result?.response.status === 401 || result?.response.status === 410
          ? `That ${mode === "activation" ? "activation" : "reset"} link is invalid, expired, or already used.`
          : (result?.error.message ?? "We couldn’t save your password."),
      );
      return;
    }
    if (mode === "activation") {
      const destination = (result.data.redirectTo ??
        "/partners/overview") as Route;
      router.replace(destination);
      router.refresh();
      return;
    }
    router.replace("/partners/login?reset=1");
    router.refresh();
  }

  async function requestAnotherActivation(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    setPending(true);
    setError(null);
    const result = await partnerOnboardingFetch<{ ok: true }>(
      "activation/resend",
      {
        method: "POST",
        headers: {
          "Idempotency-Key": onboardingOperationKey(
            "partner-activation-resend",
          ),
        },
        body: JSON.stringify({ email: resendEmail }),
      },
    ).catch(() => null);
    setPending(false);
    if (!result?.ok) {
      setError(
        result?.response.status === 429
          ? "Too many activation requests were made. Wait a few minutes, then try again."
          : (result?.error.message ??
              "We couldn’t request another activation email."),
      );
      return;
    }
    setResendSent(true);
  }

  const confirmsExistingPassword =
    mode === "activation" && detail?.passwordAlreadySet === true;
  const title =
    mode === "activation"
      ? confirmsExistingPassword
        ? "Confirm your partner access"
        : "Activate your partner access"
      : "Choose a new password";
  const description =
    mode === "activation"
      ? confirmsExistingPassword
        ? "Enter your current portal password to add this approved company to your sign-in. Your password will not change."
        : "Create your password to finish activation and open your partner workspace."
      : "Choose a new password so you can get back to requesting and managing service. Other signed-in devices may be signed out for security.";

  return (
    <div className="mx-auto max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-10">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
        {mode === "activation" ? (
          <ShieldCheck className="h-6 w-6" aria-hidden="true" />
        ) : (
          <KeyRound className="h-6 w-6" aria-hidden="true" />
        )}
      </div>
      <p className="mt-5 text-xs font-semibold uppercase tracking-[0.16em] text-primary-700">
        Quick and easy partner service
      </p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
        {title}
      </h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">{description}</p>
      {detail?.accountName ? (
        <div className="mt-5 rounded-xl bg-slate-50 p-4 text-sm text-slate-700">
          <p>
            <span className="font-semibold">Company:</span> {detail.accountName}
          </p>
          {detail.name ? (
            <p className="mt-1">
              <span className="font-semibold">Name:</span> {detail.name}
            </p>
          ) : null}
          {detail.email ? (
            <p className="mt-1 break-all">
              <span className="font-semibold">Email:</span> {detail.email}
            </p>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <PartnerNotice tone="error" className="mt-5">
          {error}
        </PartnerNotice>
      ) : null}
      {inspecting ? (
        <div
          className="mt-6 flex items-center gap-3 text-sm text-slate-600"
          role="status"
        >
          <LoaderCircle
            className="h-5 w-5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          Verifying activation link…
        </div>
      ) : tokenValid ? (
        <form
          onSubmit={(event) => void submit(event)}
          className="mt-6 space-y-5"
          data-partner-analytics={
            mode === "activation" ? "account_activation" : "password_reset"
          }
        >
          <label className="block" htmlFor={`${mode}-password`}>
            <span className="text-sm font-semibold text-slate-700">
              {confirmsExistingPassword ? "Current password" : "New password"}
            </span>
            <input
              id={`${mode}-password`}
              name="password"
              type={showPasswords ? "text" : "password"}
              required
              minLength={confirmsExistingPassword ? 1 : 15}
              maxLength={128}
              autoComplete={
                confirmsExistingPassword ? "current-password" : "new-password"
              }
              aria-describedby={`${mode}-password-help`}
              className={partnerFieldClass}
            />
            <span
              id={`${mode}-password-help`}
              className="mt-1 block text-xs text-slate-500"
            >
              {confirmsExistingPassword
                ? "Use the password for your existing Partner Portal account."
                : "Use 15–128 characters and a password unique to this portal."}
            </span>
          </label>
          <label className="block" htmlFor={`${mode}-confirm-password`}>
            <span className="text-sm font-semibold text-slate-700">
              {confirmsExistingPassword
                ? "Confirm current password"
                : "Confirm new password"}
            </span>
            <input
              id={`${mode}-confirm-password`}
              name="confirmPassword"
              type={showPasswords ? "text" : "password"}
              required
              minLength={confirmsExistingPassword ? 1 : 15}
              maxLength={128}
              autoComplete={
                confirmsExistingPassword ? "current-password" : "new-password"
              }
              className={partnerFieldClass}
            />
          </label>
          <label className="flex min-h-11 items-center gap-3 text-sm text-slate-700">
            <input
              type="checkbox"
              checked={showPasswords}
              onChange={(event) => setShowPasswords(event.target.checked)}
              className="h-5 w-5 rounded border-slate-300 text-primary-700"
            />
            Show passwords
          </label>
          {mode === "activation" ? (
            <label className="flex min-h-11 items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2.5 text-sm text-slate-700">
              <input
                name="rememberMe"
                type="checkbox"
                className="mt-0.5 h-5 w-5 rounded border-slate-300 text-primary-700"
              />
              <span>
                <span className="block font-semibold text-slate-800">
                  Keep me signed in
                </span>
                <span className="mt-0.5 block text-xs text-slate-500">
                  Use only on a private device. This extends the session from 12
                  hours to 30 days.
                </span>
              </span>
            </label>
          ) : null}
          <button
            type="submit"
            disabled={pending}
            aria-busy={pending}
            className={cn(partnerPrimaryButtonClass, "w-full")}
          >
            {pending ? (
              <LoaderCircle
                className="h-4 w-4 animate-spin motion-reduce:animate-none"
                aria-hidden="true"
              />
            ) : (
              <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            )}
            {pending
              ? "Saving password…"
              : mode === "activation"
                ? confirmsExistingPassword
                  ? "Confirm and activate access"
                  : "Activate account"
                : "Reset password"}
          </button>
        </form>
      ) : (
        <div className="mt-6 space-y-4">
          {mode === "activation" ? (
            resendSent ? (
              <PartnerNotice tone="success">
                If that address is ready for activation, we sent a fresh one-use
                link. Check your inbox and spam folder.
              </PartnerNotice>
            ) : (
              <form
                onSubmit={(event) => void requestAnotherActivation(event)}
                className="space-y-3"
              >
                <label htmlFor="activation-resend-email" className="block">
                  <span className="text-sm font-semibold text-slate-700">
                    Account email
                  </span>
                  <input
                    id="activation-resend-email"
                    type="email"
                    required
                    maxLength={254}
                    autoComplete="email"
                    value={resendEmail}
                    onChange={(event) => setResendEmail(event.target.value)}
                    className={partnerFieldClass}
                  />
                </label>
                <button
                  type="submit"
                  disabled={pending}
                  className={`${partnerPrimaryButtonClass} w-full`}
                >
                  {pending ? (
                    <LoaderCircle
                      className="h-4 w-4 animate-spin motion-reduce:animate-none"
                      aria-hidden="true"
                    />
                  ) : (
                    <MailCheck className="h-4 w-4" aria-hidden="true" />
                  )}
                  {pending ? "Requesting…" : "Send another activation link"}
                </button>
              </form>
            )
          ) : (
            <Link
              href={"/partners/forgot-password" as Route}
              className={partnerPrimaryButtonClass}
            >
              Request another reset link
            </Link>
          )}
          <div className="flex flex-col gap-3 sm:flex-row">
            {mode === "activation" ? (
              <Link
                href={"/partners/application" as Route}
                className={partnerSecondaryButtonClass}
              >
                Check application status
              </Link>
            ) : null}
            <Link
              href="/partners/login"
              className={partnerSecondaryButtonClass}
            >
              Return to sign in
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
