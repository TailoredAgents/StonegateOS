import { createHash } from "node:crypto";
import { and, eq, ilike, inArray, isNotNull, or, sql } from "drizzle-orm";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import {
  contacts,
  crmPipeline,
  crmTasks,
  partnerAccounts,
  teamMembers,
  teamRoles,
} from "@/db";
import type { getDb } from "@/db";
import {
  buildOutboundImportExclusionReport,
  classifyOutboundExistingIdentity,
  countOutboundImportRows,
  expectedOutboundImportConfirmation,
  hashOutboundImportPreview,
  type ExistingIdentityCandidate,
  type NormalizedOutboundImportRow,
  type OutboundImportCounts,
  type OutboundImportExclusionReport,
  type OutboundImportPlannedChange,
  type OutboundImportPublicRow,
  type ParsedOutboundImport,
} from "@/lib/outbound-import";
import {
  computeEffectivePermissions,
  permissionMatches,
} from "@/lib/permissions";
import {
  normalizePartnerAccountDomain,
  normalizePartnerAccountName,
  resolveOrCreatePartnerAccount,
} from "@/lib/partner-accounts";
import { getSalesScorecardConfig } from "@/lib/sales-scorecard";
import { TeamMutationFailure } from "@/lib/team-mutation";

type DatabaseClient = ReturnType<typeof getDb>;
type TransactionExecutor = Parameters<
  DatabaseClient["transaction"]
>[0] extends (tx: infer Tx) => Promise<unknown>
  ? Tx
  : never;
type DbExecutor = DatabaseClient | TransactionExecutor;

type ExistingContact = ExistingIdentityCandidate & {
  firstName: string;
  lastName: string;
  company: string | null;
  email: string | null;
  phone: string | null;
  source: string | null;
  salespersonMemberId: string | null;
  partnerAccountId: string | null;
  partnerStatus: string;
  partnerOwnerMemberId: string | null;
  doNotContact: boolean;
};

type PlannedImportRow = {
  source: NormalizedOutboundImportRow;
  publicRow: OutboundImportPublicRow;
  existing: ExistingContact | null;
  needsPipeline: boolean;
  needsOutboundTask: boolean;
  needsOutboundTaskUpdate: boolean;
  closesOutboundTask: boolean;
  existingOutboundTask: {
    id: string;
    title: string;
    dueAt: Date | null;
    notes: string;
  } | null;
  needsContactNote: boolean;
  needsPartnerAccount: boolean;
};

export type OutboundImportAssignee = {
  id: string;
  name: string;
};

export type OutboundImportPreview = {
  kind: "outbound_import_preview";
  requestHash: string;
  previewHash: string;
  campaign: string;
  assignee: OutboundImportAssignee;
  byteLength: number;
  ignoredHeaders: string[];
  counts: OutboundImportCounts;
  confirmationPhrase: string;
  rows: OutboundImportPublicRow[];
  exclusionReport: OutboundImportExclusionReport;
};

export type PreparedOutboundImportPreview = {
  preview: OutboundImportPreview;
  plans: PlannedImportRow[];
};

export type OutboundImportExecution = {
  kind: "outbound_import_result";
  requestHash: string;
  previewHash: string;
  campaign: string;
  assignee: OutboundImportAssignee;
  counts: OutboundImportCounts & {
    rowsUpdated: number;
    contactsCreated: number;
    contactsModified: number;
    partnerAccountsResolved: number;
    partnerLinksCreated: number;
    contactNotesCreated: number;
    tasksCreated: number;
    tasksUpdated: number;
    pipelineRowsCreated: number;
  };
  exclusionReport: OutboundImportExclusionReport;
};

function normalizedExistingEmail(value: string | null): string | null {
  const normalized = value?.trim().toLowerCase() ?? "";
  return normalized || null;
}

function normalizedExistingPhone(
  e164: string | null,
  phone: string | null,
): string | null {
  for (const candidate of [e164, phone]) {
    const value = candidate?.trim() ?? "";
    if (!value) continue;
    if (/^\+[1-9][0-9]{9,14}$/u.test(value)) return value;
    const parsed = parsePhoneNumberFromString(value, "US");
    if (parsed?.isValid()) return parsed.number;
  }
  return null;
}

function addMatch(
  map: Map<string, ExistingContact[]>,
  key: string | null,
  contact: ExistingContact,
): void {
  if (!key) return;
  const matches = map.get(key) ?? [];
  matches.push(contact);
  map.set(key, matches);
}

function splitName(
  input: string | null,
): { firstName: string; lastName: string } | null {
  const cleaned = input?.replace(/\s+/gu, " ").trim() ?? "";
  if (!cleaned) return null;
  const parts = cleaned.split(" ");
  if (parts.length === 1) {
    return { firstName: parts[0] ?? "Contact", lastName: "PM" };
  }
  return {
    firstName: parts[0] ?? "Contact",
    lastName: parts.slice(1).join(" ").trim() || "PM",
  };
}

function slugText(value: string | null): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim();
}

