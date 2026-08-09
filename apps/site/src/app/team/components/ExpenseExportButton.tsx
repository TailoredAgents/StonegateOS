"use client";

import React, { useState } from "react";
import { teamButtonClass } from "./team-ui";

type ExportState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "success"; message: string };

function filenameFromDisposition(value: string | null): string {
  const match = value?.match(/filename="?([^";]+)"?/iu);
  const filename = match?.[1]?.trim() ?? "stonegate-expenses.csv";
  return /^[A-Za-z0-9._-]{1,120}$/u.test(filename)
    ? filename
    : "stonegate-expenses.csv";
}

async function exportErrorMessage(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as {
    message?: unknown;
  } | null;
  if (typeof body?.message === "string" && body.message.trim()) {
    return body.message.trim();
  }
  if (response.status === 401) return "Your session expired. Sign in again.";
  if (response.status === 403) {
    return "You do not have permission to export expenses.";
  }
  if (response.status === 422) {
    return "The export filters are invalid. Reset them and try again.";
  }
  return `The export failed (HTTP ${response.status}). No file was downloaded.`;
}

export function ExpenseExportButton({
  href,
}: {
  href: string;
}): React.ReactElement {
  const [state, setState] = useState<ExportState>({ status: "idle" });

  async function download(): Promise<void> {
    if (state.status === "loading") return;
    setState({ status: "loading" });
    try {
      const response = await fetch(href, {
        method: "GET",
        credentials: "same-origin",
        headers: { Accept: "text/csv" },
        cache: "no-store",
      });
      if (!response.ok) {
        setState({
          status: "error",
          message: await exportErrorMessage(response),
        });
        return;
      }
      const contentType = response.headers.get("content-type") ?? "";
      const auditCorrelationId =
        response.headers.get("x-audit-correlation-id") ?? "";
      if (
        !contentType.toLowerCase().startsWith("text/csv") ||
        response.headers.get("x-export-truncated") !== "false" ||
        !/^[A-Za-z0-9._:-]{1,160}$/u.test(auditCorrelationId)
      ) {
        setState({
          status: "error",
          message:
            "The export service returned an invalid file receipt. No file was downloaded.",
        });
        return;
      }
      const blob = await response.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = filenameFromDisposition(
        response.headers.get("content-disposition"),
      );
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      const rows = response.headers.get("x-export-row-count");
      setState({
        status: "success",
        message: `Expense CSV downloaded${rows ? ` (${rows} rows)` : ""}.`,
      });
    } catch {
      setState({
        status: "error",
        message:
          "The expense service could not be reached. No file was downloaded.",
      });
    }
  }

  return (
    <div className="flex flex-col items-start gap-1">
      <button
        type="button"
        className={teamButtonClass("secondary", "sm")}
        disabled={state.status === "loading"}
        onClick={() => void download()}
      >
        {state.status === "loading" ? "Preparing CSV…" : "Export filtered CSV"}
      </button>
      <span className="max-w-md text-[11px] text-slate-500">
        Maximum 5,000 rows. Narrow the ledger filters if the export is larger.
      </span>
      {state.status === "error" ? (
        <span className="max-w-md text-xs text-rose-700" role="alert">
          {state.message}
        </span>
      ) : state.status === "success" ? (
        <span className="text-xs text-emerald-700" role="status">
          {state.message}
        </span>
      ) : null}
    </div>
  );
}
