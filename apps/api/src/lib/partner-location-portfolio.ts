import { createHash } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  auditLogs,
  getDb,
  partnerAccountLocations,
  partnerAccounts,
  partnerBookingDrafts,
  partnerBookings,
  partnerLocationFavorites,
  partnerLocationImports,
  partnerQuotes,
  partnerServiceTemplates,
  properties,
  quotes,
  quoteVersions,
  type DatabaseClient,
} from "@/db";
import type {
  PartnerCapability,
  PartnerPrincipal,
} from "@/lib/partner-account-authorization";
import { normalizePropertyAddress } from "@/lib/property-write";
import { createPortalV2StrongEtag } from "@/lib/portal-v2-contract";
import { partnerQuoteBoundToLocationExpression } from "@/lib/partner-quote-location-safety";

export const PARTNER_LOCATION_IMPORT_MAX_BYTES = 262_144;
export const PARTNER_LOCATION_IMPORT_MAX_ROWS = 500;
export const PARTNER_LOCATION_IMPORT_TTL_MS = 30 * 60 * 1_000;
export const PARTNER_LOCATION_IMPORT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export const PARTNER_LOCATION_CSV_HEADERS = Object.freeze([
  "site_name",
  "external_property_id",
  "address_line_1",
  "address_line_2",
  "city",
  "state",
  "postal_code",
  "timezone",
  "parent_external_property_id",
  "make_default",
] as const);

const REQUIRED_CSV_HEADERS = new Set([
  "site_name",
  "address_line_1",
  "city",
  "state",
  "postal_code",
]);
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type LocationRow = typeof partnerAccountLocations.$inferSelect;
export type LocationImportRow = Readonly<{
  rowNumber: number;
  siteName: string;
  externalPropertyId: string | null;
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  state: string;
  postalCode: string;
  timezone: string;
  parentExternalPropertyId: string | null;
  makeDefault: boolean;
  addressKey: string;
}>;
export type LocationImportRowResult = Readonly<{
  rowNumber: number;
  status: "valid" | "invalid";
  values: Readonly<Record<string, string>>;
  errors: readonly Readonly<{ code: string; field: string; message: string }>[];
}>;

export type PartnerLocationImportAnalysis = Readonly<{
  normalizedRows: readonly LocationImportRow[];
  rowResults: readonly LocationImportRowResult[];
  rowCount: number;
  validRowCount: number;
  invalidRowCount: number;
}>;

export type PartnerLocationArchiveImpact = Readonly<{
  isDefault: boolean;
  activeChildCount: number;
  activeAlternativeCount: number;
  openDraftCount: number;
  activeTemplateCount: number;
  jobHistoryCount: number;
  canonicalQuoteV2Count: number;
  issuedActionableQuoteV2Count: number;
}>;

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

const LOCATION_IMPORT_FIELD_LIMITS = Object.freeze({
  site_name: 120,
  external_property_id: 100,
  address_line_1: 200,
  address_line_2: 100,
  city: 100,
  state: 2,
  postal_code: 16,
  timezone: 100,
  parent_external_property_id: 100,
} as const);

function validTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function parseCsvMatrix(csv: string): string[][] | null {
  if (
    csv.length < 1 ||
    new TextEncoder().encode(csv).byteLength >
      PARTNER_LOCATION_IMPORT_MAX_BYTES ||
    csv.includes("\0")
  ) {
    return null;
  }
  const matrix: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]!;
    if (quoted) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += character;
      }
      continue;
    }
    if (character === '"') {
      if (cell.length > 0) return null;
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && csv[index + 1] === "\n") index += 1;
      row.push(cell);
      matrix.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) return null;
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    matrix.push(row);
  }
  return matrix.filter((candidate) =>
    candidate.some((value) => value.trim().length > 0),
  );
}

function rowError(
  code: string,
  field: string,
  message: string,
): Readonly<{ code: string; field: string; message: string }> {
  return Object.freeze({ code, field, message });
}

