import { readdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";

// Produces a separate handoff manifest. Never rewrites the active review files,
// imports customer summaries as authoritative facts, merges or sends messages.
const folder = resolve(process.argv[2] ?? "");
if (!process.argv[2]) throw new Error("Pass the Facebook outreach folder");
const files = (await readdir(folder))
  .filter((f) => /^review-checkpoint(?:-\d+)?\.json$/.test(f))
  .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
const records = new Map(),
  sources = [];
for (const file of files) {
  const raw = await readFile(join(folder, file), "utf8");
  const checkpoint = JSON.parse(raw.replace(/^\uFEFF/, ""));
  sources.push({
    file,
    sha256: createHash("sha256").update(raw).digest("hex"),
  });
  for (const record of checkpoint.records ?? []) {
    const key = String(
      record.id ??
        createHash("sha256").update(JSON.stringify(record)).digest("hex"),
    );
    const current = records.get(key) ?? {
      sourceRecordId: key,
      identityVerified: false,
      observations: [],
    };
    current.observations.push({ file, ...record });
    records.set(key, current);
  }
}
const manifest = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  sources,
  records: [...records.values()],
  instructions:
    "Checkpoint IDs are source references until verified as provider identities. Match exact observed phone/email using Stonegate match_contact; name-only matches require review. Query records and Gmail to resolve off-channel history. This manifest does not authorize any outreach or establish consent.",
};
await writeFile(
  join(folder, "stonegate-cross-reference-manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    files: sources.length,
    uniqueSourceRecords: records.size,
    output: "stonegate-cross-reference-manifest.json",
  }),
);
