import "dotenv/config";

import postgres from "postgres";
import {
  HISTORICAL_SUCCESSFUL_PAYMENT_STATUSES,
  summarizeHistoricalPaymentMigrationAudit,
  type HistoricalAppointmentForAudit,
  type PaymentMigrationAuditIssue,
} from "../src/lib/payment-migration-audit";

type SchemaProbeRow = {
  appointmentsTable: string | null;
  paymentsTable: string | null;
  paymentAttemptsTable: string | null;
  paymentRefundsTable: string | null;
  paymentProviderEventsTable: string | null;
  hasPaymentProviderColumn: boolean;
};

type HistoricalJoinRow = {
  appointmentId: string;
  finalTotalCents: number | null;
  cardTipCents: number | null;
  paymentId: string | null;
  stripeChargeId: string | null;
  amountCents: number | null;
  paymentStatus: string | null;
};

type StripeAggregateRow = {
  totalRows: string | number;
  successfulRows: string | number;
  matchedSuccessfulRows: string | number;
  unmatchedSuccessfulRows: string | number;
  successfulGrossCents: string | number;
};

type DuplicateIdentifierRow = {
  identifier: string;
  rowCount: string | number;
  totalGroups: string | number;
};

type UnmatchedStripeRow = {
  paymentId: string;
  stripeChargeId: string;
  amountCents: number;
  status: string;
  createdAt: Date;
};

type LegacyPaymentRow = {
  paymentId: string;
  appointmentId: string | null;
  jobAmountCents: number | null;
  tipCents: number;
  totalAmountCents: number | null;
};

type NeedsReviewAggregateRow = {
  payments: string | number;
  attempts: string | number;
  refunds: string | number;
  providerEvents: string | number;
  failedProviderEvents: string | number;
};

type NeedsReviewSampleRow = {
  kind: string;
  id: string;
  appointmentId: string | null;
  detail: string | null;
};

const SUCCESSFUL_STATUSES = [...HISTORICAL_SUCCESSFUL_PAYMENT_STATUSES];

function parseSampleLimit(): number {
  const args = process.argv.slice(2).filter((argument) => argument !== "--");
  let raw: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help" || argument === "-h") {
      console.log(
        "Usage: payment-migration-audit.ts [--sample-limit=<0-100>]",
      );
      process.exit(0);
    }
    if (argument.startsWith("--sample-limit=")) {
      raw = argument.slice("--sample-limit=".length);
      continue;
    }
    if (argument === "--sample-limit") {
      raw = args[index + 1];
      index += 1;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }
  if (raw === undefined) return 25;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 100) {
    throw new Error("--sample-limit must be an integer from 0 through 100");
  }
  return parsed;
}

function numberValue(value: string | number | null | undefined): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`Expected a safe integer, received ${String(value)}`);
  }
  return parsed;
}

function shouldUseSsl(connectionString: string): boolean {
  return (
    process.env["DATABASE_SSL"] === "true" ||
    /render\.com/.test(connectionString) ||
    /sslmode=require/.test(connectionString)
  );
}

function groupHistoricalAppointments(
  rows: HistoricalJoinRow[],
): HistoricalAppointmentForAudit[] {
  const appointments = new Map<string, HistoricalAppointmentForAudit>();
  for (const row of rows) {
    let appointment = appointments.get(row.appointmentId);
    if (!appointment) {
      appointment = {
        id: row.appointmentId,
        finalTotalCents: row.finalTotalCents,
        cardTipCents: row.cardTipCents,
        stripePayments: [],
      };
      appointments.set(row.appointmentId, appointment);
    }
    if (
      row.paymentId &&
      row.amountCents != null &&
      row.paymentStatus != null
    ) {
      appointment.stripePayments.push({
        id: row.paymentId,
        stripeChargeId: row.stripeChargeId,
        amountCents: row.amountCents,
        status: row.paymentStatus,
      });
    }
  }
  return [...appointments.values()];
}