function normalizeLocationImportValues(
  values: Readonly<Record<string, string>>,
  rowNumber: number,
): {
  normalized: LocationImportRow;
  errors: Array<{ code: string; field: string; message: string }>;
} {
  const errors: Array<{ code: string; field: string; message: string }> = [];
  const normalizedValues = Object.fromEntries(
    Object.entries(LOCATION_IMPORT_FIELD_LIMITS).map(([field]) => [
      field,
      normalizeText(values[field] ?? ""),
    ]),
  ) as Record<keyof typeof LOCATION_IMPORT_FIELD_LIMITS, string>;
  for (const field of Object.keys(LOCATION_IMPORT_FIELD_LIMITS) as Array<
    keyof typeof LOCATION_IMPORT_FIELD_LIMITS
  >) {
    const maximum = LOCATION_IMPORT_FIELD_LIMITS[field];
    if ((normalizedValues[field] ?? "").length > maximum) {
      errors.push(
        rowError(
          "too_long",
          field,
          `Use ${maximum} characters or fewer. The value was not truncated.`,
        ),
      );
    }
  }

  const siteName = normalizedValues.site_name;
  const externalPropertyId = normalizedValues.external_property_id || null;
  const addressLine1 = normalizedValues.address_line_1;
  const addressLine2 = normalizedValues.address_line_2 || null;
  const city = normalizedValues.city;
  // Validate the whole normalized value before uppercasing. In particular,
  // `New York` must not be silently sliced/coerced to `NE`.
  const state = normalizedValues.state.toUpperCase();
  const postalCode = normalizedValues.postal_code;
  const timezone = normalizedValues.timezone || "America/New_York";
  const parentExternalPropertyId =
    normalizedValues.parent_external_property_id || null;
  const rawDefault = normalizeText(values["make_default"] ?? "").toLowerCase();
  if (siteName.length < 1) {
    errors.push(rowError("required", "site_name", "Enter a site name."));
  }
  if (addressLine1.length < 3) {
    errors.push(
      rowError(
        "required",
        "address_line_1",
        "Enter a complete street address.",
      ),
    );
  }
  if (city.length < 2) {
    errors.push(rowError("required", "city", "Enter a city."));
  }
  if (!/^[A-Z]{2}$/u.test(state)) {
    errors.push(rowError("invalid", "state", "Use a two-letter state code."));
  }
  if (postalCode.length < 3) {
    errors.push(rowError("required", "postal_code", "Enter a postal code."));
  }
  if (!validTimeZone(timezone)) {
    errors.push(rowError("invalid", "timezone", "Use a valid IANA timezone."));
  }
  if (
    rawDefault &&
    !["true", "false", "yes", "no", "1", "0"].includes(rawDefault)
  ) {
    errors.push(
      rowError("invalid", "make_default", "Use true/false, yes/no, or 1/0."),
    );
  }
  const makeDefault = ["true", "yes", "1"].includes(rawDefault);
  const addressKey = normalizePropertyAddress({
    addressLine1,
    addressLine2,
    city,
    state,
    postalCode,
  }).addressKey;
  return {
    normalized: Object.freeze({
      rowNumber,
      siteName,
      externalPropertyId,
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      timezone,
      parentExternalPropertyId,
      makeDefault,
      addressKey,
    }),
    errors,
  };
}

