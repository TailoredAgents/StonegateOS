"use client";

import * as React from "react";
import {
  CheckCircle2,
  Clock3,
  LoaderCircle,
  MessageSquareText,
  RefreshCw,
  Send,
  Trash2,
} from "lucide-react";
import { cn } from "@myst-os/ui";
import {
  createPortalOperationKey,
  partnerPortalFetch,
  portalSupportReferenceFromResponse,
  withPortalSupportReference,
} from "../lib/portal-v2";
import {
  hasVerifiedPartnerSmsEndpoint,
  parsePartnerSmsEndpoint,
  parsePartnerSmsEndpoints,
  PARTNER_SMS_CONSENT_VERSION,
  type PartnerSmsDeliveryStatus,
  type PartnerSmsEndpoint,
  withPartnerSmsChallenge,
} from "../lib/notification-endpoints";
import {
  PartnerNotice,
  PartnerPanel,
  partnerFieldClass,
  partnerPrimaryButtonClass,
  partnerSecondaryButtonClass,
} from "./PartnerPortalUi";

type Notice = {
  tone: "success" | "error" | "warning" | "info";
  text: string;
};

function endpointError(
  error: string | undefined,
  status: number | undefined,
  correlationId?: string | null,
): Notice {
  let notice: Notice;
  if (error === "rate_limited" || status === 429) {
    notice = {
      tone: "warning",
      text: "Too many SMS verification attempts were made. Wait before trying again.",
    };
  } else if (error === "invalid_fields" || status === 422) {
    notice = {
      tone: "error",
      text: "The phone number or verification code was not accepted. Check it or request a new code.",
    };
  } else if (status === 404) {
    notice = {
      tone: "error",
      text: "That SMS verification request is no longer available. Request a new code.",
    };
  } else if (status === 403) {
    notice = {
      tone: "error",
      text: "You do not have permission to change text-message settings.",
    };
  } else {
    notice = {
      tone: "error",
      text: "SMS verification is temporarily unavailable. Your notification preferences were not changed.",
    };
  }
  return {
    ...notice,
    text: withPortalSupportReference(notice.text, correlationId),
  };
}

function deliveryLabel(status: PartnerSmsDeliveryStatus): string {
  switch (status) {
    case "queued":
      return "Code queued for delivery";
    case "dispatching":
      return "Sending verification code";
    case "accepted":
      return "Verification text accepted for delivery";
    case "failed":
      return "Verification text delivery failed";
    case "reconciliation_required":
      return "Verification delivery needs review";
  }
}

function upsertEndpoint(
  endpoints: PartnerSmsEndpoint[],
  endpoint: PartnerSmsEndpoint,
): PartnerSmsEndpoint[] {
  const next = endpoints.filter((candidate) => candidate.id !== endpoint.id);
  return [endpoint, ...next];
}

function replacePendingEndpoint(
  endpoints: PartnerSmsEndpoint[],
  endpoint: PartnerSmsEndpoint,
): PartnerSmsEndpoint[] {
  return [
    endpoint,
    ...endpoints
      .filter((candidate) => candidate.id !== endpoint.id)
      .map((candidate) =>
        candidate.status === "pending"
          ? {
              ...candidate,
              status: "revoked" as const,
              activeChallenge: null,
            }
          : candidate,
      ),
  ];
}

function replaceVerifiedEndpoint(
  endpoints: PartnerSmsEndpoint[],
  endpoint: PartnerSmsEndpoint,
): PartnerSmsEndpoint[] {
  return [
    endpoint,
    ...endpoints
      .filter((candidate) => candidate.id !== endpoint.id)
      .map((candidate) =>
        candidate.status === "verified"
          ? {
              ...candidate,
              status: "revoked" as const,
              activeChallenge: null,
            }
          : candidate,
      ),
  ];
}

