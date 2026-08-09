import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { parsePhoneNumberFromString } from "libphonenumber-js";
import { TeamMutationFailure } from "@/lib/team-mutation";

export const OUTBOUND_IMPORT_MAX_ROWS = 2_000;
export const OUTBOUND_IMPORT_MAX_BYTES = 2 * 1024 * 1024;
export const OUTBOUND_IMPORT_MAX_REQUEST_BYTES = 3 * 1024 * 1024;

export const OUTBOUND_IMPORT_STATUSES = [
  "create",
  "update",
  "unchanged",
  "invalid",
  "duplicate",
  "conflict",
] as const;

export type OutboundImportStatus = (typeof OUTBOUND_IMPORT_STATUSES)[number];

export const OUTBOUND_IMPORT_PLANNED_CHANGES = [
  "contact.create",
  "contact.email",
  "contact.phone",
  "contact.company",
  "contact.first_name",
  "contact.last_name",
  "contact.source",
  "contact.assignee",
  "contact.partner_status",
  "contact.partner_owner",
  "contact_note.create",
  "partner.resolve_and_link",
  "pipeline.create",
  "task.create",
] as const;

export type OutboundImportPlannedChange =
  (typeof OUTBOUND_IMPORT_PLANNED_CHANGES)[number];

export type OutboundImportCanonicalField =
  | "company"
  | "contactName"
  | "phone"
  | "email"
  | "website"
  | "domain"
  | "title"
  | "industry"
  | "companySize"
  | "linkedinUrl"
  | "city"
  | "state"
  | "zip"
  | "sourceListName"
  | "notes";

export type NormalizedOutboundImportRow = Record<
  OutboundImportCanonicalField,
  string | null
> & {
  rowNumber: number;
  emailNormalized: string | null;
  phoneE164: string | null;
  preflightStatus: "candidate" | "invalid" | "duplicate";
  reason: string | null;
  duplicateOfRow: number | null;
};

export type ParsedOutboundImport = {
  campaign: string;
  requestedAssigneeMemberId: string | null;
  rows: NormalizedOutboundImportRow[];
  ignoredHeaders: string[];
  sourceSha256: string;
  requestHash: string;
  byteLength: number;
};

export type OutboundImportPublicRow = {
  rowNumber: number;
  status: OutboundImportStatus;
  reason: string | null;
  duplicateOfRow: number | null;
  existingContactId: string | null;
  company: string | null;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  plannedChanges: OutboundImportPlannedChange[];
};

export type OutboundImportCounts = {
  total: number;
  accepted: number;
  create: number;
  update: number;
  unchanged: number;
  invalid: number;
  duplicate: number;
  conflict: number;
};

export type OutboundImportExclusionReport = {
  rowCount: number;
  truncated: false;
  filename: string;
  csv: string;
};

type CsvRecord = { rowNumber: number; cells: string[] };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64_PATTERN =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

const HEADER_ALIASES: Readonly<Record<string, OutboundImportCanonicalField>> = {
  company: "company",
  company_name: "company",
  business: "company",
  organization: "company",
  organization_name: "company",
  property_manager: "company",
  property_management_company: "company",
  contactname: "contactName",
  contact_name: "contactName",
  name: "contactName",
  contact: "contactName",
  full_name: "contactName",
  person_name: "contactName",
  phone: "phone",
  phone_number: "phone",
  mobile: "phone",
  mobile_phone: "phone",
  cell: "phone",
  email: "email",
  email_address: "email",
  work_email: "email",
  website: "website",
  site: "website",
  url: "website",
  company_website: "website",
  domain: "domain",
  company_domain: "domain",
  email_domain: "domain",
  title: "title",
  job_title: "title",
  role: "title",
  industry: "industry",
  vertical: "industry",
  segment: "industry",
  company_size: "companySize",
  employees: "companySize",
  employee_count: "companySize",
  employee_range: "companySize",
  organization_num_employees: "companySize",
  linkedin_url: "linkedinUrl",
  person_linkedin_url: "linkedinUrl",
  company_linkedin_url: "linkedinUrl",
  linkedin: "linkedinUrl",
  city: "city",
  state: "state",
  region: "state",
  zip: "zip",
  zipcode: "zip",
  postal: "zip",
  postal_code: "zip",
  source_list_name: "sourceListName",
  list_name: "sourceListName",
  apollo_list: "sourceListName",
  list: "sourceListName",
  notes: "notes",
  note: "notes",
  details: "notes",
};