export function parsePartnerLocationCsv(
  csv: string,
): PartnerLocationImportAnalysis {
  const matrix = parseCsvMatrix(csv);
  if (!matrix || matrix.length < 2) {
    throw new TypeError("location_csv_invalid");
  }
  const headers = matrix[0]!.map((value) => value.trim().toLowerCase());
  if (
    headers.length > PARTNER_LOCATION_CSV_HEADERS.length ||
    new Set(headers).size !== headers.length ||
    headers.some(
      (header) =>
        !PARTNER_LOCATION_CSV_HEADERS.includes(
          header as (typeof PARTNER_LOCATION_CSV_HEADERS)[number],
        ),
    ) ||
    [...REQUIRED_CSV_HEADERS].some((header) => !headers.includes(header))
  ) {
    throw new TypeError("location_csv_headers_invalid");
  }
  const sourceRows = matrix.slice(1);
  if (
    sourceRows.length < 1 ||
    sourceRows.length > PARTNER_LOCATION_IMPORT_MAX_ROWS
  ) {
    throw new TypeError("location_csv_row_count_invalid");
  }
  const normalizedRows: LocationImportRow[] = [];
  const mutableResults: Array<{
    rowNumber: number;
    values: Record<string, string>;
    errors: Array<{ code: string; field: string; message: string }>;
    normalized: LocationImportRow | null;
  }> = [];

  for (const [offset, raw] of sourceRows.entries()) {
    const rowNumber = offset + 2;
    const values = Object.fromEntries(
      headers.map((header, index) => [header, raw[index]?.trim() ?? ""]),
    );
    const analyzed = normalizeLocationImportValues(values, rowNumber);
    const errors = analyzed.errors;
    if (raw.length > headers.length) {
      errors.push(
        rowError("extra_columns", "row", "Remove columns beyond the header."),
      );
    }
    mutableResults.push({
      rowNumber,
      values,
      errors,
      normalized: analyzed.normalized,
    });
  }

  const externalIds = new Map<string, number[]>();
  const addresses = new Map<string, number[]>();
  for (const result of mutableResults) {
    const row = result.normalized!;
    if (row.externalPropertyId) {
      const key = row.externalPropertyId.toLowerCase();
      externalIds.set(key, [...(externalIds.get(key) ?? []), row.rowNumber]);
    }
    addresses.set(row.addressKey, [
      ...(addresses.get(row.addressKey) ?? []),
      row.rowNumber,
    ]);
  }
  for (const result of mutableResults) {
    const row = result.normalized!;
    if (
      row.externalPropertyId &&
      (externalIds.get(row.externalPropertyId.toLowerCase())?.length ?? 0) > 1
    ) {
      result.errors.push(
        rowError(
          "duplicate_in_file",
          "external_property_id",
          "This property ID appears more than once in the file.",
        ),
      );
    }
    if ((addresses.get(row.addressKey)?.length ?? 0) > 1) {
      result.errors.push(
        rowError(
          "duplicate_in_file",
          "address_line_1",
          "This normalized address appears more than once in the file.",
        ),
      );
    }
    if (
      row.parentExternalPropertyId &&
      row.externalPropertyId?.toLowerCase() ===
        row.parentExternalPropertyId.toLowerCase()
    ) {
      result.errors.push(
        rowError(
          "self_parent",
          "parent_external_property_id",
          "A location cannot be its own parent.",
        ),
      );
    }
  }
  if (
    mutableResults.filter((result) => result.normalized?.makeDefault).length > 1
  ) {
    for (const result of mutableResults.filter(
      (candidate) => candidate.normalized?.makeDefault,
    )) {
      result.errors.push(
        rowError(
          "multiple_defaults",
          "make_default",
          "Only one imported location can become the account default.",
        ),
      );
    }
  }
  // Reject cycles among new rows before any database write.
  const rowByExternalId = new Map(
    mutableResults.flatMap((result) =>
      result.normalized?.externalPropertyId
        ? [
            [
              result.normalized.externalPropertyId.toLowerCase(),
              result,
            ] as const,
          ]
        : [],
    ),
  );
  for (const result of mutableResults) {
    const visited = new Set<number>();
    let cursor: typeof result | undefined = result;
    while (cursor?.normalized?.parentExternalPropertyId) {
      if (visited.has(cursor.rowNumber)) {
        result.errors.push(
          rowError(
            "hierarchy_cycle",
            "parent_external_property_id",
            "The imported parent hierarchy contains a cycle.",
          ),
        );
        break;
      }
      visited.add(cursor.rowNumber);
      cursor = rowByExternalId.get(
        cursor.normalized.parentExternalPropertyId.toLowerCase(),
      );
    }
  }

  for (const result of mutableResults) {
    if (result.errors.length === 0) normalizedRows.push(result.normalized!);
  }
  const rowResults = mutableResults.map((result) =>
    Object.freeze({
      rowNumber: result.rowNumber,
      status:
        result.errors.length === 0 ? ("valid" as const) : ("invalid" as const),
      values: Object.freeze({ ...result.values }),
      errors: Object.freeze(result.errors.map((error) => Object.freeze(error))),
    }),
  );
  return Object.freeze({
    normalizedRows: Object.freeze(normalizedRows),
    rowResults: Object.freeze(rowResults),
    rowCount: rowResults.length,
    validRowCount: normalizedRows.length,
    invalidRowCount: rowResults.length - normalizedRows.length,
  });
}

export function partnerLocationDirectoryEtag(input: {
  accountId: string;
  version: number;
}): string {
  return createPortalV2StrongEtag(
    `partner-location-directory:${input.accountId}:${input.version}`,
  );
}

export function partnerLocationCsvCell(
  value: string | number | boolean | null | undefined,
): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function serializePartnerLocationCsv(
  rows: readonly LocationRow[],
  parentExternalIds: ReadonlyMap<string, string> = new Map(),
): string {
  const header = PARTNER_LOCATION_CSV_HEADERS.map(partnerLocationCsvCell).join(
    ",",
  );
  const body = rows.map((row) =>
    [
      row.siteName,
      row.externalPropertyId,
      row.addressLine1,
      row.addressLine2,
      row.city,
      row.state,
      row.postalCode,
      row.timezone,
      row.parentLocationId
        ? (parentExternalIds.get(row.parentLocationId) ?? "")
        : "",
      "false",
    ]
      .map(partnerLocationCsvCell)
      .join(","),
  );
  return [header, ...body].join("\r\n") + "\r\n";
}

export function serializePartnerLocationCorrectionCsv(
  results: readonly LocationImportRowResult[],
): string {
  const headers = [
    ...PARTNER_LOCATION_CSV_HEADERS,
    "error_codes",
    "error_messages",
  ];
  const lines = results.map((result) =>
    [
      ...PARTNER_LOCATION_CSV_HEADERS.map(
        (header) => result.values[header] ?? "",
      ),
      result.errors.map((error) => error.code).join("|"),
      result.errors
        .map((error) => `${error.field}: ${error.message}`)
        .join(" | "),
    ]
      .map(partnerLocationCsvCell)
      .join(","),
  );
  return (
    [headers.map(partnerLocationCsvCell).join(","), ...lines].join("\r\n") +
    "\r\n"
  );
}

export async function lockPartnerLocationDirectory(
  tx: Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0],
  accountId: string,
) {
  const [account] = await tx
    .select({
      id: partnerAccounts.id,
      defaultLocationId: partnerAccounts.defaultPartnerLocationId,
      version: partnerAccounts.locationDirectoryVersion,
    })
    .from(partnerAccounts)
    .where(eq(partnerAccounts.id, accountId))
    .for("update")
    .limit(1);
  return account ?? null;
}