export function classifyOutboundSegment(input: {
  row: NormalizedOutboundImportRow;
}): { segment: string | null; subsegment: string | null } {
  const importedIndustry = slugText(input.row.industry);
  // An explicit per-row industry is authoritative. Other row text is only a
  // fallback for files that omit the industry column/value.
  const haystack =
    importedIndustry ||
    slugText(
      [input.row.company, input.row.title, input.row.notes]
        .filter(Boolean)
        .join(" "),
    );
  if (
    /(property manager|property management|community manager|apartment|multifamily|leasing)/u.test(
      haystack,
    )
  ) {
    return {
      segment: "property_manager",
      subsegment: /apartment|multifamily|community/u.test(haystack)
        ? "multifamily"
        : "property_management",
    };
  }
  if (/(realtor|real estate|broker|listing agent|agent\b)/u.test(haystack)) {
    return {
      segment: "real_estate_agent",
      subsegment: /broker/u.test(haystack) ? "brokerage" : "residential_agent",
    };
  }
  if (/(estate|probate|senior move|downsizing|organizer)/u.test(haystack)) {
    return {
      segment: "estate_cleanout",
      subsegment: /senior move|downsizing/u.test(haystack)
        ? "senior_transition"
        : "estate_cleanout",
    };
  }
  if (/(investor|flipper|flip|wholesale|wholesaler)/u.test(haystack)) {
    return { segment: "investor_flipper", subsegment: "residential_investor" };
  }
  if (
    /(contractor|construction|remodel|renovation|roofing|plumbing|restoration)/u.test(
      haystack,
    )
  ) {
    return { segment: "contractor", subsegment: "trade_contractor" };
  }
  if (/(storage|facility manager|self storage)/u.test(haystack)) {
    return { segment: "storage_facility", subsegment: "facility_manager" };
  }
  if (/(junk|haul|cleanout|removal)/u.test(haystack)) {
    return { segment: "cleanout_referral", subsegment: "general_referral" };
  }
  const importedIndustrySegment = importedIndustry
    .replace(/\s+/gu, "_")
    .slice(0, 80);
  if (importedIndustrySegment) {
    return {
      segment: importedIndustrySegment,
      subsegment: "imported_industry",
    };
  }
  return { segment: null, subsegment: null };
}

function chooseOutboundTaskTitle(segment: string | null): string {
  switch (segment) {
    case "property_manager":
      return "Outbound: Call property manager";
    case "real_estate_agent":
      return "Outbound: Call realtor";
    case "estate_cleanout":
      return "Outbound: Call estate partner";
    case "investor_flipper":
      return "Outbound: Call investor";
    case "contractor":
      return "Outbound: Call contractor";
    case "storage_facility":
      return "Outbound: Call facility manager";
    default:
      return "Outbound: Call referral partner";
  }
}

function outboundTaskNotes(input: {
  campaign: string;
  company: string | null;
  notes: string | null;
  priority: string | null;
  emailStatus: string | null;
  importedStatus: string | null;
}): string {
  const lines = [
    "[outbound]",
    "kind=outbound",
    `campaign=${input.campaign}`,
    "attempt=1",
  ];
  if (input.company) lines.push(`company=${input.company}`);
  if (input.priority) lines.push(`priority=${input.priority}`);
  if (input.emailStatus) lines.push(`emailStatus=${input.emailStatus}`);
  if (input.importedStatus)
    lines.push(`importedStatus=${input.importedStatus}`);
  if (input.notes) lines.push(`notes=${input.notes}`);
  return lines.join("\n");
}

function upsertTaskNoteField(
  notes: string,
  key: string,
  value: string,
): string {
  const line = `${key}=${value.replace(/[\r\n]+/gu, " ")}`;
  const pattern = new RegExp(`(^|\\n)${key}=[^\\n]*`, "iu");
  return pattern.test(notes)
    ? notes.replace(pattern, `$1${line}`)
    : notes.length > 0
      ? `${notes}\n${line}`
      : line;
}

export function classifyImportedAccountStatus(
  value: string | null,
): typeof partnerAccounts.$inferInsert.status | undefined {
  const token = slugText(value);
  if (!token) return undefined;
  if (
    /(not interested|not a fit|disqualified|declined|do not pursue)/u.test(
      token,
    )
  )
    return "not_a_fit";
  if (/(dormant|cold|paused|on hold)/u.test(token)) return "dormant";
  if (
    /(qualified|interested|hot lead|ready to partner|converted|partner)/u.test(
      token,
    )
  )
    return "qualified_partner";
  if (/(replied|responded|conversation|talking|connected)/u.test(token))
    return "conversation_active";
  if (/(new|uncontacted|not contacted|ready)/u.test(token))
    return "ready_for_first_touch";
  if (
    /(contacted|attempted|called|emailed|texted|no answer|voicemail|outreach)/u.test(
      token,
    )
  )
    return "attempting_contact";
  return undefined;
}

export function classifyImportedDisposition(input: {
  status: string | null;
  emailStatus: string | null;
}): string | null {
  const email = slugText(input.emailStatus);
  const status = slugText(input.status);
  if (
    /(replied|responded)/u.test(email) ||
    /(replied|responded|connected)/u.test(status)
  )
    return "connected";
  if (/(not sent|unsent|draft|pending)/u.test(email)) return null;
  if (
    /(failed|bounced|invalid|not delivered|undelivered|rejected)/u.test(email)
  )
    return "email_failed";
  if (/(sent|delivered|emailed)/u.test(email)) return "email_sent";
  if (/voicemail/u.test(status)) return "left_voicemail";
  if (/(no answer|unreachable)/u.test(status)) return "no_answer";
  if (/(not interested|not a fit|declined)/u.test(status))
    return "not_interested";
  return null;
}