const FIELD_LIMITS: Readonly<Record<OutboundImportCanonicalField, number>> = {
  company: 300,
  contactName: 240,
  phone: 80,
  email: 254,
  website: 500,
  domain: 255,
  title: 240,
  industry: 240,
  companySize: 120,
  linkedinUrl: 500,
  city: 160,
  state: 32,
  zip: 32,
  sourceListName: 240,
  notes: 2_000,
};

const CANONICAL_FIELDS: readonly OutboundImportCanonicalField[] = [
  "company",
  "contactName",
  "phone",
  "email",
  "website",
  "domain",
  "title",
  "industry",
  "companySize",
  "linkedinUrl",
  "city",
  "state",
  "zip",
  "sourceListName",
  "notes",
];

function invalidImport(
  message: string,
  field: string,
  status = 422,
): TeamMutationFailure {
  return new TeamMutationFailure("invalid", message, {
    status,
    fieldErrors: { [field]: message },
  });
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeHeader(value: string): string {
  return value
    .replace(/^\uFEFF/u, "")
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "_")
    .replace(/[^a-z0-9_]/gu, "");
}

function normalizeText(
  value: string,
  collapseWhitespace = true,
): string | null {
  const normalized = value.normalize("NFKC").replace(/\r\n?/gu, "\n").trim();
  if (!normalized) return null;
  return collapseWhitespace ? normalized.replace(/\s+/gu, " ") : normalized;
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function decodeBase64Utf8(value: unknown): {
  text: string;
  bytes: Uint8Array;
} {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidImport("Paste or upload a CSV file first.", "csv");
  }
  const encoded = value.trim();
  const maximumEncodedLength = Math.ceil(OUTBOUND_IMPORT_MAX_BYTES / 3) * 4;
  if (encoded.length > maximumEncodedLength + 4) {
    throw invalidImport(
      `The CSV exceeds the ${OUTBOUND_IMPORT_MAX_BYTES.toLocaleString()} byte limit.`,
      "csv",
      413,
    );
  }
  if (!BASE64_PATTERN.test(encoded)) {
    throw invalidImport("The uploaded CSV encoding is invalid.", "csv");
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length === 0) {
    throw invalidImport("The CSV is empty.", "csv");
  }
  if (bytes.length > OUTBOUND_IMPORT_MAX_BYTES) {
    throw invalidImport(
      `The CSV exceeds the ${OUTBOUND_IMPORT_MAX_BYTES.toLocaleString()} byte limit.`,
      "csv",
      413,
    );
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw invalidImport(
      "The CSV must be valid UTF-8. Export it as UTF-8 and try again.",
      "csv",
    );
  }
  text = text.replace(/^\uFEFF/u, "");
  if (text.includes("\u0000")) {
    throw invalidImport("The CSV contains unsupported null bytes.", "csv");
  }
  return { text, bytes };
}

function countDelimiter(header: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  for (let index = 0; index < header.length; index += 1) {
    const character = header[index];
    if (character === '"') {
      if (quoted && header[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && character === delimiter) {
      count += 1;
    }
  }
  return count;
}

function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/u, 1)[0] ?? "";
  const choices = [",", "\t", ";"] as const;
  return choices.reduce((best, candidate) =>
    countDelimiter(firstLine, candidate) > countDelimiter(firstLine, best)
      ? candidate
      : best,
  );
}

