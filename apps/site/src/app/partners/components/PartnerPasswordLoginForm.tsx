import Link from "next/link";
import { partnerPasswordLoginAction } from "@/app/partners/actions";
import { PartnerMutationSubmitButton } from "@/app/partners/PartnerMutationSubmitButton";
import { normalizePartnerReturnTo } from "@/app/partners/lib/safe-return";
import { PartnerLoginPasswordInput } from "./PartnerLoginPasswordInput";
import {
  partnerFieldClass,
  partnerPrimaryButtonClass,
} from "./PartnerPortalUi";

/** Native POST works without JavaScript; rendering never reads a cookie or account. */
export function PartnerPasswordLoginForm({ returnTo }: { returnTo?: string }) {
  return (
    <form
      action={partnerPasswordLoginAction}
      className="mt-6 space-y-4"
      data-partner-analytics="password_login"
    >
      <input
        type="hidden"
        name="returnTo"
        value={normalizePartnerReturnTo(returnTo)}
      />
      <label className="block" htmlFor="partner-email">
        <span className="text-sm font-semibold text-slate-700">Email</span>
        <input
          id="partner-email"
          name="email"
          type="email"
          required
          maxLength={254}
          autoComplete="username"
          inputMode="email"
          className={`${partnerFieldClass} mt-1`}
        />
      </label>
      <div>
        <div className="flex items-center justify-between gap-3">
          <label
            htmlFor="partner-password"
            className="text-sm font-semibold text-slate-700"
          >
            Password
          </label>
          <Link
            href="/partners/forgot-password"
            className="inline-flex min-h-11 items-center text-sm font-semibold text-primary-800 underline underline-offset-4"
          >
            Forgot password?
          </Link>
        </div>
        <PartnerLoginPasswordInput />
      </div>
      <label className="flex min-h-11 items-center gap-3 text-sm text-slate-700">
        <input
          name="rememberMe"
          type="checkbox"
          className="h-5 w-5 rounded border-slate-300 text-primary-700 focus:ring-primary-600"
        />
        <span>
          Remember me{" "}
          <span className="text-slate-500">(30 days on this device)</span>
        </span>
      </label>
      <PartnerMutationSubmitButton
        className={`${partnerPrimaryButtonClass} w-full`}
        pendingLabel="Signing in…"
      >
        Sign in
      </PartnerMutationSubmitButton>
    </form>
  );
}
