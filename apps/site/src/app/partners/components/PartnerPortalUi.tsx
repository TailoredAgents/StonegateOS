import type { ReactNode } from "react";
import Link from "next/link";
import type { Route } from "next";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Inbox,
  LoaderCircle,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import { Breadcrumbs, type BreadcrumbItem } from "@/components/Breadcrumbs";

export const partnerFieldClass =
  "mt-1.5 min-h-11 w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-base text-slate-900 shadow-sm transition placeholder:text-slate-400 focus:border-primary-600 focus:outline-none focus:ring-2 focus:ring-primary-100 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500";

export const partnerPrimaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-primary-700 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 disabled:cursor-wait disabled:opacity-60";

export const partnerSecondaryButtonClass =
  "inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 shadow-sm transition hover:border-primary-300 hover:bg-primary-50 hover:text-primary-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60";

const PARTNER_ERROR_MESSAGES: Record<string, string> = {
  booking_operation_expired:
    "This schedule request expired before it could be submitted. Review the details and try again.",
  booking_confirmation_invalid:
    "The job may have been received, but its confirmation was incomplete. Check Jobs before trying again.",
  cancel_confirmation_invalid:
    "The cancellation response was incomplete. Refresh Jobs to confirm the current status.",
  missing_appointment_id:
    "The job details needed for that change were missing. Refresh Jobs and try again.",
  password_too_short: "Use 15 to 128 characters for your new password.",
  password_confirmation_mismatch:
    "The new password and confirmation do not match.",
  current_password_required: "Enter your current password to make this change.",
  current_password_incorrect: "The current password is incorrect.",
  password_reused: "Choose a password you are not already using.",
  recent_authentication_required:
    "For your security, sign in again and complete multi-factor verification if required.",
  rate_limited:
    "Too many attempts were made. Wait a few minutes and try again.",
  logout_failed:
    "We couldn’t confirm server sign-out, so this browser session remains active. Try again or revoke it from Active sessions.",
  save_failed: "We couldn’t save that change. Try again.",
  create_failed:
    "We couldn’t add that location. Check the address and try again.",
};

export function partnerErrorMessage(
  value: string | null,
  fallback = "We couldn’t complete that request. Try again.",
): string | null {
  if (!value) return null;
  const normalized = value.trim();
  const known = PARTNER_ERROR_MESSAGES[normalized.toLowerCase()];
  if (known) return known;
  // Query strings are untrusted. Only stable, locally mapped error codes may
  // become first-party portal copy.
  return fallback;
}

export function PartnerPageHeader({
  eyebrow,
  title,
  description,
  actions,
  breadcrumbs,
  children,
}: {
  eyebrow?: string;
  title: string;
  description: string;
  actions?: ReactNode;
  breadcrumbs?: BreadcrumbItem[];
  children?: ReactNode;
}) {
  return (
    <header className="rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm sm:p-6">
      {breadcrumbs?.length ? <Breadcrumbs items={breadcrumbs} /> : null}
      <div
        className={cn(
          "flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between",
          breadcrumbs?.length ? "mt-4" : null,
        )}
      >
        <div className="min-w-0">
          {eyebrow ? (
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary-700">
              {eyebrow}
            </p>
          ) : null}
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-slate-950 sm:text-3xl">
            {title}
          </h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-600 sm:text-base">
            {description}
          </p>
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      {children ? <div className="mt-5">{children}</div> : null}
    </header>
  );
}

export function PartnerPanel({
  children,
  className,
  id,
  as: Component = "section",
}: {
  children: ReactNode;
  className?: string;
  id?: string;
  as?: "div" | "section" | "article";
}) {
  return (
    <Component
      id={id}
      className={cn(
        "rounded-2xl border border-slate-200/90 bg-white p-5 shadow-sm sm:p-6",
        className,
      )}
    >
      {children}
    </Component>
  );
}

const noticeTone = {
  success: {
    className: "border-emerald-200 bg-emerald-50 text-emerald-900",
    icon: CheckCircle2,
  },
  error: {
    className: "border-rose-200 bg-rose-50 text-rose-900",
    icon: CircleAlert,
  },
  warning: {
    className: "border-amber-200 bg-amber-50 text-amber-950",
    icon: AlertTriangle,
  },
  info: {
    className: "border-sky-200 bg-sky-50 text-sky-950",
    icon: CircleAlert,
  },
} as const;