function parseCsvRecords(text: string, delimiter: string): CsvRecord[] {
  const records: CsvRecord[] = [];
  let cells: string[] = [];
  let cell = "";
  let quoted = false;
  let rowNumber = 1;
  let recordStart = 1;

  const finishRecord = (): void => {
    cells.push(cell);
    records.push({ rowNumber: recordStart, cells });
    cells = [];
    cell = "";
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
        if (character === "\n") rowNumber += 1;
      }
      continue;
    }

    if (character === '"') {
      if (cell.length > 0) {
        throw invalidImport(
          `CSV row ${recordStart} contains a quote in an unquoted field.`,
          "csv",
        );
      }
      quoted = true;
      continue;
    }
    if (character === delimiter) {
      cells.push(cell);
      cell = "";
      continue;
    }
    if (character === "\r" || character === "\n") {
      finishRecord();
      if (character === "\r" && text[index + 1] === "\n") index += 1;
      rowNumber += 1;
      recordStart = rowNumber;
      continue;
    }
    cell += character;
  }

  if (quoted) {
    throw invalidImport(
      `CSV row ${recordStart} contains an unterminated quoted field.`,
      "csv",
    );
  }
  if (cell.length > 0 || cells.length > 0) finishRecord();
  return records;
}

function isBlankRecord(record: CsvRecord): boolean {
  return record.cells.every((cell) => cell.trim().length === 0);
}

function normalizedCampaign(value: unknown): string {
  if (value === undefined || value === null || value === "") {
    return "property_management";
  }
  if (typeof value !== "string") {
    throw invalidImport("Campaign must be text.", "campaign");
  }
  const campaign = normalizeText(value);
  if (
    !campaign ||
    campaign.length > 100 ||
    containsControlCharacter(campaign)
  ) {
    throw invalidImport(
      "Campaign must contain between 1 and 100 printable characters.",
      "campaign",
    );
  }
  return campaign;
}

function normalizedAssignee(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value.trim())) {
    throw invalidImport("Choose a valid assignee.", "assignedToMemberId");
  }
  return value.trim().toLowerCase();
}

function normalizeEmail(value: string | null): {
  value: string | null;
  valid: boolean;
} {
  if (!value) return { value: null, valid: true };
  const email = value.toLowerCase();
  return {
    value: email,
    valid:
      email.length <= FIELD_LIMITS.email &&
      EMAIL_PATTERN.test(email) &&
      !containsControlCharacter(email),
  };
}

function normalizePhone(value: string | null): {
  value: string | null;
  valid: boolean;
} {
  if (!value) return { value: null, valid: true };
  const phone = parsePhoneNumberFromString(value, "US");
  return phone?.isValid()
    ? { value: phone.number, valid: true }
    : { value: null, valid: false };
}

function emptyCanonicalRow(): Record<
  OutboundImportCanonicalField,
  string | null
> {
  return {
    company: null,
    contactName: null,
    phone: null,
    email: null,
    website: null,
    domain: null,
    title: null,
    industry: null,
    companySize: null,
    linkedinUrl: null,
    city: null,
    state: null,
    zip: null,
    sourceListName: null,
    notes: null,
  };
}

function applyConnectedDuplicateClusters(
  rows: readonly NormalizedOutboundImportRow[],
): NormalizedOutboundImportRow[] {
  const candidates = rows.filter((row) => row.preflightStatus === "candidate");
  const parent = new Map<number, number>();
  const emailOwner = new Map<string, number>();
  const phoneOwner = new Map<string, number>();
  for (const row of candidates) parent.set(row.rowNumber, row.rowNumber);

  const find = (rowNumber: number): number => {
    const current = parent.get(rowNumber) ?? rowNumber;
    if (current === rowNumber) return rowNumber;
    const root = find(current);
    parent.set(rowNumber, root);
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot === rightRoot) return;
    const canonical = Math.min(leftRoot, rightRoot);
    const duplicate = Math.max(leftRoot, rightRoot);
    parent.set(duplicate, canonical);
  };

  // Register every valid identifier before classifying any row as a duplicate.
  // This makes identity clustering transitively closed: a later bridge row can
  // merge two earlier roots, and an alternate identifier on a duplicate still
  // connects every subsequent row to the canonical lowest row number.
  for (const row of candidates) {
    if (row.emailNormalized) {
      const owner = emailOwner.get(row.emailNormalized);
      if (owner !== undefined) union(row.rowNumber, owner);
      else emailOwner.set(row.emailNormalized, row.rowNumber);
    }
    if (row.phoneE164) {
      const owner = phoneOwner.get(row.phoneE164);
      if (owner !== undefined) union(row.rowNumber, owner);
      else phoneOwner.set(row.phoneE164, row.rowNumber);
    }
  }

  return rows.map((row) => {
    if (row.preflightStatus !== "candidate") return row;
    const canonicalRow = find(row.rowNumber);
    if (canonicalRow === row.rowNumber) return row;
    return {
      ...row,
      preflightStatus: "duplicate",
      reason: `Duplicates accepted row ${canonicalRow}.`,
      duplicateOfRow: canonicalRow,
    };
  });
}