export async function incrementPartnerLocationDirectory(
  tx: Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0],
  accountId: string,
  currentVersion: number,
) {
  const [account] = await tx
    .update(partnerAccounts)
    .set({
      locationDirectoryVersion: currentVersion + 1,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(partnerAccounts.id, accountId),
        eq(partnerAccounts.locationDirectoryVersion, currentVersion),
      ),
    )
    .returning({
      defaultLocationId: partnerAccounts.defaultPartnerLocationId,
      version: partnerAccounts.locationDirectoryVersion,
    });
  if (!account) throw new Error("partner_location_directory_revision_race");
  return account;
}

export async function findPartnerLocationDuplicates(
  tx: Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0],
  input: {
    accountId: string;
    externalPropertyId: string | null;
    address: {
      addressLine1: string;
      addressLine2?: string | null;
      city: string;
      state: string;
      postalCode: string;
    };
    excludeLocationId?: string;
  },
): Promise<
  readonly Readonly<{
    id: string;
    siteName: string;
    match: "external_id" | "address" | "probable_address";
    confidence: number;
    signals: readonly string[];
  }>[]
> {
  const addressKey = normalizePropertyAddress(input.address).addressKey;
  const rows = await tx
    .select({
      id: partnerAccountLocations.id,
      siteName: partnerAccountLocations.siteName,
      externalPropertyId: partnerAccountLocations.externalPropertyId,
      addressKey: properties.addressKey,
      addressLine1: partnerAccountLocations.addressLine1,
      addressLine2: partnerAccountLocations.addressLine2,
      city: partnerAccountLocations.city,
      state: partnerAccountLocations.state,
      postalCode: partnerAccountLocations.postalCode,
      active: partnerAccountLocations.active,
    })
    .from(partnerAccountLocations)
    .leftJoin(properties, eq(partnerAccountLocations.propertyId, properties.id))
    .where(eq(partnerAccountLocations.partnerAccountId, input.accountId))
    .limit(1_001);
  if (rows.length > 1_000)
    throw new Error("partner_location_duplicate_scan_too_large");
  return Object.freeze(
    rows.flatMap<
      Readonly<{
        id: string;
        siteName: string;
        match: "external_id" | "address" | "probable_address";
        confidence: number;
        signals: readonly string[];
      }>
    >((row) => {
      if (row.id === input.excludeLocationId) return [];
      if (
        input.externalPropertyId &&
        row.externalPropertyId?.toLowerCase() ===
          input.externalPropertyId.toLowerCase()
      ) {
        return [
          {
            id: row.id,
            siteName: row.siteName,
            match: "external_id" as const,
            confidence: 100,
            signals: Object.freeze(["external_property_id"]),
          },
        ];
      }
      if (row.addressKey === addressKey) {
        return [
          {
            id: row.id,
            siteName: row.siteName,
            match: "address" as const,
            confidence: 100,
            signals: Object.freeze(["normalized_address"]),
          },
        ];
      }
      const fuzzy = partnerLocationDuplicateConfidence(input.address, row);
      return fuzzy.confidence >= 75
        ? [
            {
              id: row.id,
              siteName: row.siteName,
              match: "probable_address" as const,
              confidence: fuzzy.confidence,
              signals: fuzzy.signals,
            },
          ]
        : [];
    }),
  );
}

function duplicateWords(value: string): string[] {
  const replacements: Readonly<Record<string, string>> = Object.freeze({
    avenue: "ave",
    boulevard: "blvd",
    circle: "cir",
    court: "ct",
    drive: "dr",
    highway: "hwy",
    lane: "ln",
    parkway: "pkwy",
    place: "pl",
    road: "rd",
    square: "sq",
    street: "st",
    terrace: "ter",
    trail: "trl",
    north: "n",
    south: "s",
    east: "e",
    west: "w",
  });
  return value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
    .map((word) => replacements[word] ?? word);
}

function duplicateText(value: string | null | undefined): string {
  return duplicateWords(value ?? "").join(" ");
}

function wordSimilarity(left: readonly string[], right: readonly string[]) {
  if (left.length === 0 || right.length === 0) return 0;
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  let intersection = 0;
  for (const word of leftSet) {
    if (rightSet.has(word)) intersection += 1;
  }
  return (2 * intersection) / (leftSet.size + rightSet.size);
}

/** Deterministic, provider-independent duplicate hinting. Unit/suite values
 * intentionally lower confidence so neighboring units are never silently
 * collapsed into one service location. */
