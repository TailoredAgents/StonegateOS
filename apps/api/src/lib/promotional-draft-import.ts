import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { smsCampaigns } from "@/db";
import {
  TeamMutationFailure,
  type TeamMutationTransaction,
} from "./team-mutation";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const DraftImportRowSchema = z
  .object({
    contactId: z.string().uuid(),
    body: z.string().min(1).max(1600),
    sourceReference: z.string().min(3).max(1000),
  })
  .strict();
export const DraftImportSchema = z
  .object({
    action: z.enum(["dry_run", "import"]),
    campaignId: z.string().uuid(),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    records: z.array(z.unknown()).min(1).max(2000),
    reviewHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  .strict();

/** Immutable imports are all-or-nothing; the same content never creates a new version. */
export async function importPromotionalDrafts(
  tx: TeamMutationTransaction,
  ownerId: string,
  input: z.infer<typeof DraftImportSchema>,
) {
  const [campaign] = await tx
    .select()
    .from(smsCampaigns)
    .where(eq(smsCampaigns.id, input.campaignId))
    .for("update");
  if (
    !campaign ||
    campaign.terms.deliveryMode !== "individual_drafts" ||
    campaign.terms.discountBasisPoints !== 3000
  )
    throw new TeamMutationFailure(
      "invalid",
      "Choose a 30% individual-draft campaign.",
    );
  if (["completed", "cancelled"].includes(campaign.status))
    throw new TeamMutationFailure("conflict", "The campaign has ended.");
  const issues: { row: number; code: string; detail: string }[] = [];
  const seen = new Set<string>();
  const records: (z.infer<typeof DraftImportRowSchema> & {
    bodyHash: string;
    row: number;
  })[] = [];
  input.records.forEach((row, index) => {
    const parsed = DraftImportRowSchema.safeParse(row);
    if (!parsed.success) {
      issues.push({
        row: index + 1,
        code: "invalid_record",
        detail: parsed.error.issues
          .map((e) => `${e.path.join(".")}: ${e.message}`)
          .join("; "),
      });
      return;
    }
    const record = parsed.data;
    if (seen.has(record.contactId))
      issues.push({
        row: index + 1,
        code: "duplicate_contact_id",
        detail: "Exactly one draft per contact is allowed in an import.",
      });
    seen.add(record.contactId);
    const percentages = [
      ...record.body.matchAll(/\b(\d+(?:\.\d+)?)\s*(?:%|percent)/gi),
    ].map((m) => Number(m[1]));
    if (!percentages.includes(30) || percentages.some((p) => p !== 30))
      issues.push({
        row: index + 1,
        code: "offer_copy_mismatch",
        detail:
          "This offer is 30%; conflicting or missing discount wording requires a new reviewed draft.",
      });
    records.push({ ...record, bodyHash: digest(record.body), row: index + 1 });
  });
  const inventory = records.length
    ? await tx.execute<{
        contactId: string;
        active: boolean;
        latestVersion: number;
        existingDraftId: string | null;
        existingVersion: number | null;
        alreadyReleased: boolean;
      }>(sql`
    select x."contactId", (c.id is not null and c.deleted_at is null and c.merged_into_contact_snapshot_id is null) active,
      coalesce((select max(v.version) from sms_campaign_drafts v where v.campaign_id=${campaign.id}::uuid and v.contact_id=c.id),0)::int "latestVersion",
      (select v.id from sms_campaign_drafts v where v.campaign_id=${campaign.id}::uuid and v.contact_id=c.id and v.body_hash=x."bodyHash") "existingDraftId",
      (select v.version from sms_campaign_drafts v where v.campaign_id=${campaign.id}::uuid and v.contact_id=c.id and v.body_hash=x."bodyHash") "existingVersion",
      exists(select 1 from sms_campaign_recipients r where r.campaign_id=${campaign.id}::uuid and r.contact_id=c.id and r.is_test=false) "alreadyReleased"
    from jsonb_to_recordset(${JSON.stringify(records)}::jsonb) as x("contactId" uuid,"bodyHash" text) left join contacts c on c.id=x."contactId"`)
    : [];
  for (const record of records) {
    const state = inventory.find((x) => x.contactId === record.contactId);
    if (!state?.active)
      issues.push({
        row: record.row,
        code: "contact_unavailable",
        detail:
          "Exact CRM contact ID is missing, deleted or merged. No contact will be created or matched by name.",
      });
    if (state?.existingVersion && state.existingVersion !== state.latestVersion)
      issues.push({
        row: record.row,
        code: "superseded_draft",
        detail:
          "This wording belongs to an older version. Review the latest saved draft before importing.",
      });
    if (state?.alreadyReleased && !state.existingDraftId)
      issues.push({
        row: record.row,
        code: "recipient_already_released",
        detail:
          "This campaign already released a message for this contact; a replacement draft cannot authorize another send.",
      });
  }
  const results = records.map((r) => {
    const state = inventory.find((x) => x.contactId === r.contactId);
    return {
      contactId: r.contactId,
      bodyHash: r.bodyHash,
      existingDraftId: state?.existingDraftId ?? null,
      version: state?.existingVersion ?? (state?.latestVersion ?? 0) + 1,
      unchanged: !!state?.existingDraftId,
    };
  });
  const reviewHash = digest(
    JSON.stringify({
      campaignId: campaign.id,
      campaignVersion: campaign.version,
      sourceHash: input.sourceHash,
      records,
      results,
      issues,
    }),
  );
  const report = {
    dryRun: input.action === "dry_run",
    campaignId: campaign.id,
    sourceHash: input.sourceHash,
    reviewHash,
    rows: input.records.length,
    valid: issues.length === 0,
    issues,
    unchanged: results.filter((r) => r.unchanged).length,
    wouldImport: results.filter((r) => !r.unchanged).length,
    results,
    sent: 0,
  };
  if (input.action === "dry_run") return report;
  if (issues.length)
    throw new TeamMutationFailure(
      "invalid",
      "The dry-run report contains blockers; nothing was imported.",
    );
  if (!input.reviewHash || input.reviewHash !== reviewHash)
    throw new TeamMutationFailure(
      "conflict",
      "Run and review the dry-run report for this exact file and current CRM state before importing.",
    );
  const newRecords = records
    .filter((r) => !results.find((x) => x.contactId === r.contactId)?.unchanged)
    .map((r) => ({
      ...r,
      version: results.find((x) => x.contactId === r.contactId)!.version,
    }));
  if (newRecords.length)
    await tx.execute(sql`insert into sms_campaign_drafts(campaign_id,contact_id,version,body,body_hash,source_reference,source_hash,imported_by)
    select ${campaign.id}::uuid,x."contactId",x.version,x.body,x."bodyHash",x."sourceReference",${input.sourceHash},${ownerId}::uuid
    from jsonb_to_recordset(${JSON.stringify(newRecords)}::jsonb) as x("contactId" uuid,version integer,body text,"bodyHash" text,"sourceReference" text)`);
  const saved = await tx.execute<{
    id: string;
    contact_id: string;
    version: number;
    body_hash: string;
  }>(
    sql`select d.id,d.contact_id,d.version,d.body_hash from sms_campaign_drafts d join jsonb_to_recordset(${JSON.stringify(records)}::jsonb) x("contactId" uuid,"bodyHash" text) on x."contactId"=d.contact_id and x."bodyHash"=d.body_hash where d.campaign_id=${campaign.id}::uuid order by d.contact_id`,
  );
  return { ...report, imported: newRecords.length, saved };
}