function parseRows(records: CsvRecord[]): {
  rows: NormalizedOutboundImportRow[];
  ignoredHeaders: string[];
} {
  const headerIndex = records.findIndex((record) => !isBlankRecord(record));
  if (headerIndex < 0) throw invalidImport("The CSV is empty.", "csv");
  const headerRecord = records[headerIndex];
  if (!headerRecord) throw invalidImport("The CSV has no header row.", "csv");

  const canonicalByColumn: Array<OutboundImportCanonicalField | null> = [];
  const ignoredHeaders: string[] = [];
  const seenCanonical = new Set<OutboundImportCanonicalField>();
  for (const rawHeader of headerRecord.cells) {
    const normalized = normalizeHeader(rawHeader);
    const canonical = HEADER_ALIASES[normalized] ?? null;
    if (!canonical) {
      canonicalByColumn.push(null);
      if (rawHeader.trim()) ignoredHeaders.push(rawHeader.trim().slice(0, 120));
      continue;
    }
    if (seenCanonical.has(canonical)) {
      throw invalidImport(
        `The CSV maps more than one column to ${canonical}. Keep only one.`,
        "headers",
      );
    }
    seenCanonical.add(canonical);
    canonicalByColumn.push(canonical);
  }
  if (!seenCanonical.has("email") && !seenCanonical.has("phone")) {
    throw invalidImport(
      "The CSV must include a supported email or phone header.",
      "headers",
    );
  }

  const dataRecords = records
    .slice(headerIndex + 1)
    .filter((record) => !isBlankRecord(record));
  if (dataRecords.length === 0) {
    throw invalidImport("The CSV contains no data rows.", "csv");
  }
  if (dataRecords.length > OUTBOUND_IMPORT_MAX_ROWS) {
    throw invalidImport(
      `The CSV contains ${dataRecords.length.toLocaleString()} data rows. The maximum is ${OUTBOUND_IMPORT_MAX_ROWS.toLocaleString()}; nothing was imported.`,
      "rows",
    );
  }

  const rows: NormalizedOutboundImportRow[] = [];

  for (const record of dataRecords) {
    const values = emptyCanonicalRow();
    let invalidReason: string | null = null;
    const extraCells = record.cells.slice(canonicalByColumn.length);
    if (extraCells.some((cell) => cell.trim().length > 0)) {
      invalidReason = "The row contains more values than the header row.";
    }

    for (let index = 0; index < canonicalByColumn.length; index += 1) {
      const canonical = canonicalByColumn[index];
      if (!canonical) continue;
      const value = normalizeText(
        record.cells[index] ?? "",
        canonical !== "notes",
      );
      if (value && value.length > FIELD_LIMITS[canonical]) {
        invalidReason ??= `${canonical} exceeds the supported length.`;
      }
      values[canonical] = value;
    }

    const normalizedEmailResult = normalizeEmail(values.email);
    const normalizedPhoneResult = normalizePhone(values.phone);
    if (!normalizedEmailResult.valid) {
      invalidReason ??= "Email is invalid.";
    }
    if (!normalizedPhoneResult.valid) {
      invalidReason ??= "Phone is invalid.";
    }
    if (!normalizedEmailResult.value && !normalizedPhoneResult.value) {
      invalidReason ??= "A valid email or phone is required.";
    }

    rows.push({
      ...values,
      rowNumber: record.rowNumber,
      emailNormalized: normalizedEmailResult.value,
      phoneE164: normalizedPhoneResult.value,
      preflightStatus: invalidReason ? "invalid" : "candidate",
      reason: invalidReason,
      duplicateOfRow: null,
    });
  }
  return {
    rows: applyConnectedDuplicateClusters(rows),
    ignoredHeaders: Array.from(new Set(ignoredHeaders)),
  };
}