export function partnerLocationDuplicateConfidence(
  left: {
    addressLine1: string;
    addressLine2?: string | null;
    city: string;
    state: string;
    postalCode: string;
  },
  right: {
    addressLine1: string;
    addressLine2?: string | null;
    city: string;
    state: string;
    postalCode: string;
  },
): Readonly<{ confidence: number; signals: readonly string[] }> {
  const signals: string[] = [];
  const leftPostal = duplicateText(left.postalCode).slice(0, 5);
  const rightPostal = duplicateText(right.postalCode).slice(0, 5);
  if (!leftPostal || leftPostal !== rightPostal) {
    return Object.freeze({ confidence: 0, signals: Object.freeze(signals) });
  }
  signals.push("postal_code");
  if (duplicateText(left.state) !== duplicateText(right.state)) {
    return Object.freeze({ confidence: 0, signals: Object.freeze(signals) });
  }
  signals.push("state");
  if (duplicateText(left.city) === duplicateText(right.city)) {
    signals.push("city");
  } else {
    return Object.freeze({ confidence: 40, signals: Object.freeze(signals) });
  }
  const leftStreet = duplicateWords(left.addressLine1);
  const rightStreet = duplicateWords(right.addressLine1);
  const leftNumber = leftStreet.find((word) => /^\d+[a-z]?$/u.test(word));
  const rightNumber = rightStreet.find((word) => /^\d+[a-z]?$/u.test(word));
  if (!leftNumber || leftNumber !== rightNumber) {
    return Object.freeze({ confidence: 45, signals: Object.freeze(signals) });
  }
  signals.push("street_number");
  const similarity = wordSimilarity(leftStreet, rightStreet);
  if (similarity < 0.72) {
    return Object.freeze({ confidence: 55, signals: Object.freeze(signals) });
  }
  signals.push("street_name");
  const leftUnit = duplicateText(left.addressLine2);
  const rightUnit = duplicateText(right.addressLine2);
  if (leftUnit && rightUnit && leftUnit !== rightUnit) {
    signals.push("different_unit");
    return Object.freeze({ confidence: 75, signals: Object.freeze(signals) });
  }
  if (leftUnit === rightUnit) signals.push("unit");
  else signals.push("unit_unspecified");
  return Object.freeze({
    confidence: leftUnit === rightUnit ? 94 : 86,
    signals: Object.freeze(signals),
  });
}

export async function getPartnerLocationPortfolioMetadata(input: {
  accountId: string;
  membershipId: string;
  locationIds: readonly string[];
}) {
  const db = getDb();
  const [account, favorites, children] = await Promise.all([
    db
      .select({
        defaultLocationId: partnerAccounts.defaultPartnerLocationId,
        directoryVersion: partnerAccounts.locationDirectoryVersion,
      })
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, input.accountId))
      .limit(1)
      .then((rows) => rows[0] ?? null),
    input.locationIds.length
      ? db
          .select({ locationId: partnerLocationFavorites.locationId })
          .from(partnerLocationFavorites)
          .where(
            and(
              eq(partnerLocationFavorites.partnerAccountId, input.accountId),
              eq(partnerLocationFavorites.membershipId, input.membershipId),
              inArray(partnerLocationFavorites.locationId, [
                ...input.locationIds,
              ]),
            ),
          )
      : Promise.resolve([]),
    input.locationIds.length
      ? db
          .select({
            parentLocationId: partnerAccountLocations.parentLocationId,
          })
          .from(partnerAccountLocations)
          .where(
            and(
              eq(partnerAccountLocations.partnerAccountId, input.accountId),
              eq(partnerAccountLocations.active, true),
              inArray(partnerAccountLocations.parentLocationId, [
                ...input.locationIds,
              ]),
            ),
          )
      : Promise.resolve([]),
  ]);
  if (!account) return null;
  const childCounts = new Map<string, number>();
  for (const child of children) {
    if (!child.parentLocationId) continue;
    childCounts.set(
      child.parentLocationId,
      (childCounts.get(child.parentLocationId) ?? 0) + 1,
    );
  }
  return {
    defaultLocationId: account.defaultLocationId,
    directoryVersion: account.directoryVersion,
    favoriteLocationIds: new Set(
      favorites.map((favorite) => favorite.locationId),
    ),
    childCounts,
  };
}

