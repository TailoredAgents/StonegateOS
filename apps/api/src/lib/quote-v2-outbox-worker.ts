import { and, eq, inArray, sql } from "drizzle-orm";
import {
  appointments,
  appointmentHolds,
  contacts,
  crmTasks,
  getDb,
  paymentAttempts,
  quoteActivityEvents,
  quoteChangeRequests,
  quoteResponses,
  quoteVersions,
  quotes,
  salesOpportunities,
} from "@/db";
import {
  parseQuoteV2OutboxEvent,
  quoteV2RetryDelayMs,
  type QuoteV2EventType,
  type QuoteV2OutboxPayload,
} from "@/lib/quote-v2-outbox-contract";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";
import { queueSystemOutboundMessage } from "@/lib/system-outbound";

type WorkflowEventType = Exclude<QuoteV2EventType, "quote.send_requested.v2">;

export type QuoteV2WorkflowOutcome =
  | { status: "processed"; error?: string }
  | {
      status: "retry";
      error: string;
      maxAttempts: 8;
      nextAttemptAt: Date;
    }
  | {
      status: "quarantined";
      error: string;
      quarantineReason: string;
    };

type WorkflowInput = {
  id: string;
  type: string;
  payload: unknown;
  attempts: number;
};

type ParsedWorkflowEvent = {
  type: WorkflowEventType;
  payload: QuoteV2OutboxPayload;
};

type BaseWorkflowRow = {
  quoteId: string;
  versionId: string;
  quoteNumber: string | null;
  contactId: string;
  aggregateState: string | null;
  acceptedAppointmentId: string | null;
  opportunityId: string | null;
  versionState: string;
  schedulingMode: string;
  ownerTeamMemberId: string | null;
  contactSalespersonMemberId: string | null;
};

const WORKFLOW_STEP_BY_TYPE: Record<WorkflowEventType, string> = {
  "quote.change_requested.v2": "change_request_workflow_processed",
  "quote.response_recorded.v2": "response_workflow_processed",
  "quote.deposit_checkout_requested.v2": "deposit_checkout_workflow_processed",
  "quote.accepted_and_booked.v2": "accepted_and_booked_notification_queued",
};

const ACTIVE_BOOKING_STATUSES = new Set(["requested", "confirmed"]);

export type QuoteV2NotificationChannel = "sms" | "email";

export function chooseQuoteV2NotificationChannel(input: {
  preferredContactMethod: string | null;
  phoneE164: string | null;
  email: string | null;
}): QuoteV2NotificationChannel | null {
  const preferred = input.preferredContactMethod?.trim().toLowerCase() ?? "";
  const hasSms = /^\+[1-9][0-9]{9,14}$/u.test(input.phoneE164 ?? "");
  const hasEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(
    input.email?.trim() ?? "",
  );
  if (preferred === "email" && hasEmail) return "email";
  if (
    (preferred === "sms" || preferred === "text" || preferred === "phone") &&
    hasSms
  ) {
    return "sms";
  }
  if (hasSms) return "sms";
  if (hasEmail) return "email";
  return null;
}

export function quoteV2WorkflowRetry(
  priorAttempts: number,
  error: string,
  now = new Date(),
): Extract<QuoteV2WorkflowOutcome, { status: "retry" }> {
  return {
    status: "retry",
    error,
    maxAttempts: 8,
    nextAttemptAt: new Date(
      now.getTime() + quoteV2RetryDelayMs(priorAttempts + 1),
    ),
  };
}

export function quoteV2CombinedNotificationDedupeKey(input: {
  responseId: string;
  appointmentId: string;
  channel: QuoteV2NotificationChannel;
}): string {
  return `quote-v2.accepted-booked:${input.responseId}:${input.appointmentId}:${input.channel}`;
}

function quarantine(error: string): QuoteV2WorkflowOutcome {
  return {
    status: "quarantined",
    error,
    quarantineReason: error,
  };
}

function parseWorkflowEvent(
  input: WorkflowInput,
):
  | { ok: true; event: ParsedWorkflowEvent }
  | { ok: false; outcome: QuoteV2WorkflowOutcome } {
  try {
    const event = parseQuoteV2OutboxEvent({
      type: input.type,
      payload: input.payload,
    });
    if (
      event.type === "quote.send_requested.v2" ||
      event.payload.eventId !== input.id
    ) {
      return {
        ok: false,
        outcome: quarantine("quote_v2_workflow_event_binding_invalid"),
      };
    }
    return { ok: true, event: event as ParsedWorkflowEvent };
  } catch (error) {
    return {
      ok: false,
      outcome: quarantine(
        error instanceof Error ? error.message : "invalid_quote_v2_event",
      ),
    };
  }
}

