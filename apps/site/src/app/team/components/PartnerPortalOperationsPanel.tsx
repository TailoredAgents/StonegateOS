import Link from "next/link";
import type React from "react";
import type { TeamRequestPrincipal } from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import {
  TEAM_CARD_PADDED,
  TEAM_EMPTY_STATE,
  TEAM_SECTION_SUBTITLE,
  TEAM_SECTION_TITLE,
  teamButtonClass,
} from "./team-ui";

type RangeDays = 1 | 7 | 14 | 30;
type RateKey =
  | "availabilitySuccessPercent"
  | "slotFullPercent"
  | "bookingCompletionPercent"
  | "bookingAbandonmentPercent"
  | "uploadCompletionPercent";

type OperationsReport = {
  generatedAt: string;
  rangeDays: RangeDays;
  stages: Array<{ stage: string; label: string; count: number }>;
  personas: Array<{
    persona: string;
    label: string;
    started: number;
    submitted: number;
    confirmed: number;
    reviewRequested: number;
    abandoned: number;
    slotFull: number;
  }>;
  rates: Record<RateKey, number | null>;
};

const RANGE_DAYS: readonly RangeDays[] = [1, 7, 14, 30];
const STAGE_KEYS = new Set([
  "booking_started",
  "availability_requested",
  "availability_available",
  "availability_slot_full",
  "availability_review_only",
  "availability_degraded",
  "slot_contention",
  "booking_submitted",
  "booking_confirmed",
  "booking_review_requested",
  "booking_failed",
  "booking_abandoned",
  "upload_started",
  "upload_completed",
  "upload_failed",
  "upload_interrupted",
]);
const PERSONA_KEYS = new Set([
  "contractor",
  "real_estate_agent",
  "property_manager",
  "commercial_client",
  "other",
  "unknown",
]);
const SAFE_CORRELATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u;
const RATE_CARDS: ReadonlyArray<{
  key: RateKey;
  label: string;
  inverse?: boolean;
}> = [
  { key: "availabilitySuccessPercent", label: "Availability success" },
  { key: "slotFullPercent", label: "No-slot rate", inverse: true },
  { key: "bookingCompletionPercent", label: "Booking completion" },
  {
    key: "bookingAbandonmentPercent",
    label: "Booking abandonment",
    inverse: true,
  },
  { key: "uploadCompletionPercent", label: "Upload completion" },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function percent(value: unknown): number | null {
  return value === null ||
    (typeof value === "number" && value >= 0 && value <= 100)
    ? value
    : null;
}

function parseOperationsReport(value: unknown): OperationsReport | null {
  if (!isRecord(value) || value["ok"] !== true || !isRecord(value["report"])) {
    return null;
  }
  const report = value["report"];
  const generatedAt = report["generatedAt"];
  const rangeDays = report["rangeDays"];
  const stages = report["stages"];
  const personas = report["personas"];
  const rates = report["rates"];
  if (
    typeof generatedAt !== "string" ||
    !Number.isFinite(Date.parse(generatedAt)) ||
    !RANGE_DAYS.includes(rangeDays as RangeDays) ||
    !Array.isArray(stages) ||
    !Array.isArray(personas) ||
    !isRecord(rates)
  ) {
    return null;
  }

  const parsedStages = stages.flatMap((item) => {
    if (!isRecord(item)) return [];
    const stage = item["stage"];
    const label = item["label"];
    const itemCount = count(item["count"]);
    return typeof stage === "string" &&
      STAGE_KEYS.has(stage) &&
      typeof label === "string" &&
      label.length <= 80 &&
      itemCount !== null
      ? [{ stage, label, count: itemCount }]
      : [];
  });
  const parsedPersonas = personas.flatMap((item) => {
    if (!isRecord(item)) return [];
    const persona = item["persona"];
    const label = item["label"];
    const started = count(item["started"]);
    const submitted = count(item["submitted"]);
    const confirmed = count(item["confirmed"]);
    const reviewRequested = count(item["reviewRequested"]);
    const abandoned = count(item["abandoned"]);
    const slotFull = count(item["slotFull"]);
    return typeof persona === "string" &&
      PERSONA_KEYS.has(persona) &&
      typeof label === "string" &&
      label.length <= 80 &&
      started !== null &&
      submitted !== null &&
      confirmed !== null &&
      reviewRequested !== null &&
      abandoned !== null &&
      slotFull !== null
      ? [
          {
            persona,
            label,
            started,
            submitted,
            confirmed,
            reviewRequested,
            abandoned,
            slotFull,
          },
        ]
      : [];
  });
  if (
    parsedStages.length !== STAGE_KEYS.size ||
    new Set(parsedStages.map((item) => item.stage)).size !== STAGE_KEYS.size ||
    parsedPersonas.length !== PERSONA_KEYS.size ||
    new Set(parsedPersonas.map((item) => item.persona)).size !==
      PERSONA_KEYS.size
  ) {
    return null;
  }

  return {
    generatedAt,
    rangeDays: rangeDays as RangeDays,
    stages: parsedStages,
    personas: parsedPersonas,
    rates: {
      availabilitySuccessPercent: percent(rates["availabilitySuccessPercent"]),
      slotFullPercent: percent(rates["slotFullPercent"]),
      bookingCompletionPercent: percent(rates["bookingCompletionPercent"]),
      bookingAbandonmentPercent: percent(rates["bookingAbandonmentPercent"]),
      uploadCompletionPercent: percent(rates["uploadCompletionPercent"]),
    },
  };
}

function formatRate(value: number | null): string {
  return value === null ? "Not enough data" : `${value.toFixed(1)}%`;
}

export async function PartnerPortalOperationsPanel({
  principal,
  rangeDays = 7,
}: {
  principal: TeamRequestPrincipal;
  rangeDays?: RangeDays;
}): Promise<React.ReactElement> {
  let report: OperationsReport | null = null;
  let error = "";
  const requestReference = `portal_admin_${crypto.randomUUID().replace(/-/gu, "")}`;
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/operations?rangeDays=${rangeDays}`,
      {
        timeoutMs: 10_000,
        headers: { "x-correlation-id": requestReference },
      },
    );
    const payload = (await response.json().catch(() => null)) as unknown;
    report = response.ok ? parseOperationsReport(payload) : null;
    if (!report) {
      const candidateReference = response.headers
        .get("x-correlation-id")
        ?.trim();
      const reference =
        candidateReference && SAFE_CORRELATION_ID.test(candidateReference)
          ? candidateReference
          : null;
      error = `Portal operations telemetry could not be loaded${reference ? ` (support reference ${reference})` : ""}.`;
    }
  } catch (caught) {
    console.error("[partner.portal.operations] site_request_failed", {
      correlationId: requestReference,
      errorName: caught instanceof Error ? caught.name : "UnknownError",
    });
    error = `Portal operations telemetry could not be reached (support reference ${requestReference}).`;
  }

  return (
    <div className="space-y-5">
      <div className={TEAM_CARD_PADDED}>
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h2 className={TEAM_SECTION_TITLE}>Portal operations health</h2>
            <p className={TEAM_SECTION_SUBTITLE}>
              Privacy-safe aggregate booking, availability, and upload signals.
              No addresses, notes, filenames, contacts, or commercial fields are
              collected.
            </p>
          </div>
          <nav
            aria-label="Portal telemetry period"
            className="flex flex-wrap gap-2"
          >
            {RANGE_DAYS.map((days) => (
              <Link
                key={days}
                href={`/team/partners?p_admin=operations&p_admin_status=${days}`}
                aria-current={rangeDays === days ? "page" : undefined}
                className={teamButtonClass(
                  rangeDays === days ? "primary" : "secondary",
                  "sm",
                )}
              >
                {days === 1 ? "Today" : `${days} days`}
              </Link>
            ))}
          </nav>
        </div>
      </div>

      {error ? (
        <div className={TEAM_EMPTY_STATE} role="alert">
          {error} No operational totals are being inferred.
        </div>
      ) : report ? (
        <>
          <section
            aria-labelledby="partner-operations-rates"
            className={TEAM_CARD_PADDED}
          >
            <h3 id="partner-operations-rates" className={TEAM_SECTION_TITLE}>
              Funnel health
            </h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
              {RATE_CARDS.map((card) => (
                <div
                  key={card.key}
                  className="rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4"
                >
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[color:var(--team-text-muted)]">
                    {card.label}
                  </p>
                  <p className="mt-2 text-2xl font-semibold tabular-nums text-[color:var(--team-text)]">
                    {formatRate(report.rates[card.key])}
                  </p>
                  {card.inverse ? (
                    <p className="mt-1 text-xs text-[color:var(--team-text-soft)]">
                      Lower is healthier.
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          </section>

          <section
            aria-labelledby="partner-operations-personas"
            className={TEAM_CARD_PADDED}
          >
            <h3 id="partner-operations-personas" className={TEAM_SECTION_TITLE}>
              Booking funnel by persona
            </h3>
            <div className="mt-4 overflow-x-auto">
              <table className="min-w-[52rem] w-full border-separate border-spacing-0 text-left text-sm">
                <caption className="sr-only">
                  Aggregated Partner Portal booking outcomes for the selected
                  period
                </caption>
                <thead>
                  <tr className="text-[color:var(--team-text-muted)]">
                    <th
                      scope="col"
                      className="border-b border-[color:var(--team-border)] px-3 py-3 font-semibold"
                    >
                      Persona
                    </th>
                    <th
                      scope="col"
                      className="border-b border-[color:var(--team-border)] px-3 py-3 text-right font-semibold"
                    >
                      Started
                    </th>
                    <th
                      scope="col"
                      className="border-b border-[color:var(--team-border)] px-3 py-3 text-right font-semibold"
                    >
                      Submitted
                    </th>
                    <th
                      scope="col"
                      className="border-b border-[color:var(--team-border)] px-3 py-3 text-right font-semibold"
                    >
                      Confirmed
                    </th>
                    <th
                      scope="col"
                      className="border-b border-[color:var(--team-border)] px-3 py-3 text-right font-semibold"
                    >
                      Review
                    </th>
                    <th
                      scope="col"
                      className="border-b border-[color:var(--team-border)] px-3 py-3 text-right font-semibold"
                    >
                      Abandoned
                    </th>
                    <th
                      scope="col"
                      className="border-b border-[color:var(--team-border)] px-3 py-3 text-right font-semibold"
                    >
                      No slot
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.personas.map((persona) => (
                    <tr key={persona.persona}>
                      <th
                        scope="row"
                        className="border-b border-[color:var(--team-border)] px-3 py-3 font-semibold text-[color:var(--team-text)]"
                      >
                        {persona.label}
                      </th>
                      {[
                        persona.started,
                        persona.submitted,
                        persona.confirmed,
                        persona.reviewRequested,
                        persona.abandoned,
                        persona.slotFull,
                      ].map((value, index) => (
                        <td
                          key={index}
                          className="border-b border-[color:var(--team-border)] px-3 py-3 text-right tabular-nums text-[color:var(--team-text-muted)]"
                        >
                          {value.toLocaleString("en-US")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-4 text-xs text-[color:var(--team-text-soft)]">
              Generated{" "}
              <time dateTime={report.generatedAt}>
                {new Date(report.generatedAt).toLocaleString("en-US", {
                  timeZone: "America/New_York",
                })}
              </time>
              . Counts are event totals, not unique people.
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