export function PartnerNotice({
  tone = "info",
  children,
  className,
}: {
  tone?: keyof typeof noticeTone;
  children: ReactNode;
  className?: string;
}) {
  const config = noticeTone[tone];
  const Icon = config.icon;
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-xl border px-4 py-3 text-sm leading-6",
        config.className,
        className,
      )}
      role={tone === "error" ? "alert" : "status"}
      aria-live={tone === "error" ? "assertive" : "polite"}
    >
      <Icon className="mt-0.5 h-5 w-5 shrink-0" aria-hidden="true" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function PartnerEmptyState({
  title,
  description,
  action,
  icon,
}: {
  title: string;
  description: string;
  action?: { href: string; label: string };
  icon?: ReactNode;
}) {
  return (
    <div className="flex min-h-56 flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-slate-50/70 px-5 py-10 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-white text-primary-700 shadow-sm ring-1 ring-slate-200">
        {icon ?? <Inbox className="h-6 w-6" aria-hidden="true" />}
      </div>
      <h2 className="mt-4 text-base font-semibold text-slate-950">{title}</h2>
      <p className="mt-1 max-w-md text-sm leading-6 text-slate-600">
        {description}
      </p>
      {action ? (
        <Link
          href={action.href as Route}
          className={cn(partnerPrimaryButtonClass, "mt-5")}
        >
          {action.label}
          <ArrowRight className="h-4 w-4" aria-hidden="true" />
        </Link>
      ) : null}
    </div>
  );
}

export function PartnerErrorState({
  title = "We couldn’t load this page",
  description = "Your information is safe. Try again, or contact Stonegate if the problem continues.",
  retryHref,
}: {
  title?: string;
  description?: string;
  retryHref?: string;
}) {
  return (
    <PartnerPanel>
      <div
        role="alert"
        className="flex min-h-52 flex-col items-center justify-center text-center"
      >
        <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-50 text-rose-700 ring-1 ring-rose-200">
          <AlertTriangle className="h-6 w-6" aria-hidden="true" />
        </div>
        <h1 className="mt-4 text-xl font-semibold text-slate-950">{title}</h1>
        <p className="mt-2 max-w-lg text-sm leading-6 text-slate-600">
          {description}
        </p>
        {retryHref ? (
          <Link
            href={retryHref as Route}
            className={cn(partnerSecondaryButtonClass, "mt-5")}
          >
            Try again
          </Link>
        ) : null}
      </div>
    </PartnerPanel>
  );
}

export function PartnerLoadingState({
  label = "Loading partner portal",
}: {
  label?: string;
}) {
  return (
    <div
      className="flex min-h-72 items-center justify-center rounded-2xl border border-slate-200 bg-white p-8 text-slate-600 shadow-sm"
      role="status"
      aria-live="polite"
    >
      <LoaderCircle
        className="mr-3 h-5 w-5 animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
      <span className="text-sm font-medium">{label}</span>
    </div>
  );
}

export function PartnerStatCard({
  label,
  value,
  detail,
}: {
  label: string;
  value: string | number;
  detail?: string;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-medium text-slate-600">{label}</p>
      <p className="mt-2 text-3xl font-semibold tracking-tight text-slate-950">
        {value}
      </p>
      {detail ? <p className="mt-1 text-xs text-slate-500">{detail}</p> : null}
    </div>
  );
}

function normalizeStatus(status: string): string {
  return status
    .trim()
    .replace(/[_-]+/gu, " ")
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

export function PartnerStatusBadge({ status }: { status: string }) {
  const normalized = status.trim().toLowerCase();
  const tone = [
    "completed",
    "confirmed",
    "paid",
    "accepted",
    "approved",
  ].includes(normalized)
    ? "bg-emerald-50 text-emerald-800 ring-emerald-200"
    : [
          "canceled",
          "cancelled",
          "declined",
          "failed",
          "overdue",
          "void",
        ].includes(normalized)
      ? "bg-rose-50 text-rose-800 ring-rose-200"
      : [
            "approval_needed",
            "needs_information",
            "requested",
            "requested_review",
            "review",
            "under_review",
          ].includes(normalized)
        ? "bg-amber-50 text-amber-900 ring-amber-200"
        : [
              "en_route",
              "in_progress",
              "issued",
              "partially_paid",
              "pending",
              "scheduled",
            ].includes(normalized)
          ? "bg-sky-50 text-sky-800 ring-sky-200"
          : "bg-slate-100 text-slate-700 ring-slate-200";

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ring-1 ring-inset",
        tone,
      )}
    >
      {normalizeStatus(status || "Unknown")}
    </span>
  );
}
