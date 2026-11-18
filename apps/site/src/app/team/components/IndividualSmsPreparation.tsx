"use client";
import { useRef, useState } from "react";
import { TEAM_CARD_PADDED, TEAM_INPUT, teamButtonClass } from "./team-ui";

type ImportRecord = {
  contactId: string;
  body: string;
  sourceReference: string;
};
type Report = {
  campaignId: string;
  rows: number;
  valid: boolean;
  wouldImport: number;
  unchanged: number;
  reviewHash: string;
  issues: { row: number; code: string; detail: string }[];
};
type Qualification = {
  version: number;
  qualification: string;
  facebook_status: string;
  holds: string[];
  external_last_activity_at: string | null;
  evidence_reference: string;
};
const field = `${TEAM_INPUT} min-w-0 w-full max-w-full`;

export function IndividualSmsPreparation({
  campaignId,
  onImported,
}: {
  campaignId: string;
  onImported: () => Promise<void>;
}) {
  const [file, setFile] = useState<{
    records: ImportRecord[];
    sourceHash: string;
  } | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [contactId, setContactId] = useState("");
  const [loadedId, setLoadedId] = useState("");
  const [version, setVersion] = useState(0);
  const [qualification, setQualification] = useState("unverified");
  const [facebookStatus, setFacebookStatus] = useState("uncertain");
  const [holds, setHolds] = useState("");
  const [activity, setActivity] = useState("");
  const [evidence, setEvidence] = useState("");
  const [attested, setAttested] = useState(false);
  const request = useRef<{ body: string; key: string } | null>(null);
  async function post(operation: string, value: unknown) {
    const body = JSON.stringify(value);
    if (request.current?.body !== body)
      request.current = { body, key: crypto.randomUUID() };
    const response = await fetch(`/api/team/sms-campaigns/${operation}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": request.current.key,
      },
      body,
    });
    const result = (await response.json()) as {
      data?: unknown;
      error?: string;
      message?: string;
    };
    if (!response.ok)
      throw new Error(result.message ?? result.error ?? "Request failed");
    request.current = null;
    return result.data;
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className={`${TEAM_CARD_PADDED} min-w-0 space-y-6 break-words`}
      aria-busy={busy}
    >
      <div className="space-y-3">
        <h2 className="text-lg font-semibold">
          Import reviewed individual drafts
        </h2>
        <p className="min-w-0 text-sm">
          Choose the prepared JSON file containing exact CRM contact IDs and
          saved wording. Review the dry run before importing. Importing never
          sends a text or grants permission to contact someone.
        </p>
        <input
          type="file"
          className="min-w-0 w-full max-w-full text-sm"
          accept="application/json,.json"
          disabled={busy}
          aria-label="Reviewed drafts JSON file"
          onChange={(event) => {
            const chosen = event.target.files?.[0];
            setFile(null);
            setReport(null);
            if (!chosen) return;
            void run(async () => {
              if (chosen.size > 1024 * 1024)
                throw new Error("Choose a JSON file smaller than 1 MB.");
              const raw = await chosen.text();
              const parsed = JSON.parse(raw) as { records?: ImportRecord[] };
              if (!Array.isArray(parsed.records))
                throw new Error("Prepared file must contain a records array.");
              const digest = await crypto.subtle.digest(
                "SHA-256",
                new TextEncoder().encode(raw),
              );
              const sourceHash = Array.from(new Uint8Array(digest))
                .map((byte) => byte.toString(16).padStart(2, "0"))
                .join("");
              setFile({ records: parsed.records, sourceHash });
              setMessage(
                `${parsed.records.length} draft rows loaded locally. Run the dry run to check them against the CRM.`,
              );
            });
          }}
        />
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            disabled={busy || !file}
            className={teamButtonClass()}
            onClick={() =>
              void run(async () => {
                const result = (await post("drafts", {
                  action: "dry_run",
                  campaignId,
                  ...file,
                })) as Report;
                setReport(result);
                setMessage("Dry run complete. No drafts were imported.");
              })
            }
          >
            Run dry run
          </button>
          <button
            type="button"
            disabled={
              busy ||
              !file ||
              !report?.valid ||
              report.campaignId !== campaignId
            }
            className={teamButtonClass("primary")}
            onClick={() =>
              void run(async () => {
                await post("drafts", {
                  action: "import",
                  campaignId,
                  ...file,
                  reviewHash: report!.reviewHash,
                });
                setReport(null);
                setMessage("Reviewed drafts imported. Nothing has been sent.");
                await onImported();
              })
            }
          >
            Import reviewed file
          </button>
        </div>
        {report && (
          <div className="rounded-xl border p-4 text-sm">
            <p>
              {report.rows} rows · {report.wouldImport} new versions ·{" "}
              {report.unchanged} unchanged · {report.issues.length} issues
            </p>
            {!!report.issues.length && (
              <ul className="mt-2 max-h-72 overflow-auto">
                {report.issues.map((issue, n) => (
                  <li key={n}>
                    Row {issue.row}: {issue.detail}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <details>
        <summary className="cursor-pointer font-semibold">
          Review a contact’s history and exclusions
        </summary>
        <p className="mt-3 text-sm">
          Reference evidence stored securely outside Stonegate. Review Facebook
          and external messages within 24 hours of delivery. Promotional consent
          is recorded separately below; a past inquiry alone does not grant it.
        </p>
        <div className="mt-4 flex flex-wrap gap-3">
          <label className="min-w-0 flex-1 text-sm">
            Exact CRM contact ID
            <input
              className={field}
              value={contactId}
              onChange={(e) => {
                setContactId(e.target.value);
                setAttested(false);
              }}
            />
          </label>
          <button
            className={teamButtonClass()}
            type="button"
            disabled={busy || !contactId}
            onClick={() =>
              void run(async () => {
                const response = await fetch(
                  `/api/team/sms-campaigns/qualification?contactId=${encodeURIComponent(contactId)}`,
                  { cache: "no-store" },
                );
                if (!response.ok)
                  throw new Error(
                    "Unable to load that exact contact’s review.",
                  );
                const { qualification: q } = (await response.json()) as {
                  qualification: Qualification | null;
                };
                setLoadedId(contactId);
                setVersion(q?.version ?? 0);
                setQualification(q?.qualification ?? "unverified");
                setFacebookStatus(q?.facebook_status ?? "uncertain");
                setHolds(q?.holds.join("\n") ?? "");
                setEvidence(q?.evidence_reference ?? "");
                setActivity(q?.external_last_activity_at ?? "");
                setAttested(false);
              })
            }
          >
            Load review
          </button>
        </div>
        {loadedId === contactId && loadedId && (
          <form
            className="mt-4 grid gap-3 sm:grid-cols-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                const result = (await post("qualification", {
                  contactId,
                  expectedVersion: version,
                  qualification,
                  facebookStatus,
                  holds: holds
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                  externalLastActivityAt: activity.trim()
                    ? new Date(activity).toISOString()
                    : null,
                  evidenceReference: evidence,
                  reviewedAt: new Date().toISOString(),
                })) as { version: number };
                setVersion(result.version);
                setAttested(false);
                setMessage(
                  "History review saved. The send preview will recheck consent, holds and recent activity.",
                );
              });
            }}
          >
            <label className="min-w-0 text-sm">
              Relationship
              <select
                aria-label="Relationship"
                className={field}
                value={qualification}
                onChange={(e) => setQualification(e.target.value)}
              >
                <option value="unverified">Unverified — hold</option>
                <option value="prior_inquiry">Legitimate past inquiry</option>
                <option value="quote_only">Quote-only prospect</option>
                <option value="past_customer">Past customer</option>
              </select>
            </label>
            <label className="min-w-0 text-sm">
              Facebook outreach
              <select
                aria-label="Facebook outreach"
                className={field}
                value={facebookStatus}
                onChange={(e) => setFacebookStatus(e.target.value)}
              >
                <option value="uncertain">Uncertain — hold</option>
                <option value="excluded">Excluded — hold</option>
                <option value="clear">Reviewed, no overlap</option>
              </select>
            </label>
            <label className="min-w-0 text-sm sm:col-span-2">
              Identity or service holds (one per line)
              <textarea
                className={field}
                value={holds}
                onChange={(e) => setHolds(e.target.value)}
              />
            </label>
            <label className="min-w-0 text-sm">
              Last external activity (ISO date/time; blank only if none)
              <input
                className={field}
                value={activity}
                onChange={(e) => setActivity(e.target.value)}
                placeholder="2026-10-01T15:00:00Z"
              />
            </label>
            <label className="min-w-0 text-sm">
              Secure evidence reference
              <input
                required
                minLength={10}
                maxLength={1000}
                className={field}
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
              />
            </label>
            <label className="flex items-start gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                required
                checked={attested}
                onChange={(e) => setAttested(e.target.checked)}
              />
              I reviewed the referenced evidence, external activity and
              exclusions just now. The entries above accurately reflect that
              review.
            </label>
            <button disabled={busy || !attested} className={teamButtonClass()}>
              Save owner review
            </button>
          </form>
        )}
      </details>
      {message && (
        <p role="status" className="min-w-0 text-sm">
          {message}
        </p>
      )}
    </section>
  );
}