function importedFollowUpAt(row: NormalizedOutboundImportRow): Date | null {
  if (!row.followUpAt) return null;
  const parsed = new Date(row.followUpAt);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function isProtectedPartnerStatus(status: string | null | undefined): boolean {
  return Boolean(
    status &&
      [
        "trial_partner",
        "active_partner",
        "portal_partner",
        "managed_partner",
        "not_a_fit",
      ].includes(status),
  );
}

function contactNoteMarker(row: NormalizedOutboundImportRow): string | null {
  const body = contactNoteBody(row);
  if (!body) return null;
  const fingerprint = createHash("sha256")
    .update(body)
    .digest("hex")
    .slice(0, 20);
  return `[outbound-import-note:${fingerprint}]`;
}

function hasImportedHistory(row: NormalizedOutboundImportRow): boolean {
  return Boolean(
    row.notes ||
      row.status ||
      row.priority ||
      row.nextAction ||
      row.followUpAt ||
      row.emailStatus ||
      row.companyExternalId ||
      row.locationExternalId ||
      row.warnings.length > 0,
  );
}

function researchNotes(row: NormalizedOutboundImportRow): string | null {
  const values = [
    row.title ? `Title: ${row.title}` : null,
    row.industry ? `Industry: ${row.industry}` : null,
    row.companySize ? `Company size: ${row.companySize}` : null,
    row.linkedinUrl ? `LinkedIn: ${row.linkedinUrl}` : null,
    row.sourceListName ? `Source list: ${row.sourceListName}` : null,
    row.companyExternalId ? `Company ID: ${row.companyExternalId}` : null,
    row.locationExternalId ? `Location ID: ${row.locationExternalId}` : null,
    row.status ? `Prior status: ${row.status}` : null,
    row.priority ? `Priority: ${row.priority}` : null,
    row.nextAction ? `Next action: ${row.nextAction}` : null,
    row.followUpAt ? `Follow-up: ${row.followUpAt}` : null,
    row.emailStatus ? `Email status: ${row.emailStatus}` : null,
    ...row.warnings.map((warning) => `Import warning: ${warning}`),
    row.notes,
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? Array.from(new Set(values)).join(" | ") : null;
}

function contactNoteBody(row: NormalizedOutboundImportRow): string | null {
  const values = [
    row.company ? `Company: ${row.company}` : null,
    row.title ? `Title: ${row.title}` : null,
    row.industry ? `Industry: ${row.industry}` : null,
    row.companySize ? `Company size: ${row.companySize}` : null,
    row.website ? `Website: ${row.website}` : null,
    row.linkedinUrl ? `LinkedIn: ${row.linkedinUrl}` : null,
    row.sourceListName ? `Source list: ${row.sourceListName}` : null,
    row.city || row.state || row.zip
      ? `Location: ${[row.city, row.state, row.zip].filter(Boolean).join(", ")}`
      : null,
    row.notes ? `Notes: ${row.notes}` : null,
    row.companyExternalId ? `Company ID: ${row.companyExternalId}` : null,
    row.locationExternalId ? `Location ID: ${row.locationExternalId}` : null,
    row.status ? `Prior status: ${row.status}` : null,
    row.priority ? `Priority: ${row.priority}` : null,
    row.nextAction ? `Next action: ${row.nextAction}` : null,
    row.followUpAt ? `Follow-up: ${row.followUpAt}` : null,
    row.emailStatus ? `Email status: ${row.emailStatus}` : null,
    ...row.warnings.map((warning) => `Import warning: ${warning}`),
  ].filter((value): value is string => Boolean(value));
  return values.length > 0 ? values.join("\n") : null;
}

function contactNote(row: NormalizedOutboundImportRow): string | null {
  const body = contactNoteBody(row);
  const marker = contactNoteMarker(row);
  return body && marker ? `${marker}\n${body}` : null;
}

function rowCanCreatePartner(row: NormalizedOutboundImportRow): boolean {
  return Boolean(
    row.company ||
      normalizePartnerAccountDomain(row.domain ?? row.website) ||
      row.companyExternalId ||
      row.locationExternalId,
  );
}

export async function resolveOutboundImportAssignee(
  db: DbExecutor,
  requestedMemberId: string | null,
): Promise<OutboundImportAssignee> {
  const config = await getSalesScorecardConfig(db);
  const memberId = requestedMemberId ?? config.defaultAssigneeMemberId;
  if (!memberId) {
    throw new TeamMutationFailure(
      "invalid",
      "Select an active outbound assignee before previewing the import.",
      { fieldErrors: { assignedToMemberId: "Choose an assignee." } },
    );
  }
  const [member] = await db
    .select({
      id: teamMembers.id,
      name: teamMembers.name,
      active: teamMembers.active,
      rolePermissions: teamRoles.permissions,
      permissionsGrant: teamMembers.permissionsGrant,
      permissionsDeny: teamMembers.permissionsDeny,
    })
    .from(teamMembers)
    .leftJoin(teamRoles, eq(teamMembers.roleId, teamRoles.id))
    .where(eq(teamMembers.id, memberId))
    .limit(1);
  const permissions = member
    ? computeEffectivePermissions({
        rolePermissions: member.rolePermissions,
        grant: member.permissionsGrant,
        deny: member.permissionsDeny,
      })
    : [];
  const eligible = permissions.some((permission) =>
    permissionMatches(permission, "outbound.write"),
  );
  if (!member || member.active !== true || !eligible) {
    throw new TeamMutationFailure(
      "invalid",
      "The selected assignee is missing, inactive, or cannot work outbound tasks.",
      {
        fieldErrors: {
          assignedToMemberId:
            "Choose an active member with Outbound write access.",
        },
      },
    );
  }
  return { id: member.id, name: member.name };
}

async function loadExistingContacts(
  db: DbExecutor,
  rows: readonly NormalizedOutboundImportRow[],
): Promise<ExistingContact[]> {
  const emails = Array.from(
    new Set(rows.map((row) => row.emailNormalized).filter(Boolean)),
  ) as string[];
  const phones = Array.from(
    new Set(rows.map((row) => row.phoneE164).filter(Boolean)),
  ) as string[];
  const filters = [];
  if (emails.length > 0) {
    filters.push(inArray(sql<string>`lower(${contacts.email})`, emails));
  }
  if (phones.length > 0) {
    const phoneDigits = Array.from(
      new Set(
        phones.flatMap((phone) => {
          const digits = phone.slice(1);
          return phone.startsWith("+1") ? [digits, digits.slice(1)] : [digits];
        }),
      ),
    );
    filters.push(inArray(contacts.phoneE164, phones));
    filters.push(inArray(contacts.phone, phones));
    filters.push(
      inArray(
        sql<string>`regexp_replace(coalesce(${contacts.phone}, ''), '[^0-9]', '', 'g')`,
        phoneDigits,
      ),
    );
  }
  if (filters.length === 0) return [];
  const found = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      lastName: contacts.lastName,
      company: contacts.company,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164,
      source: contacts.source,
      salespersonMemberId: contacts.salespersonMemberId,
      partnerAccountId: contacts.partnerAccountId,
      partnerStatus: contacts.partnerStatus,
      partnerOwnerMemberId: contacts.partnerOwnerMemberId,
      doNotContact: contacts.doNotContact,
      deletedAt: contacts.deletedAt,
    })
    .from(contacts)
    .where(or(...filters));
  return found.map((contact) => ({
    ...contact,
    emailNormalized: normalizedExistingEmail(contact.email),
    phoneE164: normalizedExistingPhone(contact.phoneE164, contact.phone),
    deleted: contact.deletedAt !== null,
  }));
}