export async function getPartnerLocationArchiveImpact(
  tx: Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0],
  input: {
    accountId: string;
    location: LocationRow;
    defaultLocationId: string | null;
  },
): Promise<PartnerLocationArchiveImpact> {
  const [children, alternatives, drafts, templates, jobs, quoteBindings] =
    await Promise.all([
      tx
        .select({ count: sql<number>`count(*)::integer` })
        .from(partnerAccountLocations)
        .where(
          and(
            eq(partnerAccountLocations.partnerAccountId, input.accountId),
            eq(partnerAccountLocations.parentLocationId, input.location.id),
            eq(partnerAccountLocations.active, true),
          ),
        ),
      tx
        .select({ count: sql<number>`count(*)::integer` })
        .from(partnerAccountLocations)
        .where(
          and(
            eq(partnerAccountLocations.partnerAccountId, input.accountId),
            eq(partnerAccountLocations.active, true),
            sql`${partnerAccountLocations.id} <> ${input.location.id}`,
          ),
        ),
      tx
        .select({ count: sql<number>`count(*)::integer` })
        .from(partnerBookingDrafts)
        .where(
          and(
            eq(partnerBookingDrafts.partnerAccountId, input.accountId),
            eq(partnerBookingDrafts.locationId, input.location.id),
            inArray(partnerBookingDrafts.state, [
              "draft",
              "ready",
              "submitted",
            ]),
          ),
        ),
      tx
        .select({ count: sql<number>`count(*)::integer` })
        .from(partnerServiceTemplates)
        .where(
          and(
            eq(partnerServiceTemplates.partnerAccountId, input.accountId),
            eq(partnerServiceTemplates.locationId, input.location.id),
            eq(partnerServiceTemplates.active, true),
          ),
        ),
      input.location.propertyId
        ? tx
            .select({ count: sql<number>`count(*)::integer` })
            .from(partnerBookings)
            .where(
              and(
                eq(partnerBookings.partnerAccountId, input.accountId),
                eq(partnerBookings.propertyId, input.location.propertyId),
              ),
            )
        : Promise.resolve([]),
      tx
        .select({
          canonicalQuoteV2Count: sql<number>`count(*) filter (
          where ${quotes.aggregateState} in ('draft', 'open')
            and ${quotes.currentVersionId} = ${quoteVersions.id}
            and ${quoteVersions.state} in ('draft', 'ready', 'issued')
        )::integer`,
          issuedActionableQuoteV2Count: sql<number>`count(*) filter (
          where ${quotes.aggregateState} = 'open'
            and ${quotes.currentVersionId} = ${quoteVersions.id}
            and ${quotes.publishedVersionId} = ${quoteVersions.id}
            and ${quoteVersions.state} = 'issued'
            and ${quoteVersions.issuedAt} is not null
            and ${quoteVersions.expiresAt} > current_timestamp
            and not exists (
              select 1 from quote_responses location_quote_response
              where location_quote_response.quote_id = ${quotes.id}
                and location_quote_response.quote_version_id = ${quoteVersions.id}
                and location_quote_response.response_type in ('accepted', 'declined')
            )
            and not exists (
              select 1 from quote_change_requests location_quote_change
              where location_quote_change.quote_id = ${quotes.id}
                and location_quote_change.status in ('open', 'acknowledged')
            )
        )::integer`,
        })
        .from(partnerQuotes)
        .innerJoin(
          quotes,
          and(
            eq(quotes.id, partnerQuotes.quoteId),
            eq(quotes.partnerAccountId, partnerQuotes.partnerAccountId),
          ),
        )
        .leftJoin(
          quoteVersions,
          and(
            eq(quoteVersions.id, quotes.currentVersionId),
            eq(quoteVersions.quoteId, quotes.id),
          ),
        )
        .where(
          and(
            eq(partnerQuotes.partnerAccountId, input.accountId),
            eq(partnerQuotes.authority, "quote_v2"),
            partnerQuoteBoundToLocationExpression({
              locationId: input.location.id,
              propertyId: input.location.propertyId,
            }),
          ),
        ),
    ]);
  return Object.freeze({
    isDefault: input.defaultLocationId === input.location.id,
    activeChildCount: children[0]?.count ?? 0,
    activeAlternativeCount: alternatives[0]?.count ?? 0,
    openDraftCount: drafts[0]?.count ?? 0,
    activeTemplateCount: templates[0]?.count ?? 0,
    jobHistoryCount: jobs[0]?.count ?? 0,
    canonicalQuoteV2Count: quoteBindings[0]?.canonicalQuoteV2Count ?? 0,
    issuedActionableQuoteV2Count:
      quoteBindings[0]?.issuedActionableQuoteV2Count ?? 0,
  });
}

export function locationImportRequestHash(csv: string): string {
  return createHash("sha256").update(csv, "utf8").digest("hex");
}

