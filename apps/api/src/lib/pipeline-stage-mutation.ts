import type { PipelineStage } from "../../app/api/admin/crm/pipeline/stages";
import { PIPELINE_STAGE_SET } from "../../app/api/admin/crm/pipeline/stages";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "@/lib/team-mutation";

export const PIPELINE_ABSENT_VERSION = "pipeline:none";
export const PIPELINE_MUTATION_MAXIMUM_BYTES = 4 * 1024;
export const PIPELINE_NOTE_MAXIMUM_LENGTH = 2_000;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const EXACT_ISO_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const INPUT_KEYS = new Set(["notes", "stage"]);

export type PipelineStageMutationPayload = {
  stage: PipelineStage;
  notes: string | null;
};

export type PipelineStageRecord = {
  contactId: string;
  stage: PipelineStage;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PipelineStagePublicState = {
  contactId: string;
  stage: PipelineStage;
  updatedAt: string | null;
  version: string;
};

export type PipelineStageMutationRepository = {
  lockContactScope(contactId: string): Promise<void>;
  findActiveContactForUpdate(contactId: string): Promise<boolean>;
  findPipelineForUpdate(contactId: string): Promise<PipelineStageRecord | null>;
  insertPipeline(input: {
    contactId: string;
    stage: PipelineStage;
    now: Date;
  }): Promise<PipelineStageRecord | null>;
  updatePipeline(input: {
    contactId: string;
    stage: PipelineStage;
    previousUpdatedAt: Date;
    updatedAt: Date;
  }): Promise<PipelineStageRecord | null>;
  insertNote(input: {
    contactId: string;
    notes: string;
  }): Promise<string | null>;
  closeSalesHqTasks(input: {
    contactId: string;
    updatedAt: Date;
  }): Promise<number>;
};

export type PipelineStageMutationExecution = {
  before: PipelineStagePublicState;
  pipeline: PipelineStagePublicState;
  noteTaskId: string | null;
  closedSalesTaskCount: number;
  noOp: boolean;
};

export class PipelineStageConflictFailure extends TeamMutationFailure {
  readonly current: PipelineStagePublicState;

  constructor(message: string, current: PipelineStagePublicState) {
    super("conflict", message, {
      fieldErrors: { version: "The submitted pipeline version is stale." },
    });
    this.name = "PipelineStageConflictFailure";
    this.current = current;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyInputKeys(value: Record<string, unknown>): boolean {
  return Object.keys(value).every((key) => INPUT_KEYS.has(key));
}

function isExactIsoInstant(value: string): boolean {
  return (
    EXACT_ISO_INSTANT_PATTERN.test(value) &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function isPipelineContactId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function parsePipelineStageMutationPayload(
  value: unknown,
): PipelineStageMutationPayload {
  if (!isRecord(value) || !hasOnlyInputKeys(value) || !("stage" in value)) {
    throw new TeamMutationFailure(
      "invalid",
      "The pipeline update contains unsupported or missing fields.",
      {
        fieldErrors: {
          stage: "Send exactly one supported stage and an optional note.",
        },
      },
    );
  }

  const rawStage = value["stage"];
  const normalizedStage =
    typeof rawStage === "string"
      ? rawStage.normalize("NFKC").trim().toLowerCase()
      : "";
  if (!PIPELINE_STAGE_SET.has(normalizedStage)) {
    throw new TeamMutationFailure(
      "invalid",
      "Choose a supported pipeline stage.",
      { fieldErrors: { stage: "Choose a stage from the CRM list." } },
    );
  }

  const rawNotes = value["notes"];
  if (
    rawNotes !== undefined &&
    rawNotes !== null &&
    typeof rawNotes !== "string"
  ) {
    throw new TeamMutationFailure("invalid", "The pipeline note is invalid.", {
      fieldErrors: { notes: "Enter a text note or leave it blank." },
    });
  }
  const normalizedNotes =
    typeof rawNotes === "string" ? rawNotes.normalize("NFKC").trim() : "";
  if (normalizedNotes.length > PIPELINE_NOTE_MAXIMUM_LENGTH) {
    throw new TeamMutationFailure("invalid", "The pipeline note is too long.", {
      fieldErrors: {
        notes: `Use ${PIPELINE_NOTE_MAXIMUM_LENGTH.toLocaleString("en-US")} characters or fewer.`,
      },
    });
  }

  return {
    stage: normalizedStage as PipelineStage,
    notes: normalizedNotes || null,
  };
}

export function parsePipelineExpectedVersion(value: string | null): string {
  if (value === PIPELINE_ABSENT_VERSION) return value;
  if (value && isExactIsoInstant(value)) return value;
  throw new TeamMutationFailure(
    "invalid",
    "The latest pipeline version is required before changing its stage.",
    {
      fieldErrors: {
        version: "Refresh the contact and submit its exact pipeline version.",
      },
    },
  );
}

export function nextPipelineUpdatedAt(previous: Date, candidate: Date): Date {
  if (Number.isNaN(previous.getTime()) || Number.isNaN(candidate.getTime())) {
    throw new TeamMutationFailure(
      "internal",
      "The pipeline version could not be calculated safely.",
    );
  }
  return new Date(Math.max(candidate.getTime(), previous.getTime() + 1));
}

export function pipelinePublicState(
  contactId: string,
  record: PipelineStageRecord | null,
): PipelineStagePublicState {
  if (!record) {
    return {
      contactId,
      stage: "new",
      updatedAt: null,
      version: PIPELINE_ABSENT_VERSION,
    };
  }
  const version = record.updatedAt.toISOString();
  return {
    contactId,
    stage: record.stage,
    updatedAt: version,
    version,
  };
}

function requireMatchingVersion(
  contactId: string,
  current: PipelineStageRecord | null,
  expectedVersion: string,
): void {
  const currentState = pipelinePublicState(contactId, current);
  if (currentState.version !== expectedVersion) {
    throw new PipelineStageConflictFailure(
      "This contact changed after it was loaded. The latest pipeline state is included; refresh before trying again.",
      currentState,
    );
  }
}

function closesSalesHqTasks(stage: PipelineStage): boolean {
  return stage === "quoted" || stage === "won" || stage === "lost";
}

/**
 * Executes pipeline and linked-record work through one transaction-scoped
 * repository. Audit and idempotency completion are appended by the route in
 * that same transaction before its result can become visible.
 */
export async function executePipelineStageMutation(
  repository: PipelineStageMutationRepository,
  input: {
    contactId: string;
    expectedVersion: string;
    payload: PipelineStageMutationPayload;
    now?: Date;
  },
): Promise<PipelineStageMutationExecution> {
  const now = input.now ?? new Date();
  await repository.lockContactScope(input.contactId);
  if (!(await repository.findActiveContactForUpdate(input.contactId))) {
    throw new TeamMutationFailure(
      "invalid",
      "The selected contact no longer exists.",
      {
        status: 404,
        fieldErrors: { contactId: "Refresh and select an active contact." },
      },
    );
  }

  const current = await repository.findPipelineForUpdate(input.contactId);
  requireMatchingVersion(input.contactId, current, input.expectedVersion);
  const before = pipelinePublicState(input.contactId, current);

  let saved: PipelineStageRecord;
  let noOp = false;
  if (!current) {
    const inserted = await repository.insertPipeline({
      contactId: input.contactId,
      stage: input.payload.stage,
      now,
    });
    if (!inserted) {
      throw new TeamMutationFailure(
        "conflict",
        "The pipeline was created by another request. No duplicate change was saved; refresh and try again.",
        { retryable: true },
      );
    }
    saved = inserted;
  } else if (current.stage !== input.payload.stage) {
    const updatedAt = nextPipelineUpdatedAt(current.updatedAt, now);
    const updated = await repository.updatePipeline({
      contactId: input.contactId,
      stage: input.payload.stage,
      previousUpdatedAt: current.updatedAt,
      updatedAt,
    });
    if (!updated) {
      throw new TeamMutationFailure(
        "conflict",
        "The pipeline changed during this update. No linked changes were saved; refresh and try again.",
        { retryable: true },
      );
    }
    saved = updated;
  } else {
    saved = current;
    noOp = input.payload.notes === null;
  }

  const noteTaskId = input.payload.notes
    ? await repository.insertNote({
        contactId: input.contactId,
        notes: input.payload.notes,
      })
    : null;
  if (input.payload.notes && !noteTaskId) {
    throw new TeamMutationFailure(
      "internal",
      "The pipeline note could not be committed, so the stage change was rolled back.",
      { retryable: true },
    );
  }

  const closedSalesTaskCount = closesSalesHqTasks(input.payload.stage)
    ? await repository.closeSalesHqTasks({
        contactId: input.contactId,
        updatedAt: now,
      })
    : 0;

  return {
    before,
    pipeline: pipelinePublicState(input.contactId, saved),
    noteTaskId,
    closedSalesTaskCount,
    noOp: noOp && closedSalesTaskCount === 0,
  };
}

export type PipelineStageTransactionRunner = <Result>(
  work: (tx: TeamMutationTransaction) => Promise<Result>,
) => Promise<Result>;

export function runPipelineStageMutationAtomic<Result>(
  runTransaction: PipelineStageTransactionRunner,
  work: (tx: TeamMutationTransaction) => Promise<Result>,
): Promise<Result> {
  return runTransaction(work);
}