export function PartnerSmsEndpointManager({
  initialEndpoints,
  canManage,
  onEndpointsChange,
}: {
  initialEndpoints: PartnerSmsEndpoint[] | null;
  canManage: boolean;
  onEndpointsChange?: (
    endpoints: PartnerSmsEndpoint[],
    verified: boolean,
    preferencesChanged: boolean,
  ) => void;
}) {
  const [endpoints, setEndpoints] = React.useState(initialEndpoints);
  const [busyAction, setBusyAction] = React.useState<string | null>(null);
  const [confirmRevokeId, setConfirmRevokeId] = React.useState<string | null>(
    null,
  );
  const [notice, setNotice] = React.useState<Notice | null>(null);

  const commit = React.useCallback(
    (next: PartnerSmsEndpoint[], preferencesChanged = false): void => {
      setEndpoints(next);
      onEndpointsChange?.(
        next,
        hasVerifiedPartnerSmsEndpoint(next),
        preferencesChanged,
      );
    },
    [onEndpointsChange],
  );

  const markUnavailable = React.useCallback((): void => {
    setEndpoints(null);
    onEndpointsChange?.([], false, false);
  }, [onEndpointsChange]);

  const reload = React.useCallback(async (): Promise<void> => {
    setBusyAction("reload");
    const result = await partnerPortalFetch<{
      ok: true;
      endpoints: unknown;
    }>("notification-endpoints").catch(() => null);
    setBusyAction(null);
    const parsed = result?.ok
      ? parsePartnerSmsEndpoints(result.data.endpoints)
      : null;
    if (!result?.ok || !parsed) {
      if (result?.ok) markUnavailable();
      setNotice(
        endpointError(
          result?.ok ? "invalid_response" : result?.error.error,
          result?.response.status,
          result?.ok
            ? portalSupportReferenceFromResponse(result.response)
            : result?.error.correlationId,
        ),
      );
      return;
    }
    commit(parsed);
    setNotice({ tone: "success", text: "SMS delivery status refreshed." });
  }, [commit, markUnavailable]);

  async function requestCode(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const value = data.get("phone");
    if (typeof value !== "string" || !value.trim() || value.length > 80) {
      setNotice({
        tone: "error",
        text: "Enter a valid US mobile number to receive a verification code.",
      });
      return;
    }
    const body = JSON.stringify({ channel: "sms", phone: value.trim() });
    form.reset();
    setBusyAction("request");
    setNotice(null);
    const result = await partnerPortalFetch<{
      ok: true;
      endpoint: unknown;
      challenge?: unknown;
    }>("notification-endpoints", {
      method: "POST",
      headers: {
        "Idempotency-Key": createPortalOperationKey("sms-code-request"),
      },
      body,
    }).catch(() => null);
    setBusyAction(null);
    if (!result?.ok) {
      if (!result) markUnavailable();
      setNotice(
        endpointError(
          result?.error.error,
          result?.response.status,
          result?.error.correlationId,
        ),
      );
      return;
    }
    const parsed = parsePartnerSmsEndpoint(result.data.endpoint);
    if (!parsed) {
      setNotice(
        endpointError(
          "invalid_response",
          503,
          portalSupportReferenceFromResponse(result.response),
        ),
      );
      return;
    }
    const endpoint = withPartnerSmsChallenge(parsed, result.data.challenge);
    if (!endpoint) {
      markUnavailable();
      setNotice(
        endpointError(
          "invalid_response",
          503,
          portalSupportReferenceFromResponse(result.response),
        ),
      );
      return;
    }
    commit(
      endpoint.status === "verified"
        ? replaceVerifiedEndpoint(endpoints ?? [], endpoint)
        : replacePendingEndpoint(endpoints ?? [], endpoint),
    );
    setNotice(
      endpoint.status === "verified"
        ? {
            tone: "success",
            text: `SMS delivery is already verified for ${endpoint.maskedDestination}.`,
          }
        : {
            tone: "info",
            text: `A six-digit verification code was requested for ${endpoint.maskedDestination}.`,
          },
    );
  }

  async function verifyCode(
    event: React.FormEvent<HTMLFormElement>,
    endpoint: PartnerSmsEndpoint,
  ): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const code = data.get("code");
    const consentAccepted = data.get("consentAccepted") === "yes";
    if (typeof code !== "string" || !/^[0-9]{6}$/u.test(code)) {
      setNotice({
        tone: "error",
        text: "Enter the complete six-digit verification code.",
      });
      return;
    }
    if (!consentAccepted) {
      setNotice({
        tone: "warning",
        text: "SMS consent must be explicitly accepted before this number can be verified.",
      });
      return;
    }
    const body = JSON.stringify({
      code,
      consentAccepted: true,
      consentVersion: PARTNER_SMS_CONSENT_VERSION,
    });
    form.reset();
    setBusyAction(`verify:${endpoint.id}`);
    setNotice(null);
    const result = await partnerPortalFetch<{
      ok: true;
      endpoint: unknown;
    }>(`notification-endpoints/${encodeURIComponent(endpoint.id)}/verify`, {
      method: "POST",
      headers: {
        "Idempotency-Key": createPortalOperationKey("sms-code-verify"),
      },
      body,
    }).catch(() => null);
    setBusyAction(null);
    if (!result?.ok) {
      if (!result) markUnavailable();
      setNotice(
        endpointError(
          result?.error.error,
          result?.response.status,
          result?.error.correlationId,
        ),
      );
      return;
    }
    const parsed = parsePartnerSmsEndpoint(result.data.endpoint);
    if (!parsed || parsed.status !== "verified") {
      setNotice(
        endpointError(
          "invalid_response",
          503,
          portalSupportReferenceFromResponse(result.response),
        ),
      );
      return;
    }
    commit(replaceVerifiedEndpoint(endpoints ?? [], parsed), true);
    setNotice({
      tone: "success",
      text: `SMS delivery is verified for ${parsed.maskedDestination}.`,
    });
  }

  async function revoke(endpoint: PartnerSmsEndpoint): Promise<void> {
    setBusyAction(`revoke:${endpoint.id}`);
    setNotice(null);
    const result = await partnerPortalFetch<{
      ok: true;
      endpoint: unknown;
    }>(`notification-endpoints/${encodeURIComponent(endpoint.id)}`, {
      method: "DELETE",
      headers: {
        "Idempotency-Key": createPortalOperationKey("sms-endpoint-revoke"),
      },
      body: JSON.stringify({ confirmation: "STOP SMS" }),
    }).catch(() => null);
    setBusyAction(null);
    if (!result?.ok) {
      if (!result || result.response.status === 404) markUnavailable();
      setNotice(
        endpointError(
          result?.error.error,
          result?.response.status,
          result?.error.correlationId,
        ),
      );
      return;
    }
    const parsed = parsePartnerSmsEndpoint(result.data.endpoint);
    if (!parsed || parsed.status !== "revoked") {
      setNotice(
        endpointError(
          "invalid_response",
          503,
          portalSupportReferenceFromResponse(result.response),
        ),
      );
      return;
    }
    setConfirmRevokeId(null);
    commit(
      upsertEndpoint(endpoints ?? [], parsed),
      endpoint.status === "verified",
    );
    setNotice({
      tone: "success",
      text: `SMS delivery was removed for ${parsed.maskedDestination}.`,
    });
  }

  return (
    <PartnerPanel>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary-50 text-primary-700 ring-1 ring-primary-100">
            <MessageSquareText className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-slate-950">
              Get useful updates by text
            </h2>
            <p className="mt-1 max-w-2xl text-sm leading-6 text-slate-600">
              Verify a mobile number once, then choose the job updates you want
              by text. Saved numbers are shown only by their final four digits.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void reload()}
          disabled={busyAction !== null}
          className={partnerSecondaryButtonClass}
        >
          <RefreshCw
            className={cn(
              "h-4 w-4",
              busyAction === "reload" &&
                "animate-spin motion-reduce:animate-none",
            )}
            aria-hidden="true"
          />
          Refresh status
        </button>
      </div>

      {notice ? (
        <PartnerNotice tone={notice.tone} className="mt-5">
          {notice.text}
        </PartnerNotice>
      ) : null}

      {canManage ? (
        <form
          onSubmit={(event) => void requestCode(event)}
          className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4"
        >
          <div className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
            <label>
              <span className="text-sm font-semibold text-slate-800">
                Mobile number
              </span>
              <span className="mt-1 block text-xs leading-5 text-slate-500">
                US mobile number; a six-digit code expires after ten minutes.
              </span>
              <input
                name="phone"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                required
                maxLength={80}
                placeholder="(555) 555-0123"
                className={partnerFieldClass}
              />
            </label>
            <button
              type="submit"
              disabled={busyAction !== null}
              className={partnerPrimaryButtonClass}
            >
              {busyAction === "request" ? (
                <LoaderCircle
                  className="h-4 w-4 animate-spin motion-reduce:animate-none"
                  aria-hidden="true"
                />
              ) : (
                <Send className="h-4 w-4" aria-hidden="true" />
              )}
              {busyAction === "request" ? "Requesting…" : "Send code"}
            </button>
          </div>
        </form>
      ) : (
        <PartnerNotice tone="info" className="mt-5">
          Someone with account security access must add, verify, or remove
          text-message numbers.
        </PartnerNotice>
      )}

      {endpoints === null ? (
        <PartnerNotice tone="warning" className="mt-5">
          Text-message status is temporarily unavailable. Text preferences
          remain disabled.
        </PartnerNotice>
      ) : endpoints.length === 0 ? (
        <p className="mt-5 text-sm leading-6 text-slate-600">
          No mobile number is ready for text updates yet.
        </p>
      ) : (
        <ul className="mt-5 space-y-3" aria-label="SMS delivery numbers">
          {endpoints.map((endpoint) => {
            const challengeExpired = Boolean(
              endpoint.activeChallenge &&
                new Date(endpoint.activeChallenge.expiresAt).getTime() <=
                  Date.now(),
            );
            const verifying = busyAction === `verify:${endpoint.id}`;
            const revoking = busyAction === `revoke:${endpoint.id}`;
            return (
              <li
                key={endpoint.id}
                className="rounded-xl border border-slate-200 bg-white p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-base font-semibold text-slate-950">
                      {endpoint.maskedDestination}
                    </p>
                    <p className="mt-1 inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                      {endpoint.status === "verified" ? (
                        <CheckCircle2
                          className="h-4 w-4 text-emerald-700"
                          aria-hidden="true"
                        />
                      ) : (
                        <Clock3 className="h-4 w-4" aria-hidden="true" />
                      )}
                      {endpoint.status === "verified"
                        ? "Verified for SMS"
                        : endpoint.status === "revoked"
                          ? "SMS delivery removed"
                          : challengeExpired
                            ? "Verification code expired"
                            : endpoint.activeChallenge
                              ? deliveryLabel(
                                  endpoint.activeChallenge.deliveryStatus,
                                )
                              : "Verification pending"}
                    </p>
                  </div>
                  {canManage && endpoint.status !== "revoked" ? (
                    <button
                      type="button"
                      onClick={() => setConfirmRevokeId(endpoint.id)}
                      disabled={busyAction !== null}
                      className={cn(
                        partnerSecondaryButtonClass,
                        "text-rose-700 hover:border-rose-200 hover:bg-rose-50",
                      )}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                      Remove
                    </button>
                  ) : null}
                </div>

                {canManage &&
                endpoint.status === "pending" &&
                !challengeExpired ? (
                  <form
                    onSubmit={(event) => void verifyCode(event, endpoint)}
                    className="mt-4 border-t border-slate-200 pt-4"
                  >
                    <label className="block max-w-xs">
                      <span className="text-sm font-semibold text-slate-800">
                        Six-digit verification code
                      </span>
                      <input
                        name="code"
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        pattern="[0-9]{6}"
                        minLength={6}
                        maxLength={6}
                        required
                        className={partnerFieldClass}
                      />
                    </label>
                    <label className="mt-4 flex max-w-2xl items-start gap-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
                      <input
                        name="consentAccepted"
                        value="yes"
                        type="checkbox"
                        required
                        className="mt-1 h-5 w-5 shrink-0 rounded border-slate-300 text-primary-700 focus:ring-2 focus:ring-accent-500"
                      />
                      <span className="text-sm leading-6 text-slate-700">
                        I agree to receive transactional SMS updates from
                        Stonegate for account and job activity. Message and data
                        rates may apply. I can remove this number here or reply
                        STOP to opt out. Consent record:{" "}
                        {PARTNER_SMS_CONSENT_VERSION}.
                      </span>
                    </label>
                    <button
                      type="submit"
                      disabled={busyAction !== null}
                      className={cn(partnerPrimaryButtonClass, "mt-4")}
                    >
                      {verifying ? (
                        <LoaderCircle
                          className="h-4 w-4 animate-spin motion-reduce:animate-none"
                          aria-hidden="true"
                        />
                      ) : (
                        <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
                      )}
                      {verifying ? "Verifying…" : "Verify and enable SMS"}
                    </button>
                  </form>
                ) : null}

                {confirmRevokeId === endpoint.id ? (
                  <div
                    className="mt-4 rounded-lg border border-rose-200 bg-rose-50 p-4"
                    role="alert"
                  >
                    <p className="font-semibold text-rose-950">
                      Remove {endpoint.maskedDestination} from SMS delivery?
                    </p>
                    <p className="mt-1 text-sm leading-6 text-rose-900">
                      SMS preferences will be disabled. You must request and
                      verify a new code before texts can be enabled again.
                    </p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => void revoke(endpoint)}
                        disabled={busyAction !== null}
                        className={cn(
                          partnerPrimaryButtonClass,
                          "bg-rose-700 hover:bg-rose-800",
                        )}
                      >
                        {revoking ? (
                          <LoaderCircle
                            className="h-4 w-4 animate-spin motion-reduce:animate-none"
                            aria-hidden="true"
                          />
                        ) : (
                          <Trash2 className="h-4 w-4" aria-hidden="true" />
                        )}
                        {revoking ? "Removing…" : "Yes, remove SMS number"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmRevokeId(null)}
                        disabled={busyAction !== null}
                        className={partnerSecondaryButtonClass}
                      >
                        Keep number
                      </button>
                    </div>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </PartnerPanel>
  );
}