export function validatePartnerLocationImportAgainstPortfolio(
  analysis: PartnerLocationImportAnalysis,
  existing: readonly Readonly<{
    id: string;
    externalPropertyId: string | null;
    addressKey: string | null;
    active: boolean;
  }>[],
): PartnerLocationImportAnalysis {
  const existingByExternal = new Map(
    existing.flatMap((location) =>
      location.externalPropertyId
        ? [[location.externalPropertyId.toLowerCase(), location] as const]
        : [],
    ),
  );
  const existingByAddress = new Map(
    existing.flatMap((location) =>
      location.addressKey ? [[location.addressKey, location] as const] : [],
    ),
  );
  const importedByExternal = new Map(
    analysis.normalizedRows.flatMap((row) =>
      row.externalPropertyId
        ? [[row.externalPropertyId.toLowerCase(), row] as const]
        : [],
    ),
  );
  const normalizedByNumber = new Map(
    analysis.normalizedRows.map((row) => [row.rowNumber, row]),
  );
  const nextResults: LocationImportRowResult[] = analysis.rowResults.map(
    (result) => {
      const row = normalizedByNumber.get(result.rowNumber);
      if (!row || result.errors.length > 0) return result;
      const errors = [...result.errors];
      const externalDuplicate = row.externalPropertyId
        ? existingByExternal.get(row.externalPropertyId.toLowerCase())
        : null;
      const addressDuplicate = existingByAddress.get(row.addressKey);
      if (externalDuplicate) {
        errors.push(
          rowError(
            "duplicate_existing",
            "external_property_id",
            "This property ID already belongs to an account location.",
          ),
        );
      }
      if (addressDuplicate) {
        errors.push(
          rowError(
            "duplicate_existing",
            "address_line_1",
            "This normalized address already belongs to an account location.",
          ),
        );
      }
      if (row.parentExternalPropertyId) {
        const key = row.parentExternalPropertyId.toLowerCase();
        const existingParent = existingByExternal.get(key);
        const importedParent = importedByExternal.get(key);
        if (!existingParent && !importedParent) {
          errors.push(
            rowError(
              "parent_not_found",
              "parent_external_property_id",
              "The parent must be an active account location or another valid row.",
            ),
          );
        } else if (existingParent && !existingParent.active) {
          errors.push(
            rowError(
              "parent_inactive",
              "parent_external_property_id",
              "An archived location cannot be used as a parent.",
            ),
          );
        }
      }
      return Object.freeze({
        ...result,
        status: errors.length ? ("invalid" as const) : ("valid" as const),
        errors: Object.freeze(errors),
      });
    },
  );
  const resultByNumber = new Map(
    nextResults.map((result) => [result.rowNumber, result]),
  );
  const importedNumberByExternal = new Map(
    analysis.normalizedRows.flatMap((row) =>
      row.externalPropertyId
        ? [[row.externalPropertyId.toLowerCase(), row.rowNumber] as const]
        : [],
    ),
  );
  const propagatedResults = nextResults.map((result) => {
    if (result.errors.length > 0) return result;
    const row = normalizedByNumber.get(result.rowNumber);
    if (!row?.parentExternalPropertyId) return result;
    const parentRowNumber = importedNumberByExternal.get(
      row.parentExternalPropertyId.toLowerCase(),
    );
    if (
      !parentRowNumber ||
      (resultByNumber.get(parentRowNumber)?.errors.length ?? 0) === 0
    ) {
      return result;
    }
    return Object.freeze({
      ...result,
      status: "invalid" as const,
      errors: Object.freeze([
        ...result.errors,
        rowError(
          "parent_row_invalid",
          "parent_external_property_id",
          "Correct the imported parent row before importing this location.",
        ),
      ]),
    });
  });
  const validNumbers = new Set(
    propagatedResults
      .filter((result) => result.errors.length === 0)
      .map((result) => result.rowNumber),
  );
  const normalizedRows = analysis.normalizedRows.filter((row) =>
    validNumbers.has(row.rowNumber),
  );
  return Object.freeze({
    normalizedRows: Object.freeze(normalizedRows),
    rowResults: Object.freeze(propagatedResults),
    rowCount: propagatedResults.length,
    validRowCount: normalizedRows.length,
    invalidRowCount: propagatedResults.length - normalizedRows.length,
  });
}

export function canManageAccountLocationPortfolio(
  principal: PartnerPrincipal,
): boolean {
  return (
    principal.accountId !== null &&
    principal.membershipId !== null &&
    principal.accessLevel === "account" &&
    principal.capabilities.includes("properties.manage")
  );
}

export async function auditPartnerLocationPortfolio(
  tx: Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0],
  input: {
    principal: PartnerPrincipal;
    correlationId: string;
    action: string;
    entityType: string;
    entityId: string;
    idempotencyKeyHash?: string | null;
    requiredPermission?: PartnerCapability;
    meta: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditLogs).values({
    actorType: "human",
    actorId: input.principal.partnerUserId,
    actorLabel: input.principal.email,
    actorRole: input.principal.roleKey,
    sessionId: input.principal.session.id,
    authMethod: "partner_session",
    correlationId: input.correlationId,
    requiredPermissions: [input.requiredPermission ?? "properties.manage"],
    surface: "partner_portal_v2",
    idempotencyKeyHash: input.idempotencyKeyHash ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    meta: input.meta,
  });
}

function locationImportRowsEqual(
  left: LocationImportRow,
  right: LocationImportRow,
): boolean {
  return (
    left.rowNumber === right.rowNumber &&
    left.siteName === right.siteName &&
    left.externalPropertyId === right.externalPropertyId &&
    left.addressLine1 === right.addressLine1 &&
    left.addressLine2 === right.addressLine2 &&
    left.city === right.city &&
    left.state === right.state &&
    left.postalCode === right.postalCode &&
    left.timezone === right.timezone &&
    left.parentExternalPropertyId === right.parentExternalPropertyId &&
    left.makeDefault === right.makeDefault &&
    left.addressKey === right.addressKey
  );
}