export async function readOutboundImportJsonRequest(
  request: Request,
): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    throw invalidImport("The import request must be JSON.", "request");
  }
  const contentLengthValue = request.headers.get("content-length");
  if (contentLengthValue !== null) {
    const contentLength = Number(contentLengthValue);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw invalidImport("The request size is invalid.", "request");
    }
    if (contentLength > OUTBOUND_IMPORT_MAX_REQUEST_BYTES) {
      throw invalidImport(
        `The import request exceeds the ${OUTBOUND_IMPORT_MAX_REQUEST_BYTES.toLocaleString()} byte limit.`,
        "request",
        413,
      );
    }
  }
  if (!request.body)
    throw invalidImport("The import request is empty.", "request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    total += next.value.byteLength;
    if (total > OUTBOUND_IMPORT_MAX_REQUEST_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw invalidImport(
        `The import request exceeds the ${OUTBOUND_IMPORT_MAX_REQUEST_BYTES.toLocaleString()} byte limit.`,
        "request",
        413,
      );
    }
    chunks.push(next.value);
  }
  const body = Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    total,
  );
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw invalidImport(
      "The import request must be valid UTF-8 JSON.",
      "request",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw invalidImport("The import request contains invalid JSON.", "request");
  }
}

export function parseOutboundImportPayload(
  value: unknown,
): ParsedOutboundImport {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw invalidImport("The import request is invalid.", "request");
  }
  const payload = value as Record<string, unknown>;
  const campaign = normalizedCampaign(payload["campaign"]);
  const requestedAssigneeMemberId = normalizedAssignee(
    payload["assignedToMemberId"],
  );
  const { text, bytes } = decodeBase64Utf8(payload["csvBase64"]);
  const records = parseCsvRecords(text, detectDelimiter(text));
  const { rows, ignoredHeaders } = parseRows(records);
  const sourceSha256 = sha256(bytes);
  const requestHash = sha256(
    JSON.stringify({ sourceSha256, campaign, requestedAssigneeMemberId }),
  );
  return {
    campaign,
    requestedAssigneeMemberId,
    rows,
    ignoredHeaders,
    sourceSha256,
    requestHash,
    byteLength: bytes.length,
  };
}

export function parsePreviewHash(value: unknown): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value.trim())) {
    throw invalidImport(
      "Preview this exact file and assignment before importing.",
      "previewHash",
    );
  }
  return value.trim();
}

export function expectedOutboundImportConfirmation(accepted: number): string {
  return `IMPORT ${accepted}`;
}

export function parseOutboundImportConfirmation(
  value: unknown,
  accepted: number,
): string {
  const expected = expectedOutboundImportConfirmation(accepted);
  if (typeof value !== "string" || value.trim() !== expected) {
    throw invalidImport(
      `Type “${expected}” to confirm this import.`,
      "confirmation",
    );
  }
  return expected;
}

export function countOutboundImportRows(
  rows: readonly OutboundImportPublicRow[],
): OutboundImportCounts {
  const counts: OutboundImportCounts = {
    total: rows.length,
    accepted: 0,
    create: 0,
    update: 0,
    unchanged: 0,
    invalid: 0,
    duplicate: 0,
    conflict: 0,
  };
  for (const row of rows) counts[row.status] += 1;
  counts.accepted = counts.create + counts.update;
  return counts;
}

function formulaNeutralize(value: string | null): string {
  if (!value) return "";
  return /^\s*[=+@-]/u.test(value) ? `'${value}` : value;
}

