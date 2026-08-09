"use client";

import { useRouter } from "next/navigation";
import { TEAM_TIME_ZONE } from "../lib/timezone";
import type { PipelineMovementState } from "../pipeline-presets";
import { labelForPipelineStage } from "./pipeline.stages";
import { teamButtonClass } from "./team-ui";

function formatMovementTime(iso: string): string {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: TEAM_TIME_ZONE,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(value);
}

export function PipelineMovementEvidence({
  state,
}: {
  state: PipelineMovementState;
}): React.ReactElement {
  const router = useRouter();

  return (
    <section
      className="mt-4 rounded-2xl border border-[color:var(--team-border)] bg-[color:var(--team-surface-muted)] p-4"
      aria-labelledby="pipeline-movement-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3
            id="pipeline-movement-heading"
            className="text-sm font-semibold text-[color:var(--team-text)]"
          >
            Recent stage movement
          </h3>
          <p className="mt-1 text-xs text-[color:var(--team-text-muted)]">
            Who moved this contact, when, and which workflow recorded it.
          </p>
        </div>
        {state.status === "error" ? (
          <button
            type="button"
            className={`${teamButtonClass("secondary", "sm")} min-h-11`}
            onClick={() => router.refresh()}
          >
            Retry
          </button>
        ) : null}
      </div>

      {state.status === "error" ? (
        <p
          className="mt-3 rounded-xl border border-[color:var(--team-danger-border)] bg-[color:var(--team-danger-surface)] p-3 text-xs font-semibold text-[color:var(--team-danger-text)]"
          role="alert"
        >
          {state.message}
        </p>
      ) : state.movements.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-[color:var(--team-border)] p-3 text-xs text-[color:var(--team-text-muted)]">
          No stage movement has been recorded for this contact yet.
        </p>
      ) : (
        <ol className="mt-3 space-y-2">
          {state.movements.map((movement) => (
            <li
              key={movement.id}
              className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-card)] p-3"
            >
              <div className="flex flex-wrap items-center gap-2 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--team-text-soft)]">
                <span>{movement.actorLabel}</span>
                <span aria-hidden="true">·</span>
                <span>{movement.sourceLabel}</span>
              </div>
              <p className="mt-1 text-sm font-semibold text-[color:var(--team-text)]">
                {movement.fromStage
                  ? labelForPipelineStage(movement.fromStage)
                  : "Not set"}
                {" → "}
                {labelForPipelineStage(movement.toStage)}
              </p>
              <time
                dateTime={movement.occurredAt}
                className="mt-1 block text-xs text-[color:var(--team-text-muted)]"
              >
                {formatMovementTime(movement.occurredAt)}
              </time>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