async function loadBaseWorkflowRow(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  payload: QuoteV2OutboxPayload,
): Promise<BaseWorkflowRow | null> {
  const [row] = await tx
    .select({
      quoteId: quotes.id,
      versionId: quoteVersions.id,
      quoteNumber: quotes.quoteNumber,
      contactId: quotes.contactId,
      aggregateState: quotes.aggregateState,
      acceptedAppointmentId: quotes.acceptedAppointmentId,
      opportunityId: quotes.salesOpportunityId,
      versionState: quoteVersions.state,
      schedulingMode: quoteVersions.schedulingMode,
      ownerTeamMemberId: salesOpportunities.ownerTeamMemberId,
      contactSalespersonMemberId: contacts.salespersonMemberId,
    })
    .from(quotes)
    .innerJoin(
      quoteVersions,
      and(
        eq(quoteVersions.id, payload.versionId),
        eq(quoteVersions.quoteId, quotes.id),
      ),
    )
    .leftJoin(
      salesOpportunities,
      eq(salesOpportunities.id, quotes.salesOpportunityId),
    )
    .innerJoin(contacts, eq(contacts.id, quotes.contactId))
    .where(and(eq(quotes.id, payload.quoteId), eq(quotes.engineVersion, "v2")))
    .limit(1);
  return row ?? null;
}

async function hasWorkflowStep(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  input: { outboxEventId: string; eventType: string },
): Promise<boolean> {
  const [existing] = await tx
    .select({ id: quoteActivityEvents.id })
    .from(quoteActivityEvents)
    .where(
      and(
        eq(quoteActivityEvents.outboxEventId, input.outboxEventId),
        eq(quoteActivityEvents.eventType, input.eventType),
      ),
    )
    .limit(1);
  return Boolean(existing?.id);
}

async function insertWorkflowStep(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  input: {
    row: BaseWorkflowRow;
    outboxEventId: string;
    eventType: string;
    correlationId: string;
    metadata: Record<string, unknown>;
    now: Date;
  },
): Promise<void> {
  await tx.insert(quoteActivityEvents).values({
    quoteId: input.row.quoteId,
    quoteVersionId: input.row.versionId,
    eventType: input.eventType,
    actorType: "worker",
    outboxEventId: input.outboxEventId,
    correlationId: input.correlationId,
    causationId: input.outboxEventId,
    metadata: input.metadata,
    occurredAt: input.now,
    createdAt: input.now,
  });
}

async function processChangeRequest(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  input: {
    row: BaseWorkflowRow;
    payload: QuoteV2OutboxPayload;
    outboxEventId: string;
    step: string;
    now: Date;
  },
): Promise<QuoteV2WorkflowOutcome> {
  const [request] = await tx
    .select({
      responseId: quoteResponses.id,
      responseType: quoteResponses.responseType,
      changeRequestId: quoteChangeRequests.id,
      ownerTaskId: quoteChangeRequests.ownerTaskId,
      dueAt: quoteChangeRequests.dueAt,
      respondedAt: quoteResponses.respondedAt,
      taskId: crmTasks.id,
      assignedTo: crmTasks.assignedTo,
    })
    .from(quoteResponses)
    .innerJoin(
      quoteChangeRequests,
      eq(quoteChangeRequests.id, quoteResponses.changeRequestId),
    )
    .innerJoin(crmTasks, eq(crmTasks.id, quoteChangeRequests.ownerTaskId))
    .where(
      and(
        eq(quoteResponses.id, input.payload.responseId!),
        eq(quoteResponses.quoteId, input.row.quoteId),
        eq(quoteResponses.quoteVersionId, input.row.versionId),
        inArray(quoteResponses.responseType, [
          "change_requested",
          "refresh_requested",
        ]),
        eq(quoteChangeRequests.quoteId, input.row.quoteId),
        eq(quoteChangeRequests.quoteVersionId, input.row.versionId),
      ),
    )
    .limit(1);
  if (
    !request?.changeRequestId ||
    !request.taskId ||
    !request.dueAt ||
    !request.assignedTo?.trim() ||
    request.dueAt <= request.respondedAt
  ) {
    return quarantine("quote_change_request_owner_workflow_missing");
  }
  await insertWorkflowStep(tx, {
    row: input.row,
    outboxEventId: input.outboxEventId,
    eventType: input.step,
    correlationId: input.payload.correlationId,
    metadata: {
      responseId: request.responseId,
      responseType: request.responseType,
      changeRequestId: request.changeRequestId,
      ownerTaskId: request.taskId,
    },
    now: input.now,
  });
  return { status: "processed" };
}

