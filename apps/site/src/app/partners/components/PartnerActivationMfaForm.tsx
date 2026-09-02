"use client";

import * as React from "react";
import type { Route } from "next";
import { useRouter } from "next/navigation";
import {
  CheckCircle2,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import { partnerOnboardingFetch } from "../lib/onboarding";
import {
  PartnerNotice,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

type Enrollment = {
  challengeId: string;
  secret: string;
  otpauthUri: string;
  expiresAt: string;
};

type Setup =
  | { mode: "verify"; enrollment: null }
  | { mode: "enroll"; enrollment: Enrollment };

export function PartnerActivationMfaForm() {
  const router = useRouter();
  const [setup, setSetup] = React.useState<Setup | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [verificationMethod, setVerificationMethod] = React.useState<
    "totp" | "recovery"
  >("totp");
  const [recoveryCodes, setRecoveryCodes] = React.useState<string[]>([]);

  const begin = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    const result = await partnerOnboardingFetch<{
      ok: true;
      mode: "enroll" | "verify";
      enrollment?: Enrollment;
    }>("activation/mfa/enrollment", {
      method: "POST",
      body: JSON.stringify({}),
    }).catch(() => null);
    setLoading(false);
    if (!result?.ok) {
      setError(
        result?.response.status === 401 || result?.response.status === 410
          ? "This security setup session expired. Request a new activation link to continue."
          : result?.response.status === 429
            ? "Too many setup attempts were made. Wait a few minutes, then try again."
            : (result?.error.message ??
              "We couldn’t start authenticator setup."),
      );
      return;
    }
    if (result.data.mode === "verify") {
      setSetup({ mode: "verify", enrollment: null });
      return;
    }
    const enrollment = result.data.enrollment;
    if (
      !enrollment?.challengeId ||
      !enrollment.secret ||
      !enrollment.otpauthUri
    ) {
      setError("Authenticator setup returned an invalid response.");
      return;
    }
    setSetup({ mode: "enroll", enrollment });
  }, []);

  React.useEffect(() => {
    void begin();
  }, [begin]);

  async function confirm(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!setup) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const values = new FormData(form);
    const verification = values.get("verification");
    if (typeof verification !== "string") return;
    setPending(true);
    setError(null);
    const result = await partnerOnboardingFetch<{
      ok: true;
      redirectTo?: string;
      enrollment?: {
        enrolled?: boolean;
        recoveryCodes?: string[];
        displayOnce?: boolean;
      };
    }>("activation/mfa/confirm", {
      method: "POST",
      body: JSON.stringify({
        ...(setup.mode === "enroll"
          ? { challengeId: setup.enrollment.challengeId }
          : {}),
        ...(verificationMethod === "recovery"
          ? { recoveryCode: verification.trim() }
          : { code: verification.trim() }),
        ...(setup.mode === "enroll"
          ? { label: "Stonegate Partner Portal" }
          : {}),
      }),
    }).catch(() => null);
    setPending(false);
    if (!result?.ok) {
      setError(
        result?.response.status === 401 || result?.response.status === 410
          ? "This security setup session expired. Request a new activation link to continue."
          : result?.response.status === 422
            ? "That code was not accepted. Enter the current code and try again."
            : result?.response.status === 429
              ? "Too many verification attempts were made. Wait before trying again."
              : (result?.error.message ??
                "We couldn’t verify your authenticator."),
      );
      return;
    }
    const codes = Array.isArray(result.data.enrollment?.recoveryCodes)
      ? result.data.enrollment.recoveryCodes.filter(
          (value): value is string =>
            typeof value === "string" && Boolean(value),
        )
      : [];
    if (codes.length > 0) {
      setRecoveryCodes(codes);
      setSetup(null);
      return;
    }
    router.replace((result.data.redirectTo ?? "/partners/overview") as Route);
    router.refresh();
  }

  if (recoveryCodes.length > 0) {
    return (
      <div className="mx-auto max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-10">
        <CheckCircle2
          className="h-12 w-12 text-emerald-600"
          aria-hidden="true"
        />
        <h1 className="mt-5 text-3xl font-semibold tracking-tight text-slate-950">
          Save your recovery codes
        </h1>
        <p className="mt-3 text-sm leading-6 text-slate-600">
          Each code works once if your authenticator is unavailable. Store them
          somewhere private now; they won’t be shown again.
        </p>
        <ul className="mt-6 grid gap-2 rounded-2xl bg-slate-950 p-5 font-mono text-sm text-white sm:grid-cols-2">
          {recoveryCodes.map((code) => (
            <li key={code}>{code}</li>
          ))}
        </ul>
        <button
          type="button"
          onClick={() => {
            router.replace("/partners/overview" as Route);
            router.refresh();
          }}
          className={cn(partnerPrimaryButtonClass, "mt-6 w-full")}
        >
          I saved these codes
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl rounded-3xl border border-slate-200 bg-white p-6 shadow-xl shadow-slate-200/60 sm:p-10">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
        <ShieldCheck className="h-6 w-6" aria-hidden="true" />
      </div>
      <h1 className="mt-5 text-3xl font-semibold tracking-tight text-slate-950">
        Secure your partner access
      </h1>
      <p className="mt-3 text-sm leading-6 text-slate-600">
        This role requires two-step verification. Your account access remains
        inactive until the authenticator check succeeds.
      </p>
      {error ? (
        <PartnerNotice tone="error" className="mt-5">
          {error}
        </PartnerNotice>
      ) : null}
      {loading ? (
        <div
          className="mt-6 flex items-center gap-3 text-sm text-slate-600"
          role="status"
        >
          <LoaderCircle
            className="h-5 w-5 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          Preparing secure setup…
        </div>
      ) : setup ? (
        <>
          {setup.mode === "enroll" ? (
            <div className="mt-6 space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-5">
              <div className="flex items-start gap-3">
                <KeyRound
                  className="mt-0.5 h-5 w-5 text-primary-700"
                  aria-hidden="true"
                />
                <div>
                  <h2 className="font-semibold text-slate-950">
                    Add Stonegate to your authenticator
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-slate-600">
                    Open the setup link, or enter the secret manually, then use
                    the current six-digit code below.
                  </p>
                </div>
              </div>
              <a
                href={setup.enrollment.otpauthUri}
                className={cn(partnerSecondaryButtonClass, "w-full")}
              >
                Open authenticator app
              </a>
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Manual setup secret
                </p>
                <code className="mt-2 block break-all rounded-xl bg-white p-3 text-sm text-slate-900 ring-1 ring-slate-200">
                  {setup.enrollment.secret}
                </code>
              </div>
            </div>
          ) : (
            <PartnerNotice tone="info" className="mt-6">
              Use the authenticator or a recovery code already attached to your
              Partner Portal identity.
            </PartnerNotice>
          )}
          <form
            onSubmit={(event) => void confirm(event)}
            className="mt-6 space-y-5"
          >
            {setup.mode === "verify" ? (
              <label className="block" htmlFor="activation-verification-method">
                <span className="text-sm font-semibold text-slate-700">
                  Verification method
                </span>
                <select
                  id="activation-verification-method"
                  value={verificationMethod}
                  onChange={(event) =>
                    setVerificationMethod(
                      event.target.value === "recovery" ? "recovery" : "totp",
                    )
                  }
                  className={partnerFieldClass}
                >
                  <option value="totp">Authenticator code</option>
                  <option value="recovery">Recovery code</option>
                </select>
              </label>
            ) : null}
            <label className="block" htmlFor="activation-mfa-verification">
              <span className="text-sm font-semibold text-slate-700">
                {verificationMethod === "recovery"
                  ? "Recovery code"
                  : "Six-digit authenticator code"}
              </span>
              <input
                id="activation-mfa-verification"
                name="verification"
                type="text"
                required
                inputMode={verificationMethod === "totp" ? "numeric" : "text"}
                pattern={verificationMethod === "totp" ? "[0-9]{6}" : undefined}
                minLength={verificationMethod === "totp" ? 6 : 8}
                maxLength={verificationMethod === "totp" ? 6 : 64}
                autoComplete="one-time-code"
                className={partnerFieldClass}
              />
            </label>
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
                <ShieldCheck className="h-4 w-4" aria-hidden="true" />
              )}
              {pending ? "Verifying…" : "Verify and activate access"}
            </button>
          </form>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void begin()}
          className={cn(partnerPrimaryButtonClass, "mt-6 w-full")}
        >
          Try setup again
        </button>
      )}
    </div>
  );
}