function contactFieldChanges(
  existing: ExistingContact,
  row: NormalizedOutboundImportRow,
  assigneeMemberId: string,
): OutboundImportPlannedChange[] {
  const baseName =
    splitName(row.contactName) ??
    splitName(row.company) ??
    ({ firstName: "Property", lastName: "Manager" } as const);
  const changes: OutboundImportPlannedChange[] = [];
  if (!existing.email && row.emailNormalized) changes.push("contact.email");
  if (!existing.phoneE164 && row.phoneE164) changes.push("contact.phone");
  if (!existing.company && row.company) changes.push("contact.company");
  if (
    (!existing.firstName ||
      existing.firstName.toLowerCase() === "unknown contact") &&
    baseName.firstName
  ) {
    changes.push("contact.first_name");
  }
  if (
    (!existing.lastName || existing.lastName.toLowerCase() === "unknown") &&
    baseName.lastName
  ) {
    changes.push("contact.last_name");
  }
  if (!existing.source) changes.push("contact.source");
  if (!existing.salespersonMemberId) changes.push("contact.assignee");
  if (
    existing.partnerStatus === "none" &&
    ((existing.source ?? "").startsWith("outbound:") || !existing.source)
  ) {
    changes.push("contact.partner_status");
  }
  if (!existing.partnerOwnerMemberId && assigneeMemberId) {
    changes.push("contact.partner_owner");
  }
  return changes;
}