async function processResponse(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  input: {
    row: BaseWorkflowRow;
    payload: QuoteV2OutboxPayload;
    outboxEventId: string;
    step: string;
    priorAttempts: number;
    now: Date;
  },
): Promise<QuoteV2WorkflowOutcome> {
  const [response] = await tx
    .select({
      id: quoteResponses.id,
      responseType: quoteResponses.responseType,
    })
    .from(quoteResponses)
    .where(
      and(
        eq(quoteResponses.id, input.payload.responseId!),
        eq(quoteResponses.quoteId, input.row.quoteId),
        eq(quoteResponses.quoteVersionId, input.row.versionId),
      ),
    )
    .limit(1);
  if (
    !response ||
    (response.responseType !== "accepted" &&
      response.responseType !== "declined")
  ) {
    return quarantine("quote_response_event_binding_missing");
  }

  let ownerTaskId: string | null = null;
  if (
    response.responseType === "accepted" &&
    (input.row.schedulingMode === "staff_followup" ||
      input.row.schedulingMode === "approval_only")
  ) {
    const configuredOwner = (await getSalesScorecardConfig(tx))
      .defaultAssigneeMemberId;
    const assignedTo =
      input.row.ownerTeamMemberId ??
      input.row.contactSalespersonMemberId ??
      (configuredOwner.trim() || null);
    if (!assignedTo) {
      return quoteV2WorkflowRetry(
        input.priorAttempts,
        "quote_acceptance_owner_unavailable",
        input.now,
      );
    }
    const [task] = await tx
      .insert(crmTasks)
      .values({
        salesOpportunityId: input.row.opportunityId,
        contactId: input.row.contactId,
        title:
          input.row.schedulingMode === "staff_followup"
            ? `Schedule approved quote ${input.row.quoteNumber ?? "proposal"}`
            : `Follow up on approved quote ${input.row.quoteNumber ?? "proposal"}`,
        dueAt: input.now,
        assignedTo,
        status: "open",
        notes:
          input.row.schedulingMode === "staff_followup"
            ? "The client approved this proposal. Confirm fulfillment details and schedule the work."
            : "The client approved this proposal. Complete the configured staff follow-up.",
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning({ id: crmTasks.id });
    if (!task?.id) {
      return quoteV2WorkflowRetry(
        input.priorAttempts,
        "quote_acceptance_owner_task_not_persisted",
        input.now,
      );
    }
    ownerTaskId = task.id;
  }

  await insertWorkflowStep(tx, {
    row: input.row,
    outboxEventId: input.outboxEventId,
    eventType: input.step,
    correlationId: input.payload.correlationId,
    metadata: {
      responseId: response.id,
      responseType: response.responseType,
      ownerTaskId,
    },
    now: input.now,
  });
  return { status: "processed" };
}

async function processDepositCheckout(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  input: {
    row: BaseWorkflowRow;
    payload: QuoteV2OutboxPayload;
    outboxEventId: string;
    step: string;
    priorAttempts: number;
    now: Date;
  },
): Promise<QuoteV2WorkflowOutcome> {
  const [attempt] = await tx
    .select({
      id: paymentAttempts.id,
      status: paymentAttempts.status,
      provider: paymentAttempts.provider,
      providerOrderId: paymentAttempts.providerOrderId,
      currency: paymentAttempts.currency,
      requestedAmountCents: paymentAttempts.requestedJobAmountCents,
    })
    .from(paymentAttempts)
    .innerJoin(
      quoteResponses,
      and(
        eq(quoteResponses.id, paymentAttempts.quoteResponseId),
        eq(quoteResponses.quoteId, paymentAttempts.quoteId),
        eq(quoteResponses.quoteVersionId, paymentAttempts.quoteVersionId),
        eq(quoteResponses.responseType, "accepted"),
      ),
    )
    .where(
      and(
        eq(paymentAttempts.id, input.payload.paymentAttemptId!),
        eq(paymentAttempts.quoteId, input.row.quoteId),
        eq(paymentAttempts.quoteVersionId, input.row.versionId),
        eq(paymentAttempts.quoteResponseId, input.payload.responseId!),
        eq(paymentAttempts.quotePaymentKind, "deposit"),
      ),
    )
    .limit(1);
  if (
    !attempt ||
    attempt.provider !== "square" ||
    attempt.currency !== "USD" ||
    attempt.requestedAmountCents <= 0
  ) {
    return quarantine("quote_deposit_attempt_binding_invalid");
  }
  if (attempt.status === "created" && !attempt.providerOrderId) {
    return quoteV2WorkflowRetry(
      input.priorAttempts,
      "quote_deposit_checkout_launch_pending",
      input.now,
    );
  }
  if (!attempt.providerOrderId) {
    return quarantine("quote_deposit_provider_evidence_missing");
  }
  await insertWorkflowStep(tx, {
    row: input.row,
    outboxEventId: input.outboxEventId,
    eventType: input.step,
    correlationId: input.payload.correlationId,
    metadata: {
      responseId: input.payload.responseId,
      paymentAttemptId: attempt.id,
      checkoutState: attempt.status,
    },
    now: input.now,
  });
  return { status: "processed" };
}

function formatAppointment(startAt: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone:
      process.env["APPOINTMENT_TIMEZONE"] ??
      process.env["GOOGLE_CALENDAR_TIMEZONE"] ??
      "America/New_York",
  }).format(startAt);
}

