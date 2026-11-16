"use client";
import Link from "next/link";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  type CampaignWorkspace,
  type CampaignTerms,
  type CampaignReview,
  renderWinterCampaign,
  winterSalePrice,
} from "@myst-os/sdk";
import {
  TEAM_CARD_PADDED,
  TEAM_INPUT,
  TEAM_SECTION_TITLE,
  TEAM_SECTION_SUBTITLE,
  teamButtonClass,
} from "./team-ui";

const CAMPAIGN_INPUT = `${TEAM_INPUT} min-w-0 w-full max-w-full`;

const errorText = (error: unknown) => error instanceof Error ? error.message : "Could not reach the campaign service.";
type CampaignResponse = { ok: boolean; message?: string; error?: string; retryable?: boolean; data?: { campaignId?: string; review?: CampaignReview } };
const initialTerms: CampaignTerms = {
  name: "Winter cleanout sale",
  expiresAt: null,
  serviceThrough: null,
  introduction: "Our winter cleanout sale is here!",
  retroactivePolicy: "undecided",
  stackingPolicy: "undecided",
};
const money = (amount: number) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    amount,
  );
function easternEndOfDay(day: string): string | null {
  if (!day) return null;
  // Determine the offset on the chosen date, rather than using the operator's browser timezone.
  const noon = new Date(`${day}T12:00:00Z`);
  const offset =
    new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      timeZoneName: "longOffset",
    })
      .formatToParts(noon)
      .find((p) => p.type === "timeZoneName")
      ?.value.replace("GMT", "") ?? "-05:00";
  return new Date(`${day}T23:59:59${offset}`).toISOString();
}
function expiryDay(iso: string | null) {
  return iso
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(new Date(iso))
    : "";
}

