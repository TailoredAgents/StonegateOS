import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";

// File preparation only: no database, connector, provider or network access.
const args = process.argv.slice(2);
function option(flag: string) {
  const at = args.indexOf(flag);
  const value = at >= 0 ? args[at + 1] : undefined;
  if (!value || value.startsWith("--")) throw new Error(`Required: ${flag}`);
  return path.resolve(value);
}
const draftsPath = option("--drafts"),
  scopePath = option("--scope"),
  outputPath = option("--output");
if ([draftsPath, scopePath].includes(outputPath))
  throw new Error("Output must not overwrite a source file.");
const [rawDrafts, rawScope] = await Promise.all([
  readFile(draftsPath, "utf8"),
  readFile(scopePath, "utf8"),
]);
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const scope = z
  .object({
    count: z.number().int().positive(),
    contact_ids: z.array(z.string().uuid()),
    external_evidence_reviewed: z.boolean().optional(),
  })
  .passthrough()
  .parse(JSON.parse(rawScope));
const source = z
  .object({
    records: z.array(
      z
        .object({
          contact_id: z.string().uuid(),
          draft_body: z.string().nullable().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough()
  .parse(JSON.parse(rawDrafts));
if (
  scope.count !== 1318 ||
  scope.contact_ids.length !== scope.count ||
  new Set(scope.contact_ids).size !== scope.count
)
  throw new Error("Expected exactly 1,318 distinct selected CRM contact IDs.");
const selected = new Set(scope.contact_ids);
const issues: { contactId: string; reason: string }[] = [];
const records = scope.contact_ids.flatMap((contactId) => {
  const matches = source.records.filter((r) => r.contact_id === contactId);
  if (matches.length !== 1) {
    issues.push({
      contactId,
      reason: `Expected one source draft; found ${matches.length}.`,
    });
    return [];
  }
  const body = matches[0]!.draft_body;
  if (!body || !body.trim() || body.length > 1600) {
    issues.push({
      contactId,
      reason:
        "Missing/withheld reviewed text. Older wording was not substituted.",
    });
    return [];
  }
  const percentages = [
    ...body.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:%|percent)/gi),
  ].map((m) => Number(m[1]));
  if (!percentages.includes(30) || percentages.some((p) => p !== 30)) {
    issues.push({
      contactId,
      reason:
        "Conflicting or missing 30% offer wording. Source was not changed.",
    });
    return [];
  }
  return [
    {
      contactId,
      body,
      sourceReference: `${path.basename(draftsPath)}#contact_id=${contactId};sha256=${sha(rawDrafts)}`,
    },
  ];
});
if (issues.length) {
  const report = {
    selected: scope.count,
    validDrafts: records.length,
    blocked: issues.length,
    draftSourceSha256: sha(rawDrafts),
    scopeSourceSha256: sha(rawScope),
    imported: 0,
    sent: 0,
    issues,
  };
  await writeFile(
    outputPath + ".blocked.json",
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx", mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      selected: scope.count,
      validDrafts: records.length,
      blocked: issues.length,
      imported: 0,
      sent: 0,
      report: outputPath + ".blocked.json",
    }),
  );
  process.exit(2);
}
const output = { records };
const rawOutput = JSON.stringify(output, null, 2) + "\n";
if (Buffer.byteLength(rawOutput) > 1024 * 1024)
  throw new Error("Prepared file exceeds the owner import's 1 MB limit.");
await writeFile(outputPath, rawOutput, { flag: "wx", mode: 0o600 });
const manifest = {
  preparedAt: new Date().toISOString(),
  rows: records.length,
  exactWordingPreserved: true,
  footerAppended: false,
  offerPercent: 30,
  draftSourceSha256: sha(rawDrafts),
  scopeSourceSha256: sha(rawScope),
  preparedSha256: sha(rawOutput),
  excludedSourceRecords: source.records.filter(
    (r) => !selected.has(r.contact_id),
  ).length,
  sourceExternalEvidenceReviewed: scope.external_evidence_reviewed ?? null,
  imported: 0,
  sent: 0,
  note: "Recipient scope is not a consent grant or eligibility clearance. Owner must review the server dry run and separately record evidence, Facebook exclusions, service/identity holds and recent external activity.",
};
await writeFile(
  outputPath + ".manifest.json",
  JSON.stringify(manifest, null, 2) + "\n",
  { flag: "wx", mode: 0o600 },
);
console.log(JSON.stringify(manifest, null, 2));