function csvCell(value: string | number | null): string {
  const safe = formulaNeutralize(value === null ? "" : String(value));
  return `"${safe.replace(/"/gu, '""')}"`;
}

export function buildOutboundImportExclusionReport(
  rows: readonly OutboundImportPublicRow[],
  previewHash: string,
): OutboundImportExclusionReport {
  const excluded = rows.filter(
    (row) =>
      row.status === "invalid" ||
      row.status === "duplicate" ||
      row.status === "conflict",
  );
  const header = [
    "row_number",
    "status",
    "reason",
    "duplicate_of_row",
    "existing_contact_id",
    "company",
    "contact_name",
    "email",
    "phone",
  ];
  const lines = [header.map(csvCell).join(",")];
  for (const row of excluded) {
    lines.push(
      [
        row.rowNumber,
        row.status,
        row.reason,
        row.duplicateOfRow,
        row.existingContactId,
        row.company,
        row.contactName,
        row.email,
        row.phone,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return {
    rowCount: excluded.length,
    truncated: false,
    filename: `outbound-import-exclusions-${previewHash.slice(0, 12)}.csv`,
    csv: `${lines.join("\r\n")}\r\n`,
  };
}

export function hashOutboundImportPreview(input: {
  requestHash: string;
  assigneeMemberId: string;
  rows: readonly OutboundImportPublicRow[];
}): string {
  return sha256(
    JSON.stringify({
      requestHash: input.requestHash,
      assigneeMemberId: input.assigneeMemberId,
      rows: input.rows.map((row) => [
        row.rowNumber,
        row.status,
        row.reason,
        row.duplicateOfRow,
        row.existingContactId,
        row.email,
        row.phone,
        row.plannedChanges,
      ]),
    }),
  );
}

export type ExistingIdentityCandidate = {
  id: string;
  emailNormalized: string | null;
  phoneE164: string | null;
  deleted: boolean;
};

export type ExistingIdentityClassification =
  | { kind: "new" }
  | { kind: "match"; contact: ExistingIdentityCandidate }
  | { kind: "conflict"; reason: string; contactId: string | null };

export function classifyOutboundExistingIdentity(input: {
  emailNormalized: string | null;
  phoneE164: string | null;
  emailMatches: readonly ExistingIdentityCandidate[];
  phoneMatches: readonly ExistingIdentityCandidate[];
}): ExistingIdentityClassification {
  const emailIds = new Set(input.emailMatches.map((contact) => contact.id));
  const phoneIds = new Set(input.phoneMatches.map((contact) => contact.id));
  if (emailIds.size > 1 || phoneIds.size > 1) {
    return {
      kind: "conflict",
      reason: "An identifier maps to multiple existing contacts.",
      contactId: null,
    };
  }
  const emailContact = input.emailMatches[0] ?? null;
  const phoneContact = input.phoneMatches[0] ?? null;
  if (emailContact && phoneContact && emailContact.id !== phoneContact.id) {
    return {
      kind: "conflict",
      reason: "Email and phone map to different existing contacts.",
      contactId: null,
    };
  }
  const contact = emailContact ?? phoneContact;
  if (!contact) return { kind: "new" };
  if (contact.deleted) {
    return {
      kind: "conflict",
      reason: "The identifier belongs to an archived contact.",
      contactId: contact.id,
    };
  }
  if (
    input.emailNormalized &&
    contact.emailNormalized &&
    input.emailNormalized !== contact.emailNormalized
  ) {
    return {
      kind: "conflict",
      reason: "The matched contact already has a different email.",
      contactId: contact.id,
    };
  }
  if (
    input.phoneE164 &&
    contact.phoneE164 &&
    input.phoneE164 !== contact.phoneE164
  ) {
    return {
      kind: "conflict",
      reason: "The matched contact already has a different phone.",
      contactId: contact.id,
    };
  }
  return { kind: "match", contact };
}

export function canonicalOutboundImportFields(): readonly OutboundImportCanonicalField[] {
  return CANONICAL_FIELDS;
}