export async function prepareOutboundImportPreview(
  db: DbExecutor,
  parsed: ParsedOutboundImport,
  assignee: OutboundImportAssignee,
): Promise<PreparedOutboundImportPreview> {
  const candidates = parsed.rows.filter(
    (row) => row.preflightStatus === "candidate",
  );
  const existingContacts = await loadExistingContacts(db, candidates);
  const byEmail = new Map<string, ExistingContact[]>();
  const byPhone = new Map<string, ExistingContact[]>();
  for (const contact of existingContacts) {
    addMatch(byEmail, contact.emailNormalized, contact);
    addMatch(byPhone, contact.phoneE164, contact);
  }

  const initialMatches = new Map<
    number,
    { existing: ExistingContact | null; conflict: string | null }
  >();
  const matchedRowByContact = new Map<string, number>();
  for (const row of candidates) {
    const classified = classifyOutboundExistingIdentity({
      emailNormalized: row.emailNormalized,
      phoneE164: row.phoneE164,
      emailMatches: row.emailNormalized
        ? (byEmail.get(row.emailNormalized) ?? [])
        : [],
      phoneMatches: row.phoneE164 ? (byPhone.get(row.phoneE164) ?? []) : [],
    });
    if (classified.kind === "conflict") {
      initialMatches.set(row.rowNumber, {
        existing: null,
        conflict: classified.reason,
      });
      continue;
    }
    const existing =
      classified.kind === "match"
        ? (existingContacts.find(
            (contact) => contact.id === classified.contact.id,
          ) ?? null)
        : null;
    if (existing?.doNotContact) {
      initialMatches.set(row.rowNumber, {
        existing,
        conflict: "The existing contact is marked Do Not Contact.",
      });
      continue;
    }
    const duplicateExistingRow = existing
      ? matchedRowByContact.get(existing.id)
      : undefined;
    if (existing && duplicateExistingRow !== undefined) {
      initialMatches.set(row.rowNumber, {
        existing,
        conflict: `Resolves to the same existing contact as row ${duplicateExistingRow}.`,
      });
      continue;
    }
    if (existing) matchedRowByContact.set(existing.id, row.rowNumber);
    initialMatches.set(row.rowNumber, { existing, conflict: null });
  }

  const matchedIds = Array.from(
    new Set(
      Array.from(initialMatches.values())
        .filter((match) => !match.conflict && match.existing)
        .map((match) => match.existing?.id)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const matchedAccountIds = Array.from(
    new Set(
      Array.from(initialMatches.values())
        .map((match) => match.existing?.partnerAccountId)
        .filter((id): id is string => Boolean(id)),
    ),
  );
  const [pipelineRows, outboundTaskRows, importedNoteRows, matchedAccountRows] =
    await Promise.all([
      matchedIds.length > 0
        ? db
            .select({ contactId: crmPipeline.contactId })
            .from(crmPipeline)
            .where(inArray(crmPipeline.contactId, matchedIds))
        : Promise.resolve([]),
      matchedIds.length > 0
        ? db
            .select({
              id: crmTasks.id,
              contactId: crmTasks.contactId,
              title: crmTasks.title,
              dueAt: crmTasks.dueAt,
              notes: crmTasks.notes,
            })
            .from(crmTasks)
            .where(
              and(
                inArray(crmTasks.contactId, matchedIds),
                eq(crmTasks.status, "open"),
                isNotNull(crmTasks.notes),
                ilike(crmTasks.notes, "%kind=outbound%"),
              ),
            )
        : Promise.resolve([]),
      matchedIds.length > 0
        ? db
            .select({ contactId: crmTasks.contactId, notes: crmTasks.notes })
            .from(crmTasks)
            .where(
              and(
                inArray(crmTasks.contactId, matchedIds),
                eq(crmTasks.status, "completed"),
                eq(crmTasks.title, "Note"),
                isNotNull(crmTasks.notes),
                ilike(crmTasks.notes, "%[outbound-import-note:%"),
              ),
            )
        : Promise.resolve([]),
      matchedAccountIds.length > 0
        ? db
            .select({
              id: partnerAccounts.id,
              status: partnerAccounts.status,
              externalCompanyId: partnerAccounts.externalCompanyId,
              externalLocationId: partnerAccounts.externalLocationId,
            })
            .from(partnerAccounts)
            .where(inArray(partnerAccounts.id, matchedAccountIds))
        : Promise.resolve([]),
    ]);
  const contactsWithPipeline = new Set(
    pipelineRows.map((row) => row.contactId),
  );
  const outboundTaskByContact = new Map(
    outboundTaskRows.map((row) => [
      row.contactId,
      {
        id: row.id,
        title: row.title,
        dueAt: row.dueAt,
        notes: row.notes ?? "",
      },
    ]),
  );
  const outboundTaskCountByContact = new Map<string, number>();
  for (const task of outboundTaskRows) {
    outboundTaskCountByContact.set(
      task.contactId,
      (outboundTaskCountByContact.get(task.contactId) ?? 0) + 1,
    );
  }
  const importedNotesByContact = new Map<string, string[]>();
  for (const note of importedNoteRows) {
    const values = importedNotesByContact.get(note.contactId) ?? [];
    if (note.notes) values.push(note.notes);
    importedNotesByContact.set(note.contactId, values);
  }
  const matchedAccountById = new Map(
    matchedAccountRows.map((account) => [account.id, account]),
  );

  const plans: PlannedImportRow[] = [];
  for (const row of parsed.rows) {
    if (row.preflightStatus !== "candidate") {
      plans.push({
        source: row,
        publicRow: {
          rowNumber: row.rowNumber,
          status: row.preflightStatus,
          reason: row.reason,
          duplicateOfRow: row.duplicateOfRow,
          existingContactId: null,
          company: row.company,
          contactName: row.contactName,
          email: row.emailNormalized ?? row.email,
          phone: row.phoneE164 ?? row.phone,
          companyExternalId: row.companyExternalId,
          locationExternalId: row.locationExternalId,
          importedStatus: row.status,
          priority: row.priority,
          nextAction: row.nextAction,
          followUpAt: row.followUpAt,
          emailStatus: row.emailStatus,
          warnings: row.warnings,
          plannedChanges: [],
        },
        existing: null,
        needsPipeline: false,
        needsOutboundTask: false,
        needsOutboundTaskUpdate: false,
        closesOutboundTask: false,
        existingOutboundTask: null,
        needsContactNote: false,
        needsPartnerAccount: false,
      });
      continue;
    }
    const match = initialMatches.get(row.rowNumber);
    if (match?.conflict) {
      plans.push({
        source: row,
        publicRow: {
          rowNumber: row.rowNumber,
          status: "conflict",
          reason: match.conflict,
          duplicateOfRow: null,
          existingContactId: match.existing?.id ?? null,
          company: row.company,
          contactName: row.contactName,
          email: row.emailNormalized,
          phone: row.phoneE164,
          companyExternalId: row.companyExternalId,
          locationExternalId: row.locationExternalId,
          importedStatus: row.status,
          priority: row.priority,
          nextAction: row.nextAction,
          followUpAt: row.followUpAt,
          emailStatus: row.emailStatus,
          warnings: row.warnings,
          plannedChanges: [],
        },
        existing: match.existing,
        needsPipeline: false,
        needsOutboundTask: false,
        needsOutboundTaskUpdate: false,
        closesOutboundTask: false,
        existingOutboundTask: null,
        needsContactNote: false,
        needsPartnerAccount: false,
      });
      continue;
    }
    const existing = match?.existing ?? null;
    const linkedAccount = existing?.partnerAccountId
      ? matchedAccountById.get(existing.partnerAccountId)
      : null;
    const identityConflict =
      linkedAccount &&
      ((row.locationExternalId &&
        linkedAccount.externalLocationId &&
        row.locationExternalId !== linkedAccount.externalLocationId) ||
        (row.companyExternalId &&
          linkedAccount.externalCompanyId &&
          row.companyExternalId !== linkedAccount.externalCompanyId));
    if (identityConflict) {
      plans.push({
        source: row,
        publicRow: {
          rowNumber: row.rowNumber,
          status: "conflict",
          reason:
            "The matched contact is linked to a company/location with a different stable ID.",
          duplicateOfRow: null,
          existingContactId: existing?.id ?? null,
          company: row.company,
          contactName: row.contactName,
          email: row.emailNormalized,
          phone: row.phoneE164,
          companyExternalId: row.companyExternalId,
          locationExternalId: row.locationExternalId,
          importedStatus: row.status,
          priority: row.priority,
          nextAction: row.nextAction,
          followUpAt: row.followUpAt,
          emailStatus: row.emailStatus,
          warnings: row.warnings,
          plannedChanges: [],
        },
        existing,
        needsPipeline: false,
        needsOutboundTask: false,
        needsOutboundTaskUpdate: false,
        closesOutboundTask: false,
        existingOutboundTask: null,
        needsContactNote: false,
        needsPartnerAccount: false,
      });
      continue;
    }
    const needsPipeline = existing
      ? !contactsWithPipeline.has(existing.id)
      : true;
    const existingOutboundTaskCount = existing
      ? (outboundTaskCountByContact.get(existing.id) ?? 0)
      : 0;
    const existingOutboundTask =
      existing && existingOutboundTaskCount === 1
        ? (outboundTaskByContact.get(existing.id) ?? null)
        : null;
    const mappedAccountStatus = classifyImportedAccountStatus(row.status);
    const preservesExistingWorkflow = isProtectedPartnerStatus(
      linkedAccount?.status,
    );
    const closesOutboundTask = Boolean(
      (mappedAccountStatus === "not_a_fit" ||
        mappedAccountStatus === "dormant") &&
        !preservesExistingWorkflow &&
        !row.nextAction &&
        !row.followUpAt,
    );
    const needsOutboundTask =
      existingOutboundTaskCount === 0 &&
      !closesOutboundTask &&
      !preservesExistingWorkflow;
    const needsOutboundTaskUpdate = Boolean(
      existingOutboundTask &&
        !preservesExistingWorkflow &&
        (closesOutboundTask ||
          row.nextAction ||
          row.followUpAt ||
          row.priority ||
          row.emailStatus ||
          row.status),
    );
    const needsPartnerAccount = rowCanCreatePartner(row);
    const noteMarker = contactNoteMarker(row);
    const needsContactNote = Boolean(
      noteMarker &&
        (!existing || hasImportedHistory(row)) &&
        (!existing ||
          !(importedNotesByContact.get(existing.id) ?? []).some((note) =>
            note.includes(noteMarker),
          )),
    );
    const plannedChanges: OutboundImportPlannedChange[] = existing
      ? contactFieldChanges(existing, row, assignee.id)
      : ["contact.create"];
    if (needsContactNote) {
      plannedChanges.push("contact_note.create");
    }
    if (needsPartnerAccount) {
      plannedChanges.push("partner.resolve_and_link");
      if (row.companyExternalId || row.locationExternalId)
        plannedChanges.push("partner.identity");
      if (row.status) plannedChanges.push("partner.status");
      if (row.priority) plannedChanges.push("partner.priority");
      if (row.nextAction) plannedChanges.push("partner.next_action");
      if (row.followUpAt) plannedChanges.push("partner.follow_up");
      if (row.emailStatus) plannedChanges.push("partner.email_status");
      if (researchNotes(row)) plannedChanges.push("partner.notes");
    }
    if (needsPipeline) plannedChanges.push("pipeline.create");
    if (needsOutboundTask) plannedChanges.push("task.create");
    if (needsOutboundTaskUpdate) plannedChanges.push("task.update");
    const status = !existing
      ? "create"
      : plannedChanges.length > 0
        ? "update"
        : "unchanged";
    plans.push({
      source: row,
      publicRow: {
        rowNumber: row.rowNumber,
        status,
        reason:
          status === "unchanged"
            ? "No contact or outbound workflow changes are needed."
            : null,
        duplicateOfRow: null,
        existingContactId: existing?.id ?? null,
        company: row.company,
        contactName: row.contactName,
        email: row.emailNormalized,
        phone: row.phoneE164,
        companyExternalId: row.companyExternalId,
        locationExternalId: row.locationExternalId,
        importedStatus: row.status,
        priority: row.priority,
        nextAction: row.nextAction,
        followUpAt: row.followUpAt,
        emailStatus: row.emailStatus,
        warnings: row.warnings,
        plannedChanges,
      },
      existing,
      needsPipeline,
      needsOutboundTask,
      needsOutboundTaskUpdate,
      closesOutboundTask,
      existingOutboundTask,
      needsContactNote,
      needsPartnerAccount,
    });
  }

  const publicRows = plans.map((plan) => plan.publicRow);
  const counts = countOutboundImportRows(publicRows);
  const previewHash = hashOutboundImportPreview({
    requestHash: parsed.requestHash,
    assigneeMemberId: assignee.id,
    rows: publicRows,
  });
  const preview: OutboundImportPreview = {
    kind: "outbound_import_preview",
    requestHash: parsed.requestHash,
    previewHash,
    campaign: parsed.campaign,
    assignee,
    byteLength: parsed.byteLength,
    ignoredHeaders: parsed.ignoredHeaders,
    counts,
    confirmationPhrase: expectedOutboundImportConfirmation(counts.accepted),
    rows: publicRows,
    exclusionReport: buildOutboundImportExclusionReport(
      publicRows,
      previewHash,
    ),
  };
  return { preview, plans };
}

function partnerLockKeys(row: NormalizedOutboundImportRow): string[] {
  const keys: string[] = [];
  if (row.locationExternalId)
    keys.push(
      `outbound-import:partner:location-id:${row.locationExternalId.toLowerCase()}`,
    );
  else if (row.companyExternalId)
    keys.push(
      `outbound-import:partner:company-id:${row.companyExternalId.toLowerCase()}`,
    );
  const domain = normalizePartnerAccountDomain(row.domain ?? row.website);
  if (domain) keys.push(`outbound-import:partner:domain:${domain}`);
  const name = normalizePartnerAccountName(row.company);
  if (name) {
    keys.push(`outbound-import:partner:name:${name}`);
  }
  return keys;
}

async function lockOutboundImportKeys(
  tx: TransactionExecutor,
  keys: readonly string[],
): Promise<void> {
  const sorted = Array.from(new Set(keys)).sort();
  if (sorted.length === 0) return;
  const values = sql.join(
    sorted.map((key) => sql`(${key})`),
    sql`, `,
  );
  await tx.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(lock_key, 0))
    from (values ${values}) as import_locks(lock_key)
    order by lock_key
  `);
}

export async function lockOutboundImportIdentities(
  tx: TransactionExecutor,
  parsed: ParsedOutboundImport,
): Promise<void> {
  const keys = new Set<string>();
  for (const row of parsed.rows) {
    if (row.preflightStatus !== "candidate") continue;
    if (row.emailNormalized) {
      keys.add(`outbound-import:contact:email:${row.emailNormalized}`);
    }
    if (row.phoneE164) {
      keys.add(`outbound-import:contact:phone:${row.phoneE164}`);
    }
    for (const partnerKey of partnerLockKeys(row)) keys.add(partnerKey);
  }
  await lockOutboundImportKeys(tx, Array.from(keys));
}

export async function lockOutboundImportMatchedContacts(
  tx: TransactionExecutor,
  prepared: PreparedOutboundImportPreview,
): Promise<void> {
  const contactIds = prepared.plans
    .filter(
      (plan) =>
        plan.publicRow.status === "update" &&
        plan.publicRow.existingContactId !== null,
    )
    .map((plan) => plan.publicRow.existingContactId)
    .filter((contactId): contactId is string => contactId !== null);
  const uniqueContactIds = Array.from(new Set(contactIds)).sort();
  await lockOutboundImportKeys(
    tx,
    uniqueContactIds.map(
      (contactId) => `outbound-import:contact:id:${contactId}`,
    ),
  );
  if (uniqueContactIds.length === 0) return;
  const lockedContacts = await tx
    .select({ id: contacts.id })
    .from(contacts)
    .where(inArray(contacts.id, uniqueContactIds))
    .orderBy(contacts.id)
    .for("update");
  if (lockedContacts.length !== uniqueContactIds.length) {
    throw new TeamMutationFailure(
      "conflict",
      "A contact changed while the import was starting. No changes were saved; preview again.",
      { retryable: false },
    );
  }
}

async function resolveRowPartnerAccount(
  tx: TransactionExecutor,
  row: NormalizedOutboundImportRow,
  parsed: ParsedOutboundImport,
  assignee: OutboundImportAssignee,
  existingAccountId: string | null,
): Promise<string | null> {
  if (!rowCanCreatePartner(row)) return null;
  const { segment, subsegment } = classifyOutboundSegment({
    row,
  });
  const account = await resolveOrCreatePartnerAccount(tx, {
    existingAccountId,
    name: row.company,
    website: row.website,
    domain: row.domain ?? row.website,
    segment,
    subsegment,
    city: row.city,
    state: row.state,
    source: `outbound:${parsed.campaign}`,
    sourceCampaign: parsed.campaign,
    sourceListName: row.sourceListName,
    externalCompanyId: row.companyExternalId,
    externalLocationId: row.locationExternalId,
    importedStatus: row.status,
    outreachPriority: row.priority,
    importedNextAction: row.nextAction,
    importedEmailStatus: row.emailStatus,
    status: classifyImportedAccountStatus(row.status),
    lastDisposition: classifyImportedDisposition({
      status: row.status,
      emailStatus: row.emailStatus,
    }),
    nextTouchAt: importedFollowUpAt(row),
    ownerMemberId: assignee.id,
    notes: researchNotes(row),
  });
  return account?.id ?? null;
}

export async function executePreparedOutboundImport(
  tx: TransactionExecutor,
  parsed: ParsedOutboundImport,
  prepared: PreparedOutboundImportPreview,
  assignee: OutboundImportAssignee,
  now = new Date(),
): Promise<OutboundImportExecution> {
  let contactsCreated = 0;
  let contactsModified = 0;
  const resolvedPartnerAccountIds = new Set<string>();
  let partnerLinksCreated = 0;
  let contactNotesCreated = 0;
  let tasksCreated = 0;
  let tasksUpdated = 0;
  let pipelineRowsCreated = 0;
  const source = `outbound:${parsed.campaign}`;

  for (const plan of prepared.plans) {
    if (
      plan.publicRow.status !== "create" &&
      plan.publicRow.status !== "update"
    ) {
      continue;
    }
    const row = plan.source;
    const baseName = splitName(row.contactName) ??
      splitName(row.company) ?? { firstName: "Property", lastName: "Manager" };
    let contactId: string;
    let partnerAccountId = plan.existing?.partnerAccountId ?? null;
    if (plan.needsPartnerAccount) {
      partnerAccountId = await resolveRowPartnerAccount(
        tx,
        row,
        parsed,
        assignee,
        partnerAccountId,
      );
      if (!partnerAccountId) {
        throw new TeamMutationFailure(
          "internal",
          `Partner resolution failed for CSV row ${row.rowNumber}. No import changes were saved.`,
          { retryable: true },
        );
      }
      resolvedPartnerAccountIds.add(partnerAccountId);
    }

    if (plan.existing) {
      const existing = plan.existing;
      const patch: Partial<typeof contacts.$inferInsert> = {};
      if (!existing.email && row.emailNormalized)
        patch.email = row.emailNormalized;
      if (!existing.phoneE164 && row.phoneE164) {
        patch.phoneE164 = row.phoneE164;
        patch.phone = row.phoneE164;
      }
      if (!existing.company && row.company) patch.company = row.company;
      if (
        (!existing.firstName ||
          existing.firstName.toLowerCase() === "unknown contact") &&
        baseName.firstName
      ) {
        patch.firstName = baseName.firstName;
      }
      if (
        (!existing.lastName || existing.lastName.toLowerCase() === "unknown") &&
        baseName.lastName
      ) {
        patch.lastName = baseName.lastName;
      }
      if (!existing.source) patch.source = source;
      if (!existing.salespersonMemberId)
        patch.salespersonMemberId = assignee.id;
      if (!existing.partnerAccountId && partnerAccountId) {
        patch.partnerAccountId = partnerAccountId;
      }
      if (
        existing.partnerStatus === "none" &&
        ((existing.source ?? "").startsWith("outbound:") || !existing.source)
      ) {
        patch.partnerStatus = "prospect";
      }
      if (!existing.partnerOwnerMemberId) {
        patch.partnerOwnerMemberId = assignee.id;
      }
      if (Object.keys(patch).length > 0) {
        const updatedContacts = await tx
          .update(contacts)
          .set({ ...patch, updatedAt: now })
          .where(eq(contacts.id, existing.id))
          .returning({ id: contacts.id });
        if (updatedContacts.length !== 1) {
          throw new TeamMutationFailure(
            "conflict",
            `Contact changed before CSV row ${row.rowNumber} could be applied. No import changes were saved.`,
            { retryable: false },
          );
        }
        contactsModified += 1;
        if (patch.partnerAccountId) partnerLinksCreated += 1;
      }
      contactId = existing.id;
    } else {
      const [created] = await tx
        .insert(contacts)
        .values({
          firstName: baseName.firstName,
          lastName: baseName.lastName,
          company: row.company,
          email: row.emailNormalized,
          phone: row.phoneE164,
          phoneE164: row.phoneE164,
          salespersonMemberId: assignee.id,
          partnerAccountId,
          partnerStatus: "prospect",
          partnerOwnerMemberId: assignee.id,
          source,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: contacts.id });
      if (!created?.id) {
        throw new TeamMutationFailure(
          "internal",
          `Contact creation failed for CSV row ${row.rowNumber}. No import changes were saved.`,
          { retryable: true },
        );
      }
      contactId = created.id;
      contactsCreated += 1;
      if (partnerAccountId) partnerLinksCreated += 1;
    }

    if (plan.needsContactNote) {
      const note = contactNote(row);
      if (note) {
        const insertedNotes = await tx
          .insert(crmTasks)
          .values({
            contactId,
            partnerAccountId,
            title: "Note",
            status: "completed",
            notes: note,
            dueAt: null,
            assignedTo: null,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: crmTasks.id });
        if (insertedNotes.length !== 1) {
          throw new TeamMutationFailure(
            "internal",
            `Contact note creation failed for CSV row ${row.rowNumber}. No import changes were saved.`,
            { retryable: true },
          );
        }
        contactNotesCreated += 1;
      }
    }

    if (plan.needsPipeline) {
      const insertedPipelineRows = await tx
        .insert(crmPipeline)
        .values({ contactId, stage: "new", notes: null })
        .onConflictDoNothing({ target: crmPipeline.contactId })
        .returning({ contactId: crmPipeline.contactId });
      pipelineRowsCreated += insertedPipelineRows.length;
    }
    if (plan.needsOutboundTask) {
      const { segment } = classifyOutboundSegment({
        row,
      });
      const insertedTasks = await tx
        .insert(crmTasks)
        .values({
          contactId,
          partnerAccountId,
          title: row.nextAction ?? chooseOutboundTaskTitle(segment),
          status: "open",
          dueAt: importedFollowUpAt(row),
          assignedTo: assignee.id,
          notes: outboundTaskNotes({
            campaign: parsed.campaign,
            company: row.company,
            notes: row.notes,
            priority: row.priority,
            emailStatus: row.emailStatus,
            importedStatus: row.status,
          }),
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: crmTasks.id });
      if (insertedTasks.length !== 1) {
        throw new TeamMutationFailure(
          "internal",
          `Outbound task creation failed for CSV row ${row.rowNumber}. No import changes were saved.`,
          { retryable: true },
        );
      }
      tasksCreated += insertedTasks.length;
    } else if (plan.needsOutboundTaskUpdate && plan.existingOutboundTask) {
      let notes = plan.existingOutboundTask.notes;
      if (row.priority)
        notes = upsertTaskNoteField(notes, "priority", row.priority);
      if (row.emailStatus)
        notes = upsertTaskNoteField(notes, "emailStatus", row.emailStatus);
      if (row.status)
        notes = upsertTaskNoteField(notes, "importedStatus", row.status);
      const updatedTasks = await tx
        .update(crmTasks)
        .set({
          partnerAccountId,
          status: plan.closesOutboundTask ? "completed" : "open",
          title: row.nextAction ?? plan.existingOutboundTask.title,
          dueAt: plan.closesOutboundTask
            ? null
            : (importedFollowUpAt(row) ?? plan.existingOutboundTask.dueAt),
          notes,
          updatedAt: now,
        })
        .where(
          and(
            eq(crmTasks.id, plan.existingOutboundTask.id),
            eq(crmTasks.status, "open"),
          ),
        )
        .returning({ id: crmTasks.id });
      if (updatedTasks.length !== 1) {
        throw new TeamMutationFailure(
          "conflict",
          `The existing outbound task changed before CSV row ${row.rowNumber} could be applied. No import changes were saved.`,
          { retryable: true },
        );
      }
      tasksUpdated += 1;
    }
  }

  return {
    kind: "outbound_import_result",
    requestHash: parsed.requestHash,
    previewHash: prepared.preview.previewHash,
    campaign: parsed.campaign,
    assignee,
    counts: {
      ...prepared.preview.counts,
      rowsUpdated: prepared.preview.counts.update,
      contactsCreated,
      contactsModified,
      partnerAccountsResolved: resolvedPartnerAccountIds.size,
      partnerLinksCreated,
      contactNotesCreated,
      tasksCreated,
      tasksUpdated,
      pipelineRowsCreated,
    },
    exclusionReport: prepared.preview.exclusionReport,
  };
}
