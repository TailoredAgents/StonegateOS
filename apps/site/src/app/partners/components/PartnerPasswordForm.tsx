"use client";

import * as React from "react";
import { Eye, EyeOff } from "lucide-react";
import { partnerSetPasswordAction } from "@/app/partners/actions";
import { PartnerMutationSubmitButton } from "@/app/partners/PartnerMutationSubmitButton";
import {
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

export function PartnerPasswordForm({ passwordSet }: { passwordSet: boolean }) {
  const [showPasswords, setShowPasswords] = React.useState(false);
  const confirmationRef = React.useRef<HTMLInputElement>(null);
  const inputType = showPasswords ? "text" : "password";

  function clearConfirmationError(): void {
    confirmationRef.current?.setCustomValidity("");
  }

  function validateConfirmation(event: React.FormEvent<HTMLFormElement>): void {
    const formData = new FormData(event.currentTarget);
    const newPassword = formData.get("newPassword");
    const confirmPassword = formData.get("confirmPassword");
    if (
      typeof newPassword !== "string" ||
      typeof confirmPassword !== "string" ||
      newPassword !== confirmPassword
    ) {
      event.preventDefault();
      confirmationRef.current?.setCustomValidity("Passwords do not match.");
      confirmationRef.current?.reportValidity();
    }
  }

  return (
    <form
      action={partnerSetPasswordAction}
      onSubmit={validateConfirmation}
      className="mt-6 space-y-4"
    >
      <div className="flex items-center justify-between gap-3">
        <p
          id="partner-password-requirements"
          className="text-xs leading-5 text-slate-500"
        >
          Use 15–128 characters. A long, unique passphrase is easiest to
          remember.
        </p>
        <button
          type="button"
          onClick={() => setShowPasswords((current) => !current)}
          aria-pressed={showPasswords}
          className={`${partnerSecondaryButtonClass} shrink-0 px-3`}
        >
          {showPasswords ? (
            <EyeOff className="h-4 w-4" aria-hidden="true" />
          ) : (
            <Eye className="h-4 w-4" aria-hidden="true" />
          )}
          {showPasswords ? "Hide" : "Show"}
        </button>
      </div>

      {passwordSet ? (
        <label className="block" htmlFor="partner-current-password">
          <span className="text-sm font-semibold text-slate-700">
            Current password
          </span>
          <input
            id="partner-current-password"
            name="currentPassword"
            type={inputType}
            required
            maxLength={128}
            autoComplete="current-password"
            className={partnerFieldClass}
          />
        </label>
      ) : null}

      <label className="block" htmlFor="partner-new-password">
        <span className="text-sm font-semibold text-slate-700">
          New password
        </span>
        <input
          id="partner-new-password"
          name="newPassword"
          type={inputType}
          required
          minLength={15}
          maxLength={128}
          autoComplete="new-password"
          aria-describedby="partner-password-requirements"
          onInput={clearConfirmationError}
          className={partnerFieldClass}
        />
      </label>

      <label className="block" htmlFor="partner-confirm-password">
        <span className="text-sm font-semibold text-slate-700">
          Confirm new password
        </span>
        <input
          ref={confirmationRef}
          id="partner-confirm-password"
          name="confirmPassword"
          type={inputType}
          required
          minLength={15}
          maxLength={128}
          autoComplete="new-password"
          aria-describedby="partner-password-requirements"
          onInput={clearConfirmationError}
          className={partnerFieldClass}
        />
      </label>

      <PartnerMutationSubmitButton
        className={partnerPrimaryButtonClass}
        pendingLabel="Saving password…"
      >
        {passwordSet ? "Change password" : "Set password"}
      </PartnerMutationSubmitButton>
    </form>
  );
}