export function CampaignsSection() {
  const [workspace, setWorkspace] = useState<CampaignWorkspace | null>(null);
  const [terms, setTerms] = useState<CampaignTerms>(initialTerms);
  const [selected, setSelected] = useState<string[]>([]);
  const [review, setReview] = useState<CampaignReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [testPhone, setTestPhone] = useState("");
  const [capacity, setCapacity] = useState(false);
  const [consentContact, setConsentContact] = useState("");
  const [consentEvidence, setConsentEvidence] = useState("");
  const [consentSource, setConsentSource] = useState("");
  const [consentDate, setConsentDate] = useState("");
  const [timeZone, setTimeZone] = useState("America/New_York");
  const [normalPrice, setNormalPrice] = useState("500");
  const requestRef = useRef<{ body: string; key: string } | null>(null);
  const load = useCallback(
    async (id?: string, q = "", preserveTerms = false) => {
      const params = new URLSearchParams();
      if (id) params.set("campaignId", id);
      if (q) params.set("q", q);
      const response = await fetch(`/api/team/sms-campaigns?${params}`, {
        cache: "no-store",
      });
      const data = await response.json() as CampaignWorkspace & { message?: string; error?: string };
      if (!response.ok)
        throw new Error(
          data.message ?? data.error ?? "Could not load campaigns.",
        );
      setWorkspace(data);
      if (!preserveTerms) setTerms(data.campaign?.terms ?? initialTerms);
      setTestPhone((current) => current || data.readiness.testNumbers[0] || "");
      return data;
    },
    [],
  );
  useEffect(() => {
    load().catch((e) => setError(errorText(e)));
  }, [load]);
  const campaign = workspace?.campaign;
  const changed =
    !!campaign && JSON.stringify(terms) !== JSON.stringify(campaign.terms);
  const execute = async (command: Record<string, unknown>, success: string) => {
    setBusy(true);
    setError("");
    setNotice("");
    const body = JSON.stringify(command);
    if (requestRef.current?.body !== body)
      requestRef.current = { body, key: crypto.randomUUID() };
    try {
      const response = await fetch("/api/team/sms-campaigns", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": requestRef.current.key,
        },
        body,
      });
      const result = await response.json() as CampaignResponse;
      if (!response.ok || !result.ok || !result.data) {
        if (!result.retryable) requestRef.current = null;
        throw new Error(
          result.message ??
            result.error ??
            "The action could not be completed.",
        );
      }
      requestRef.current = null;
      if (result.data.review) setReview(result.data.review);
      else {
        setReview(null);
        setSelected([]);
        setCapacity(false);
      }
      await load(result.data.campaignId ?? campaign?.id, query);
      setNotice(success);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Could not reach the campaign service. Retry the same action safely.",
      );
    } finally {
      setBusy(false);
    }
  };
  const base = { campaignId: campaign?.id, version: campaign?.version };
  const price = Number(normalPrice);
  const discount =
    Number.isFinite(price) && price >= 0 && price <= 1_000_000
      ? winterSalePrice(Math.round(price * 100))
      : null;
  const select = (id: string) => {
    setSelected((list) =>
      list.includes(id)
        ? list.filter((x) => x !== id)
        : list.length < 25
          ? [...list, id]
          : list,
    );
    setReview(null);
    setCapacity(false);
  };
  const frozen = !!campaign && campaign.status !== "draft";
  return (
    <section className="space-y-5" aria-busy={busy}>
      <header className={TEAM_CARD_PADDED}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-widest text-[color:var(--team-text-muted)]">
              Customer campaigns
            </p>
            <h1 className="mt-2 text-3xl font-semibold">
              Make room for winter.
            </h1>
            <p className={TEAM_SECTION_SUBTITLE}>
              One clear offer. Personal texts. You decide when each batch goes
              out.
            </p>
          </div>
          <span className="rounded-full bg-emerald-100 px-4 py-2 text-sm font-semibold text-emerald-900">
            40% off all services
          </span>
        </div>
        <div className="mt-5 flex flex-wrap items-end gap-3">
          <label className="grid min-w-0 flex-1 gap-1 text-sm">
            Campaign
            <select
              className={CAMPAIGN_INPUT}
              value={campaign?.id ?? ""}
              disabled={busy}
              onChange={(e) => {
                setReview(null);
                setSelected([]);
                load(e.target.value).catch((e) => setError(errorText(e)));
              }}
            >
              <option value="" disabled>
                Choose a campaign
              </option>
              {workspace?.campaigns.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.terms.name} · {c.status}
                </option>
              ))}
            </select>
          </label>
          <button
            className={teamButtonClass()}
            disabled={busy || !workspace}
            onClick={() => void execute(
                { action: "create", terms: initialTerms },
                "Draft created. Nothing has been sent.",
              )
            }
          >
            New winter campaign
          </button>
        </div>
      </header>
      {campaign && (
        <div className="sticky top-20 z-10 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] px-4 py-3 shadow-sm">
          <p className="text-sm">
            <strong>{campaign.terms.name}</strong>{" "}
            <span className="capitalize">· {campaign.status}</span>
          </p>
          {campaign.status === "active" && (
            <button
              className={teamButtonClass("danger")}
              disabled={busy}
              onClick={() => void execute(
                  { action: "pause", ...base },
                  "Campaign paused. Texts already submitted cannot be recalled.",
                )
              }
            >
              Pause sending
            </button>
          )}
          {campaign.status === "paused" && (
            <span className="text-sm font-medium">
              Unclaimed texts are on hold
            </span>
          )}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-900"
        >
          {error}
          <button
            className="ml-3 underline"
            disabled={busy}
            onClick={() => void load(campaign?.id, query, true)
                .then(() => setError(""))
                .catch((e) => setError(errorText(e)))
            }
          >
            Refresh
          </button>
        </div>
      )}
      {notice && (
        <p
          role="status"
          className="rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900"
        >
          {notice}
        </p>
      )}
      {workspace && (
        <div className={TEAM_CARD_PADDED}>
          <h2 className={TEAM_SECTION_TITLE}>Launch readiness</h2>
          <p className={TEAM_SECTION_SUBTITLE}>
            {workspace.readiness.sender
              ? `Sender: ${workspace.readiness.sender}`
              : "Sender has not been configured."}{" "}
            Drafting and reviewing never sends a text.
          </p>
          {workspace.readiness.blockers.length > 0 ? (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm">
              {workspace.readiness.blockers.map((b) => (
                <li key={b}>{b}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm">
              Sender checks are ready. Review the audience, terms, owner test,
              and available appointments before release.
            </p>
          )}
        </div>
      )}
      {campaign && (
        <>
          <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <form
              className={`${TEAM_CARD_PADDED} space-y-4`}
              onSubmit={(e) => {
                e.preventDefault();
                void execute(
                  { action: "save", ...base, terms },
                  "Draft saved. Review any selected recipients again.",
                );
              }}
            >
              <h2 className={TEAM_SECTION_TITLE}>1. Set the offer</h2>
              <label className="grid min-w-0 gap-1 text-sm">
                Campaign name
                <input
                  className={CAMPAIGN_INPUT}
                  disabled={frozen || busy}
                  value={terms.name}
                  maxLength={100}
                  required
                  onChange={(e) => {
                    setTerms({ ...terms, name: e.target.value });
                    setReview(null);
                  }}
                />
              </label>
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="grid min-w-0 gap-1 text-sm">
                  Sale ends (Eastern time)
                  <input
                    type="date"
                    className={CAMPAIGN_INPUT}
                    disabled={frozen || busy}
                    value={expiryDay(terms.expiresAt)}
                    onChange={(e) => {
                      setTerms({
                        ...terms,
                        expiresAt: easternEndOfDay(e.target.value),
                      });
                      setReview(null);
                    }}
                  />
                </label>
                <label className="grid min-w-0 gap-1 text-sm">
                  Last service date
                  <input
                    type="date"
                    className={CAMPAIGN_INPUT}
                    disabled={frozen || busy}
                    value={terms.serviceThrough ?? ""}
                    onChange={(e) => {
                      setTerms({
                        ...terms,
                        serviceThrough: e.target.value || null,
                      });
                      setReview(null);
                    }}
                  />
                </label>
              </div>
              <label className="grid min-w-0 gap-1 text-sm">
                Opening line
                <textarea
                  className={CAMPAIGN_INPUT}
                  disabled={frozen || busy}
                  value={terms.introduction}
                  maxLength={180}
                  rows={2}
                  onChange={(e) => {
                    setTerms({ ...terms, introduction: e.target.value });
                    setReview(null);
                  }}
                />
              </label>
              <label className="grid min-w-0 gap-1 text-sm">
                Existing quotes
                <select
                  className={CAMPAIGN_INPUT}
                  disabled={frozen || busy}
                  value={terms.retroactivePolicy}
                  onChange={(e) => {
                    setTerms({
                      ...terms,
                      retroactivePolicy: e.target
                        .value as CampaignTerms["retroactivePolicy"],
                    });
                    setReview(null);
                  }}
                >
                  <option value="undecided">Choose a policy</option>
                  <option value="new_quotes_only">
                    New quotes; existing agreements stay unchanged
                  </option>
                  <option value="include_unaccepted_quotes">
                    Requote unaccepted quotes with the sale
                  </option>
                </select>
              </label>
              <label className="grid min-w-0 gap-1 text-sm">
                Other promotions
                <select
                  className={CAMPAIGN_INPUT}
                  disabled={frozen || busy}
                  value={terms.stackingPolicy}
                  onChange={(e) => {
                    setTerms({
                      ...terms,
                      stackingPolicy: e.target
                        .value as CampaignTerms["stackingPolicy"],
                    });
                    setReview(null);
                  }}
                >
                  <option value="undecided">Choose a policy</option>
                  <option value="no_stacking">
                    Apply winter discount once; no stacking
                  </option>
                </select>
              </label>
              {frozen ? (
                <p className="text-sm">
                  Released terms are frozen to protect the offer customers
                  received.
                </p>
              ) : (
                <button
                  className={teamButtonClass("primary")}
                  disabled={busy || !changed}
                >
                  Save offer
                </button>
              )}
            </form>
            <div className={`${TEAM_CARD_PADDED} space-y-5`}>
              <h2 className={TEAM_SECTION_TITLE}>
                The message your customer sees
              </h2>
              <div className="rounded-2xl bg-[color:var(--team-surface-muted)] p-5 text-sm leading-7 whitespace-pre-wrap break-words">
                {renderWinterCampaign(terms, "Alex")}
              </div>
              <p className="text-xs text-[color:var(--team-text-muted)]">
                Each preview uses the customer’s name when available. The
                business name, offer, deadlines, and opt-out text stay
                consistent.
              </p>
              <div className="border-t border-[color:var(--team-border)] pt-4">
                <h3 className="font-semibold">Check the 40% price</h3>
                <label className="mt-3 grid gap-1 text-sm">
                  Normal total, including service fees ($)
                  <input
                    type="number"
                    min="0"
                    max="1000000"
                    step="0.01"
                    className={CAMPAIGN_INPUT}
                    value={normalPrice}
                    onChange={(e) => setNormalPrice(e.target.value)}
                  />
                </label>
                {discount && (
                  <p className="mt-3 text-sm">
                    {money(discount.normalCents / 100)} −{" "}
                    {money(discount.discountCents / 100)} ={" "}
                    <strong>{money(discount.finalCents / 100)}</strong>
                  </p>
                )}
                <p className="mt-2 text-xs">
                  Price preview only. Saving a campaign does not change an
                  existing quote or payment.
                </p>
              </div>
            </div>
          </div>
          {workspace.capacity && (
            <div className={TEAM_CARD_PADDED}>
              <h2 className={TEAM_SECTION_TITLE}>Service capacity</h2>
              <p className="mt-2 text-sm">
                {workspace.capacity.hasOpening
                  ? `${workspace.capacity.availableDates.length} dates have room for a two-hour job plus a 30-minute travel buffer through ${workspace.capacity.through}.`
                  : "No standard job opening was found before the service cutoff. Review your calendar before sending."}
              </p>
              <p className="mt-2 text-xs text-[color:var(--team-text-muted)]">
                Checked against current appointments, holds, schedule blocks and
                capacity settings. Up to 28 days are checked. Job location,
                scope and crew still need confirmation; these openings are not
                reservations.
              </p>
              <Link
                href="/team/calendar"
                className="mt-3 inline-block text-sm underline"
              >
                Check the booking calendar
              </Link>
            </div>
          )}
          <div className={TEAM_CARD_PADDED}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className={TEAM_SECTION_TITLE}>
                  2. Choose up to 25 customers
                </h2>
                <p className={TEAM_SECTION_SUBTITLE}>
                  Completed jobs with verified promotional consent. Excluded
                  contacts stay visible with a reason.
                </p>
              </div>
              <span className="text-sm font-semibold">
                {selected.length} selected
              </span>
            </div>
            <form
              className="my-4 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                load(campaign.id, query, true).catch((e) =>
                  setError(errorText(e)),
                );
              }}
            >
              <input
                aria-label="Search customers"
                className={`${CAMPAIGN_INPUT} min-w-0 flex-1`}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Name or phone"
              />
              <button className={teamButtonClass()} disabled={busy}>
                Search
              </button>
            </form>
            {workspace.audienceTruncated && (
              <p className="mb-3 text-sm">
                Showing the first 500 matches. Narrow your search to find more
                customers.
              </p>
            )}
            <div className="max-h-[28rem] overflow-auto rounded-xl border border-[color:var(--team-border)] divide-y divide-[color:var(--team-border)]">
              {workspace.audience.length ? (
                workspace.audience.map((r) => (
                  <label
                    key={r.contactId}
                    className="flex items-start gap-3 p-3 text-sm"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-5 w-5 shrink-0"
                      checked={selected.includes(r.contactId)}
                      disabled={
                        busy ||
                        !!r.reason ||
                        (!selected.includes(r.contactId) &&
                          selected.length >= 25) ||
                        (frozen && campaign.status !== "active")
                      }
                      onChange={() => select(r.contactId)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-semibold">{r.name}</span>
                      <span className="block break-words text-xs text-[color:var(--team-text-muted)]">
                        {r.phone ?? "No usable number"}
                      </span>
                    </span>
                    <span className="max-w-[45%] text-xs">
                      {r.reason ?? "Eligible"}
                    </span>
                  </label>
                ))
              ) : (
                <p className="p-5 text-sm">
                  No matching customers. Nothing is selected or queued.
                </p>
              )}
            </div>
            <button
              className={`${teamButtonClass("primary")} mt-4`}
              disabled={busy || !selected.length || changed}
              onClick={() => void execute(
                  { action: "review", ...base, contactIds: selected },
                  "Review prepared. No messages have been sent.",
                )
              }
            >
              Review {selected.length || "selected"} messages
            </button>
            {changed && (
              <p className="mt-2 text-sm">
                Save the offer before reviewing recipients.
              </p>
            )}
          </div>
          <details className={TEAM_CARD_PADDED}>
            <summary className="cursor-pointer font-semibold">
              Record existing consent evidence
            </summary>
            <p className="mt-3 text-sm">
              Record a customer&apos;s documented marketing permission or withdrawal.
              This does not request consent or override Do Not Contact.
            </p>
            <form
              className="mt-4 grid gap-3 sm:grid-cols-2"
              onSubmit={(e) => {
                e.preventDefault();
                void execute(
                  {
                    action: "consent",
                    contactId: consentContact,
                    status: "granted",
                    source: consentSource,
                    evidence: consentEvidence,
                    capturedAt: new Date(consentDate).toISOString(),
                    timeZone,
                  },
                  "Consent evidence recorded. Refresh and review recipients before sending.",
                );
              }}
            >
              <label className="grid min-w-0 gap-1 text-sm">
                Customer
                <select
                  required
                  className={CAMPAIGN_INPUT}
                  value={consentContact}
                  onChange={(e) => setConsentContact(e.target.value)}
                >
                  <option value="">Choose a customer</option>
                  {workspace.audience.map((r) => (
                    <option key={r.contactId} value={r.contactId}>
                      {r.name} — {r.phone}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid min-w-0 gap-1 text-sm">
                Evidence source
                <input
                  required
                  className={CAMPAIGN_INPUT}
                  value={consentSource}
                  onChange={(e) => setConsentSource(e.target.value)}
                  placeholder="Signed form, website checkbox…"
                />
              </label>
              <label className="grid min-w-0 gap-1 text-sm">
                Consent captured (your local time)
                <input
                  type="datetime-local"
                  required
                  className={CAMPAIGN_INPUT}
                  value={consentDate}
                  onChange={(e) => setConsentDate(e.target.value)}
                />
              </label>
              <label className="grid min-w-0 gap-1 text-sm">
                Verified recipient timezone
                <input
                  required
                  className={CAMPAIGN_INPUT}
                  value={timeZone}
                  onChange={(e) => setTimeZone(e.target.value)}
                />
              </label>
              <label className="grid gap-1 text-sm sm:col-span-2">
                Evidence reference and permission wording
                <textarea
                  minLength={10}
                  required
                  rows={3}
                  className={CAMPAIGN_INPUT}
                  value={consentEvidence}
                  onChange={(e) => setConsentEvidence(e.target.value)}
                />
              </label>
              <button className={teamButtonClass()} disabled={busy}>
                Save consent evidence
              </button>
              <button
                type="button"
                className={teamButtonClass("danger")}
                disabled={
                  busy ||
                  !consentContact ||
                  consentEvidence.length < 10 ||
                  consentSource.length < 3 ||
                  !consentDate
                }
                onClick={() => void execute(
                    {
                      action: "consent",
                      contactId: consentContact,
                      status: "revoked",
                      source: consentSource,
                      evidence: consentEvidence,
                      capturedAt: new Date(consentDate).toISOString(),
                      timeZone,
                    },
                    "Marketing consent revoked. Pending promotional sends are suppressed.",
                  )
                }
              >
                Record withdrawal
              </button>
            </form>
          </details>
          <div className={TEAM_CARD_PADDED}>
            <h2 className={TEAM_SECTION_TITLE}>3. Send an owner test</h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              Only configured test numbers are available. Tests appear
              separately from customer results.
            </p>
            <div className="mt-4 flex flex-wrap gap-3">
              <label className="grid min-w-0 flex-1 gap-1 text-sm">
                Test phone
                <select
                  className={CAMPAIGN_INPUT}
                  value={testPhone}
                  onChange={(e) => setTestPhone(e.target.value)}
                >
                  <option value="">No test number selected</option>
                  {workspace.readiness.testNumbers.map((n) => (
                    <option key={n}>{n}</option>
                  ))}
                </select>
              </label>
              <button
                className={`${teamButtonClass()} self-end`}
                disabled={
                  busy ||
                  changed ||
                  !testPhone ||
                  !!workspace.readiness.blockers.length
                }
                onClick={() => void execute(
                    { action: "test", ...base, testPhone },
                    "Owner test queued. Check its delivery and appearance before launch.",
                  )
                }
              >
                Send test text
              </button>
            </div>
          </div>
          {review && (
            <div className={`${TEAM_CARD_PADDED} space-y-4`}>
              <h2 className={TEAM_SECTION_TITLE}>
                4. Review and release this batch
              </h2>
              <p className="text-sm">
                {review.recipients.length} individual texts · {review.segments}{" "}
                SMS segments ·{" "}
                {review.estimatedCost === null
                  ? "Cost estimate unavailable"
                  : `${money(review.estimatedCost)} estimated`}
                . Review expires at{" "}
                {new Date(review.expiresAt).toLocaleTimeString()}.
              </p>
              <div className="max-h-96 space-y-3 overflow-auto">
                {review.recipients.map((r) => (
                  <article
                    key={r.contactId}
                    className="rounded-xl border border-[color:var(--team-border)] p-4"
                  >
                    <p className="text-sm font-semibold">
                      {r.name} · {r.phone}
                    </p>
                    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
                      {r.body}
                    </p>
                  </article>
                ))}
              </div>
              <Link
                className="inline-block text-sm underline"
                href="/team/calendar"
                target="_blank"
                rel="noreferrer"
              >
                Review available appointments
              </Link>
              <label className="flex gap-3 text-sm">
                <input
                  type="checkbox"
                  className="h-5 w-5 shrink-0"
                  checked={capacity}
                  onChange={(e) => setCapacity(e.target.checked)}
                />
                I checked the owner test, the selected recipients, and our
                capacity to complete these jobs by the last service date.
              </label>
              <button
                className={teamButtonClass("primary")}
                disabled={
                  busy ||
                  !capacity ||
                  !!workspace.readiness.blockers.length ||
                  changed
                }
                onClick={() => void execute(
                    {
                      action: "release",
                      ...base,
                      reviewId: review.id,
                      capacityConfirmed: true,
                    },
                    "This batch was released. No additional batch will start automatically.",
                  )
                }
              >
                Send this batch of {review.recipients.length}
              </button>
            </div>
          )}
          <div className={TEAM_CARD_PADDED}>
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className={TEAM_SECTION_TITLE}>Delivery and replies</h2>
              <div className="flex flex-wrap gap-2">
                <button
                  className={teamButtonClass()}
                  disabled={busy}
                  onClick={() => void load(campaign.id, query, true).catch((e) =>
                      setError(errorText(e)),
                    )
                  }
                >
                  Refresh results
                </button>
                {campaign.status === "active" && (
                  <button
                    className={teamButtonClass("danger")}
                    disabled={busy}
                    onClick={() => void execute(
                        { action: "pause", ...base },
                        "Campaign paused. Texts already submitted cannot be recalled.",
                      )
                    }
                  >
                    Pause campaign
                  </button>
                )}
                {campaign.status === "paused" && (
                  <button
                    className={teamButtonClass()}
                    disabled={busy}
                    onClick={() => void execute(
                        { action: "resume", ...base },
                        "Released messages can resume. Additional batches still require your action.",
                      )
                    }
                  >
                    Resume campaign
                  </button>
                )}
                {!["completed", "cancelled"].includes(campaign.status) && (
                  <button
                    className={teamButtonClass()}
                    disabled={busy}
                    onClick={() => void execute(
                        { action: "end", ...base },
                        "Campaign ended. Remaining promotional messages are suppressed.",
                      )
                    }
                  >
                    End campaign
                  </button>
                )}
              </div>
            </div>
            <div className="my-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ["Released", workspace.metrics.released],
                ["Queued", workspace.metrics.queued],
                ["Submitted", workspace.metrics.submitted],
                ["Delivered", workspace.metrics.delivered],
                ["Failed", workspace.metrics.failed],
                ["Needs reconciliation", workspace.metrics.uncertain],
                ["Replied", workspace.metrics.replied],
                ["Suppressed", workspace.metrics.suppressed],
                ["Opted out", workspace.metrics.optedOut],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="rounded-xl bg-[color:var(--team-surface-muted)] p-4"
                >
                  <p className="text-2xl font-semibold">{value}</p>
                  <p className="text-xs">{label}</p>
                </div>
              ))}
            </div>
            {(workspace.metrics.uncertain > 0 ||
              workspace.metrics.failed >= 3) && (
              <p
                role="alert"
                className="mb-4 rounded-xl bg-amber-50 p-4 text-sm text-amber-950"
              >
                Review delivery problems before releasing more texts. Uncertain
                provider results require reconciliation; those texts are never
                automatically resent.
              </p>
            )}
            {workspace.outcomes && (
              <div className="mb-5 rounded-xl border border-[color:var(--team-border)] p-4">
                <h3 className="font-semibold">Winter offer results</h3>
                <p className="mt-1 text-xs text-[color:var(--team-text-muted)]">
                  Quotes and bookings carrying this offer, including website
                  customers. These totals do not claim that a text caused a
                  sale. Canceled jobs are excluded from booked value.
                </p>
                <dl className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div>
                    <dt className="text-xs">
                      {workspace.outcomes.quoted} issued quotes
                    </dt>
                    <dd className="text-lg font-semibold">
                      {money(workspace.outcomes.quotedMinCents / 100)}
                      {workspace.outcomes.quotedMaxCents !==
                      workspace.outcomes.quotedMinCents
                        ? ` – ${money(workspace.outcomes.quotedMaxCents / 100)}`
                        : ""}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs">
                      {workspace.outcomes.booked} booked jobs
                    </dt>
                    <dd className="text-lg font-semibold">
                      {money(workspace.outcomes.bookedCents / 100)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-xs">
                      Collected, after refunds (includes tips)
                    </dt>
                    <dd className="text-lg font-semibold">
                      {money(workspace.outcomes.collectedCents / 100)}
                    </dd>
                  </div>
                </dl>
                <div className="mt-3 flex gap-4 text-sm">
                  <Link className="underline" href="/team/quotes">
                    Open quotes
                  </Link>
                  <Link className="underline" href="/team/calendar">
                    Open booking calendar
                  </Link>
                </div>
              </div>
            )}
            {workspace.resultsTruncated && (
              <p className="mb-3 text-sm">
                Showing the latest 1,000 message records. Totals include the
                entire campaign.
              </p>
            )}
            <div className="space-y-2">
              {workspace.recipients.map((r) => (
                <div
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[color:var(--team-border)] p-3 text-sm"
                >
                  <span>
                    {r.name}
                    {r.isTest ? " · TEST" : ""}
                  </span>
                  <span>
                    {r.suppressionReason ?? r.deliveryStatus}
                    {r.repliedAt ? " · Replied" : ""}
                  </span>
                  {r.threadId && (
                    <Link
                      className="underline"
                      href={`/team/inbox?threadId=${r.threadId}`}
                    >
                      Open conversation
                    </Link>
                  )}
                </div>
              ))}
              {!workspace.recipients.length && (
                <p className="text-sm text-[color:var(--team-text-muted)]">
                  No messages have been released.
                </p>
              )}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