async function processAcceptedAndBooked(
  tx: Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0],
  input: {
    row: BaseWorkflowRow;
    payload: QuoteV2OutboxPayload;
    outboxEventId: string;
    step: string;
    priorAttempts: number;
    now: Date;
  },
): Promise<QuoteV2WorkflowOutcome> {
  const [booking] = await tx
    .select({
      responseId: quoteResponses.id,
      responseType: quoteResponses.responseType,
      appointmentId: appointments.id,
      appointmentStatus: appointments.status,
      startAt: appointments.startAt,
      contactId: contacts.id,
      preferredContactMethod: contacts.preferredContactMethod,
      phoneE164: contacts.phoneE164,
      email: contacts.email,
      contactDoNotContact: contacts.doNotContact,
      contactDeletedAt: contacts.deletedAt,
      holdId: appointmentHolds.id,
      holdStatus: appointmentHolds.status,
      holdConsumedAt: appointmentHolds.consumedAt,
    })
    .from(quoteResponses)
    .innerJoin(
      appointments,
      and(
        eq(appointments.id, input.payload.appointmentId!),
        eq(appointments.quoteResponseId, quoteResponses.id),
        eq(appointments.quoteVersionId, quoteResponses.quoteVersionId),
      ),
    )
    .innerJoin(contacts, eq(contacts.id, input.row.contactId))
    .innerJoin(
      appointmentHolds,
      and(
        eq(appointmentHolds.id, input.payload.holdId!),
        eq(appointmentHolds.fullQuoteId, input.row.quoteId),
        eq(appointmentHolds.quoteVersionId, input.row.versionId),
      ),
    )
    .where(
      and(
        eq(quoteResponses.id, input.payload.responseId!),
        eq(quoteResponses.quoteId, input.row.quoteId),
        eq(quoteResponses.quoteVersionId, input.row.versionId),
      ),
    )
    .limit(1);
  if (
    !booking ||
    booking.responseType !== "accepted" ||
    input.row.aggregateState !== "accepted" ||
    input.row.versionState !== "accepted" ||
    input.row.acceptedAppointmentId !== booking.appointmentId ||
    booking.holdStatus !== "consumed" ||
    !booking.holdConsumedAt ||
    !booking.startAt
  ) {
    return quarantine("quote_accepted_booking_binding_invalid");
  }
  if (!ACTIVE_BOOKING_STATUSES.has(booking.appointmentStatus)) {
    await insertWorkflowStep(tx, {
      row: input.row,
      outboxEventId: input.outboxEventId,
      eventType: input.step,
      correlationId: input.payload.correlationId,
      metadata: {
        responseId: booking.responseId,
        appointmentId: booking.appointmentId,
        notificationState: "suppressed",
        appointmentStatus: booking.appointmentStatus,
      },
      now: input.now,
    });
    return { status: "processed", error: "booking_notification_suppressed" };
  }
  if (booking.contactDeletedAt || booking.contactDoNotContact) {
    await insertWorkflowStep(tx, {
      row: input.row,
      outboxEventId: input.outboxEventId,
      eventType: input.step,
      correlationId: input.payload.correlationId,
      metadata: {
        responseId: booking.responseId,
        appointmentId: booking.appointmentId,
        notificationState: "suppressed",
        notificationReason: booking.contactDeletedAt
          ? "contact_inactive"
          : "do_not_contact",
      },
      now: input.now,
    });
    return { status: "processed", error: "booking_notification_suppressed" };
  }

  const channel = chooseQuoteV2NotificationChannel(booking);
  if (!channel) {
    return quoteV2WorkflowRetry(
      input.priorAttempts,
      "quote_combined_notification_channel_unavailable",
      input.now,
    );
  }
  const when = formatAppointment(booking.startAt);
  const body =
    channel === "sms"
      ? `Stonegate: Proposal ${input.row.quoteNumber ?? "confirmation"} is approved and your appointment is confirmed for ${when}. Reply here if you need help.`
      : [
          "Your Stonegate proposal is approved and your appointment is confirmed.",
          "",
          `Proposal: ${input.row.quoteNumber ?? "Approved proposal"}`,
          `Appointment: ${when}`,
          "",
          "Reply to this email if you need help.",
        ].join("\n");
  const messageId = await queueSystemOutboundMessage({
    db: tx,
    contactId: booking.contactId,
    channel,
    toAddress:
      channel === "sms"
        ? booking.phoneE164?.trim()
        : booking.email?.trim().toLowerCase(),
    subject:
      channel === "email"
        ? `Approved and booked: Stonegate proposal ${input.row.quoteNumber ?? "confirmation"}`
        : null,
    body,
    metadata: {
      kind: "quote.v2.accepted_and_booked",
      quoteId: input.row.quoteId,
      versionId: input.row.versionId,
      responseId: booking.responseId,
      appointmentId: booking.appointmentId,
      sourceOutboxEventId: input.outboxEventId,
    },
    dedupeKey: quoteV2CombinedNotificationDedupeKey({
      responseId: booking.responseId,
      appointmentId: booking.appointmentId,
      channel,
    }),
  });
  if (!messageId) {
    return quoteV2WorkflowRetry(
      input.priorAttempts,
      "quote_combined_notification_not_queued",
      input.now,
    );
  }
  await insertWorkflowStep(tx, {
    row: input.row,
    outboxEventId: input.outboxEventId,
    eventType: input.step,
    correlationId: input.payload.correlationId,
    metadata: {
      responseId: booking.responseId,
      appointmentId: booking.appointmentId,
      messageId,
      channel,
      notificationState: "queued",
    },
    now: input.now,
  });
  return { status: "processed" };
}