export function isLocationImportRow(
  value: unknown,
): value is LocationImportRow {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const basicShape =
    Number.isInteger(row["rowNumber"]) &&
    typeof row["siteName"] === "string" &&
    (row["externalPropertyId"] === null ||
      typeof row["externalPropertyId"] === "string") &&
    typeof row["addressLine1"] === "string" &&
    (row["addressLine2"] === null || typeof row["addressLine2"] === "string") &&
    typeof row["city"] === "string" &&
    typeof row["state"] === "string" &&
    typeof row["postalCode"] === "string" &&
    typeof row["timezone"] === "string" &&
    (row["parentExternalPropertyId"] === null ||
      typeof row["parentExternalPropertyId"] === "string") &&
    typeof row["makeDefault"] === "boolean" &&
    typeof row["addressKey"] === "string";
  if (!basicShape) return false;
  const typed = row as unknown as LocationImportRow;
  if (
    typed.rowNumber < 2 ||
    typed.rowNumber > PARTNER_LOCATION_IMPORT_MAX_ROWS + 1
  ) {
    return false;
  }
  const analyzed = normalizeLocationImportValues(
    {
      site_name: typed.siteName,
      external_property_id: typed.externalPropertyId ?? "",
      address_line_1: typed.addressLine1,
      address_line_2: typed.addressLine2 ?? "",
      city: typed.city,
      state: typed.state,
      postal_code: typed.postalCode,
      timezone: typed.timezone,
      parent_external_property_id: typed.parentExternalPropertyId ?? "",
      make_default: typed.makeDefault ? "true" : "false",
    },
    typed.rowNumber,
  );
  return (
    analyzed.errors.length === 0 &&
    locationImportRowsEqual(analyzed.normalized, typed)
  );
}

export function isLocationImportRowResult(
  value: unknown,
): value is LocationImportRowResult {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const values = row["values"];
  const errors = row["errors"];
  return (
    Number.isInteger(row["rowNumber"]) &&
    (row["status"] === "valid" || row["status"] === "invalid") &&
    Boolean(values) &&
    typeof values === "object" &&
    !Array.isArray(values) &&
    Object.keys(values as Record<string, unknown>).every((key) =>
      PARTNER_LOCATION_CSV_HEADERS.includes(
        key as (typeof PARTNER_LOCATION_CSV_HEADERS)[number],
      ),
    ) &&
    Object.values(values as Record<string, unknown>).every(
      (item) => typeof item === "string",
    ) &&
    Array.isArray(errors) &&
    errors.every(
      (error) =>
        Boolean(error) &&
        typeof error === "object" &&
        typeof (error as Record<string, unknown>)["code"] === "string" &&
        typeof (error as Record<string, unknown>)["field"] === "string" &&
        typeof (error as Record<string, unknown>)["message"] === "string",
    )
  );
}

/**
 * Rebuilds a valid row from the retained correction values before commit.
 * This rejects pre-fix evidence whose raw input was silently truncated during
 * dry-run, even if its stored normalized row happens to fit the DB columns.
 */
export function isLocationImportRowEvidenceConsistent(
  row: LocationImportRow,
  result: LocationImportRowResult,
): boolean {
  if (
    result.rowNumber !== row.rowNumber ||
    result.status !== "valid" ||
    result.errors.length !== 0
  ) {
    return false;
  }
  const analyzed = normalizeLocationImportValues(result.values, row.rowNumber);
  return (
    analyzed.errors.length === 0 &&
    locationImportRowsEqual(analyzed.normalized, row)
  );
}

export function serializePartnerLocationImportOperation(
  operation: typeof partnerLocationImports.$inferSelect,
) {
  const results = Array.isArray(operation.rowResults)
    ? operation.rowResults.filter(isLocationImportRowResult)
    : [];
  if (results.length !== operation.rowCount) {
    throw new Error("partner_location_import_evidence_invalid");
  }
  return Object.freeze({
    id: operation.id,
    state: operation.state,
    directoryVersion: operation.directoryVersion,
    rowCount: operation.rowCount,
    validRowCount: operation.validRowCount,
    invalidRowCount: operation.invalidRowCount,
    rows: Object.freeze(results),
    canCommit:
      operation.state === "validated" &&
      operation.invalidRowCount === 0 &&
      operation.expiresAt.getTime() > Date.now(),
    correctionsUrl: `/api/portal/v2/locations/imports/${operation.id}/corrections`,
    expiresAt: operation.expiresAt.toISOString(),
    purgeAfter: operation.purgeAfter.toISOString(),
    committedAt: operation.committedAt?.toISOString() ?? null,
    revision: operation.revision,
    etag: createPortalV2StrongEtag(
      `partner-location-import:${operation.id}:${operation.revision}`,
    ),
  });
}

export function isPortalLocationUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export { partnerLocationImports };