function issueSamples(
  rows: ReturnType<
    typeof summarizeHistoricalPaymentMigrationAudit
  >["appointments"],
  issue: PaymentMigrationAuditIssue,
  sampleLimit: number,
): string[] {
  return rows
    .filter((row) => row.issues.includes(issue))
    .slice(0, sampleLimit)
    .map((row) => row.appointmentId);
}

async function main(): Promise<void> {
  const sampleLimit = parseSampleLimit();
  const connectionString = process.env["DATABASE_URL"]?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is not set");
  }

  const client = postgres(connectionString, {
    max: 1,
    prepare: false,
    connect_timeout: 15,
    idle_timeout: 5,
    connection: {
      application_name: "stonegate_payment_migration_audit",
      default_transaction_read_only: true,
      statement_timeout: 60_000,
      lock_timeout: 5_000,
      idle_in_transaction_session_timeout: 90_000,
    },
    ...(shouldUseSsl(connectionString)
      ? { ssl: { rejectUnauthorized: false } }
      : {}),
  });

  try {
    const report = await client.begin(
      "isolation level repeatable read read only",
      async (sql) => {
        const [schema] = await sql<SchemaProbeRow[]>`
          select
            to_regclass('public.appointments')::text as "appointmentsTable",
            to_regclass('public.payments')::text as "paymentsTable",
            to_regclass('public.payment_attempts')::text as "paymentAttemptsTable",
            to_regclass('public.payment_refunds')::text as "paymentRefundsTable",
            to_regclass('public.payment_provider_events')::text as "paymentProviderEventsTable",
            exists (
              select 1
              from information_schema.columns
              where table_schema = 'public'
                and table_name = 'payments'
                and column_name = 'provider'
            ) as "hasPaymentProviderColumn"
        `;
        if (!schema?.appointmentsTable || !schema.paymentsTable) {
          throw new Error(
            "The appointments and payments tables must exist before this audit can run",
          );
        }

        const requiredColumns = await sql<
          Array<{ tableName: string; columnName: string }>
        >`
          select table_name as "tableName", column_name as "columnName"
          from information_schema.columns
          where table_schema = 'public'
            and (
              (
                table_name = 'appointments'
                and column_name in (
                  'id',
                  'status',
                  'final_total_cents',
                  'card_tip_cents'
                )
              )
              or (
                table_name = 'payments'
                and column_name in (
                  'id',
                  'stripe_charge_id',
                  'amount',
                  'status',
                  'appointment_id',
                  'created_at'
                )
              )
            )
        `;
        const presentColumns = new Set(
          requiredColumns.map(
            (row) => `${row.tableName}.${row.columnName}`,
          ),
        );
        const expectedColumns = [
          "appointments.id",
          "appointments.status",
          "appointments.final_total_cents",
          "appointments.card_tip_cents",
          "payments.id",
          "payments.stripe_charge_id",
          "payments.amount",
          "payments.status",
          "payments.appointment_id",
          "payments.created_at",
        ];
        const missingColumns = expectedColumns.filter(
          (column) => !presentColumns.has(column),
        );
        if (missingColumns.length > 0) {
          throw new Error(
            `Database is missing Release B audit prerequisites: ${missingColumns.join(", ")}`,
          );
        }

        const paymentLedgerAvailable = Boolean(
          schema.paymentAttemptsTable &&
            schema.paymentRefundsTable &&
            schema.paymentProviderEventsTable &&
            schema.hasPaymentProviderColumn,
        );
        const phase = paymentLedgerAvailable ? "post_0059" : "pre_0059";

        const historicalRows = await sql<HistoricalJoinRow[]>`
          select
            a.id::text as "appointmentId",
            a.final_total_cents as "finalTotalCents",
            a.card_tip_cents as "cardTipCents",
            p.id::text as "paymentId",
            p.stripe_charge_id as "stripeChargeId",
            p.amount as "amountCents",
            p.status as "paymentStatus"
          from appointments as a
          left join payments as p
            on p.appointment_id = a.id
            and p.stripe_charge_id is not null
          where a.status::text = 'completed'
          order by a.id, p.created_at, p.id
        `;
        const historical = summarizeHistoricalPaymentMigrationAudit(
          groupHistoricalAppointments(historicalRows),
        );

        const [stripeAggregate] = await sql<StripeAggregateRow[]>`
          select
            count(*) as "totalRows",
            count(*) filter (
              where lower(status) = any(${SUCCESSFUL_STATUSES})
            ) as "successfulRows",
            count(*) filter (
              where lower(status) = any(${SUCCESSFUL_STATUSES})
                and appointment_id is not null
            ) as "matchedSuccessfulRows",
            count(*) filter (
              where lower(status) = any(${SUCCESSFUL_STATUSES})
                and appointment_id is null
            ) as "unmatchedSuccessfulRows",
            coalesce(sum(amount) filter (
              where lower(status) = any(${SUCCESSFUL_STATUSES})
            ), 0) as "successfulGrossCents"
          from payments
          where stripe_charge_id is not null
        `;
        if (!stripeAggregate) {
          throw new Error("Unable to aggregate historical Stripe rows");
        }

        const unmatchedStripeSamples =
          sampleLimit === 0
            ? []
            : await sql<UnmatchedStripeRow[]>`
                select
                  id::text as "paymentId",
                  stripe_charge_id as "stripeChargeId",
                  amount as "amountCents",
                  status,
                  created_at as "createdAt"
                from payments
                where stripe_charge_id is not null
                  and appointment_id is null
                  and lower(status) = any(${SUCCESSFUL_STATUSES})
                order by created_at, id
                limit ${sampleLimit}
              `;

        const duplicateStripeIdentifierRows =
          await sql<DuplicateIdentifierRow[]>`
            with duplicates as (
              select
                stripe_charge_id as identifier,
                count(*) as "rowCount"
              from payments
              where stripe_charge_id is not null
              group by stripe_charge_id
              having count(*) > 1
            )
            select
              identifier,
              "rowCount",
              count(*) over () as "totalGroups"
            from duplicates
            order by "rowCount" desc, identifier
            limit ${Math.max(sampleLimit, 1)}
          `;
        const duplicateStripeGroupCount = numberValue(
          duplicateStripeIdentifierRows[0]?.totalGroups,
        );
        const duplicateStripeIdentifiers =
          sampleLimit === 0 ? [] : duplicateStripeIdentifierRows;

        let postMigration:
          | {
              actualLegacyCompletionRows: number;
              actualLegacyJobCents: number;
              actualLegacyTipCents: number;
              actualLegacyTotalCents: number;
              predictedLegacyRowsMissing: number;
              unexpectedLegacyRows: number;
              needsReview: {
                payments: number;
                attempts: number;
                refunds: number;
                providerEvents: number;
                failedProviderEvents: number;
              };
              duplicateProviderIdentifierGroups: number;
              samples: {
                predictedLegacyRowsMissing: string[];
                unexpectedLegacyRows: string[];
                duplicateProviderIdentifiers: DuplicateIdentifierRow[];
                needsReview: NeedsReviewSampleRow[];
              };
            }
          | null = null;

        if (paymentLedgerAvailable) {
          const legacyRows = await sql<LegacyPaymentRow[]>`
            select
              id::text as "paymentId",
              appointment_id::text as "appointmentId",
              job_amount_cents as "jobAmountCents",
              tip_cents as "tipCents",
              total_amount_cents as "totalAmountCents"
            from payments
            where provider = 'legacy'
              and legacy_source = 'legacy_completion'
            order by appointment_id, id
          `;
          const actualLegacyAppointmentIds = new Set(
            legacyRows
              .map((row) => row.appointmentId)
              .filter((id): id is string => Boolean(id)),
          );
          const predictedLegacyAppointmentIds = new Set(
            historical.appointments
              .filter((row) => row.disposition === "legacy_completion")
              .map((row) => row.appointmentId),
          );
          const predictedLegacyRowsMissing = [
            ...predictedLegacyAppointmentIds,
          ].filter((id) => !actualLegacyAppointmentIds.has(id));
          const unexpectedLegacyRows = [
            ...actualLegacyAppointmentIds,
          ].filter((id) => !predictedLegacyAppointmentIds.has(id));

          const [reviewAggregate] =
            await sql<NeedsReviewAggregateRow[]>`
              select
                (
                  select count(*)
                  from payments
                  where canonical_status = 'needs_review'
                ) as payments,
                (
                  select count(*)
                  from payment_attempts
                  where status = 'needs_review'
                ) as attempts,
                (
                  select count(*)
                  from payment_refunds
                  where canonical_status = 'needs_review'
                ) as refunds,
                (
                  select count(*)
                  from payment_provider_events
                  where processing_status = 'needs_review'
                ) as "providerEvents",
                (
                  select count(*)
                  from payment_provider_events
                  where processing_status = 'failed'
                ) as "failedProviderEvents"
            `;
          if (!reviewAggregate) {
            throw new Error("Unable to aggregate payment review items");
          }

          const duplicateProviderIdentifierRows =
            await sql<DuplicateIdentifierRow[]>`
              with duplicates as (
                select
                  provider || ':' || provider_payment_id as identifier,
                  count(*) as "rowCount"
                from payments
                where provider_payment_id is not null
                group by provider, provider_payment_id
                having count(*) > 1
              )
              select
                identifier,
                "rowCount",
                count(*) over () as "totalGroups"
              from duplicates
              order by "rowCount" desc, identifier
              limit ${Math.max(sampleLimit, 1)}
            `;
          const duplicateProviderIdentifiers =
            sampleLimit === 0 ? [] : duplicateProviderIdentifierRows;
          const needsReviewSamples =
            sampleLimit === 0
              ? []
              : await sql<NeedsReviewSampleRow[]>`
                  (
                    select
                      'payment' as kind,
                      id::text as id,
                      appointment_id::text as "appointmentId",
                      provider || ':' || coalesce(provider_payment_id, 'missing') as detail
                    from payments
                    where canonical_status = 'needs_review'
                    order by created_at, id
                    limit ${sampleLimit}
                  )
                  union all
                  (
                    select
                      'attempt' as kind,
                      id::text as id,
                      appointment_id::text as "appointmentId",
                      coalesce(error_code, status) as detail
                    from payment_attempts
                    where status = 'needs_review'
                    order by created_at, id
                    limit ${sampleLimit}
                  )
                  union all
                  (
                    select
                      'refund' as kind,
                      id::text as id,
                      null::text as "appointmentId",
                      provider || ':' || coalesce(provider_refund_id, 'missing') as detail
                    from payment_refunds
                    where canonical_status = 'needs_review'
                    order by created_at, id
                    limit ${sampleLimit}
                  )
                  union all
                  (
                    select
                      'provider_event' as kind,
                      id::text as id,
                      null::text as "appointmentId",
                      event_type || ':' || processing_status as detail
                    from payment_provider_events
                    where processing_status in ('needs_review', 'failed')
                    order by received_at, id
                    limit ${sampleLimit}
                  )
                `;

          postMigration = {
            actualLegacyCompletionRows: legacyRows.length,
            actualLegacyJobCents: legacyRows.reduce(
              (sum, row) => sum + (row.jobAmountCents ?? 0),
              0,
            ),
            actualLegacyTipCents: legacyRows.reduce(
              (sum, row) => sum + row.tipCents,
              0,
            ),
            actualLegacyTotalCents: legacyRows.reduce(
              (sum, row) => sum + (row.totalAmountCents ?? 0),
              0,
            ),
            predictedLegacyRowsMissing:
              predictedLegacyRowsMissing.length,
            unexpectedLegacyRows: unexpectedLegacyRows.length,
            needsReview: {
              payments: numberValue(reviewAggregate.payments),
              attempts: numberValue(reviewAggregate.attempts),
              refunds: numberValue(reviewAggregate.refunds),
              providerEvents: numberValue(
                reviewAggregate.providerEvents,
              ),
              failedProviderEvents: numberValue(
                reviewAggregate.failedProviderEvents,
              ),
            },
            duplicateProviderIdentifierGroups: numberValue(
              duplicateProviderIdentifierRows[0]?.totalGroups,
            ),
            samples: {
              predictedLegacyRowsMissing:
                predictedLegacyRowsMissing.slice(0, sampleLimit),
              unexpectedLegacyRows: unexpectedLegacyRows.slice(
                0,
                sampleLimit,
              ),
              duplicateProviderIdentifiers,
              needsReview: needsReviewSamples,
            },
          };
        }

        return {
          ok: true,
          readOnly: true,
          generatedAt: new Date().toISOString(),
          transaction: "repeatable_read_read_only",
          phase,
          schema: {
            paymentLedgerAvailable,
            paymentAttemptsTable:
              schema.paymentAttemptsTable !== null,
            paymentRefundsTable: schema.paymentRefundsTable !== null,
            paymentProviderEventsTable:
              schema.paymentProviderEventsTable !== null,
            paymentProviderColumn: schema.hasPaymentProviderColumn,
          },
          historical: historical.summary,
          stripe: {
            totalRows: numberValue(stripeAggregate.totalRows),
            successfulRows: numberValue(
              stripeAggregate.successfulRows,
            ),
            matchedSuccessfulRows: numberValue(
              stripeAggregate.matchedSuccessfulRows,
            ),
            unmatchedSuccessfulRows: numberValue(
              stripeAggregate.unmatchedSuccessfulRows,
            ),
            successfulGrossCents: numberValue(
              stripeAggregate.successfulGrossCents,
            ),
            duplicateStripeChargeIdGroups:
              duplicateStripeGroupCount,
          },
          postMigration,
          samples: {
            sampleLimit,
            missingFinalTotalAppointments: issueSamples(
              historical.appointments,
              "missing_final_total",
              sampleLimit,
            ),
            negativeFinalTotalAppointments: issueSamples(
              historical.appointments,
              "negative_final_total",
              sampleLimit,
            ),
            conflictingTipAppointments: historical.appointments
              .filter(
                (row) =>
                  row.issues.includes(
                    "conflicting_tip_across_multiple_stripe_payments",
                  ) ||
                  row.issues.includes(
                    "card_tip_outside_single_stripe_payment",
                  ) ||
                  row.issues.includes("negative_card_tip"),
              )
              .slice(0, sampleLimit)
              .map((row) => row.appointmentId),
            overpaymentAppointments: issueSamples(
              historical.appointments,
              "stripe_job_amount_over_final_total",
              sampleLimit,
            ),
            multipleSuccessfulStripeAppointments: issueSamples(
              historical.appointments,
              "multiple_successful_stripe_payments",
              sampleLimit,
            ),
            invalidSuccessfulStripeAmountAppointments: issueSamples(
              historical.appointments,
              "successful_stripe_amount_not_positive",
              sampleLimit,
            ),
            predictedLegacyCompletionAppointments:
              historical.appointments
                .filter(
                  (row) => row.disposition === "legacy_completion",
                )
                .slice(0, sampleLimit)
                .map((row) => row.appointmentId),
            unmatchedSuccessfulStripePayments:
              unmatchedStripeSamples.map((row) => ({
                ...row,
                createdAt: row.createdAt.toISOString(),
              })),
            duplicateStripeChargeIds: duplicateStripeIdentifiers,
          },
          guidance: [
            "Review every manualReviewAppointments sample before applying migration 0059.",
            "Unmatched successful Stripe rows are never attached automatically by this audit.",
            "A post-0059 predictedLegacyRowsMissing or unexpectedLegacyRows count requires investigation before enabling Square.",
          ],
        };
      },
    );

    console.log(JSON.stringify(report, null, 2));
  } finally {
    await client.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(
    `[payment-migration-audit] ${
      error instanceof Error ? error.message : String(error)
    }`,
  );
  process.exitCode = 1;
});