export async function processQuoteV2WorkflowOutbox(
  input: WorkflowInput,
): Promise<QuoteV2WorkflowOutcome> {
  const parsed = parseWorkflowEvent(input);
  if (!parsed.ok) return parsed.outcome;
  const { event } = parsed;
  const step = WORKFLOW_STEP_BY_TYPE[event.type];
  const now = new Date();
  const db = getDb();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`quote-v2-outbox:${input.id}`}, 0))`,
    );
    if (
      await hasWorkflowStep(tx, {
        outboxEventId: input.id,
        eventType: step,
      })
    ) {
      return { status: "processed" };
    }
    const row = await loadBaseWorkflowRow(tx, event.payload);
    if (!row) return quarantine("quote_v2_workflow_subject_missing");

    switch (event.type) {
      case "quote.change_requested.v2":
        return processChangeRequest(tx, {
          row,
          payload: event.payload,
          outboxEventId: input.id,
          step,
          now,
        });
      case "quote.response_recorded.v2":
        return processResponse(tx, {
          row,
          payload: event.payload,
          outboxEventId: input.id,
          step,
          priorAttempts: input.attempts,
          now,
        });
      case "quote.deposit_checkout_requested.v2":
        return processDepositCheckout(tx, {
          row,
          payload: event.payload,
          outboxEventId: input.id,
          step,
          priorAttempts: input.attempts,
          now,
        });
      case "quote.accepted_and_booked.v2":
        return processAcceptedAndBooked(tx, {
          row,
          payload: event.payload,
          outboxEventId: input.id,
          step,
          priorAttempts: input.attempts,
          now,
        });
    }
  });
}
