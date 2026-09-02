import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import {
  quoteActivityEvents,
  quoteResponses,
  quoteVersionDocuments,
  quoteVersions,
  quotes,
  type DatabaseClient,
} from "@/db";
import { QuoteDocumentSnapshotSchema } from "@/lib/quote-v2-contract";
import { hashQuoteContent } from "@/lib/quote-v2-domain";
import {
  getMediaStorageBucket,
  getMediaStorageProvider,
  putImmutableMediaObject,
} from "@/lib/media-storage";
import {
  renderQuoteAcceptanceCertificate,
  type QuoteAcceptanceCertificateSchema,
} from "@/lib/quote-v2-pdf";
import { buildQuoteRenderModel } from "@/lib/quote-v2-render-model";

const HASH_PATTERN = /^[0-9a-f]{64}$/u;

const SignerSnapshotSchema = z
  .object({
    name: z.string().trim().min(1).max(240),
    title: z.string().trim().min(1).max(160),
    company: z.string().trim().max(240).nullable().optional(),
    authorityAffirmed: z.literal(true),
  })
  .passthrough();

const ConfigurationSnapshotSchema = z
  .object({
    documentType: z.enum(["fixed_quote", "estimate", "range"]),
    schedulingMode: z.enum([
      "self_schedule",
      "staff_followup",
      "approval_only",
    ]),
    selectedOptionIds: z.array(z.string().trim().min(1).max(80)).max(100),
    requestedStartAt: z
      .string()
      .datetime({ offset: true })
      .nullable()
      .optional(),
    holdId: z.string().uuid().nullable().optional(),
    totals: z
      .object({
        totalMinCents: z.number().int().positive(),
        totalMaxCents: z.number().int().positive(),
        depositCents: z.number().int().nonnegative(),
        balanceMinCents: z.number().int().nonnegative(),
        balanceMaxCents: z.number().int().nonnegative(),
      })
      .passthrough(),
  })
  .passthrough();

export type QuoteAcceptanceCertificateSource = {
  quoteId: string;
  versionId: string;
  responseId: string;
  quoteNumber: string;
  versionNumber: number;
  aggregateState: string;
  versionState: string;
  issuedAt: Date;
  expiresAt: Date;
  acceptedAt: Date;
  documentSnapshot: Record<string, unknown>;
  signerSnapshot: Record<string, unknown>;
  configurationSnapshot: Record<string, unknown>;
  selectedOptionIds: string[];
  consentText: string;
  consentVersion: string;
  consentAffirmed: boolean;
  configurationHash: string;
  consentHash: string;
  contentHash: string;
  versionContentHash: string;
  issuedPdfHash: string;
  proposalDocumentHash: string;
  acceptedTotalMinCents: number;
  acceptedTotalMaxCents: number;
  acceptedDepositCents: number;
  acceptedBalanceMinCents: number;
  acceptedBalanceMaxCents: number;
};

export type PreparedQuoteAcceptanceCertificate = {
  quoteId: string;
  versionId: string;
  responseId: string;
  filename: string;
  storageObjectKey: string;
  byteSize: number;
  sha256: string;
  body: Buffer;
  metadata: Record<string, unknown>;
};

export class QuoteAcceptanceCertificateError extends Error {
  readonly code: "not_found" | "not_accepted" | "evidence_mismatch";

  constructor(code: QuoteAcceptanceCertificateError["code"], message: string) {
    super(message);
    this.name = "QuoteAcceptanceCertificateError";
    this.code = code;
  }
}

function exactStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function assertHash(value: string, label: string): void {
  if (!HASH_PATTERN.test(value)) {
    throw new QuoteAcceptanceCertificateError(
      "evidence_mismatch",
      `${label} is not valid immutable evidence.`,
    );
  }
}

export async function prepareQuoteAcceptanceCertificate(
  source: QuoteAcceptanceCertificateSource,
): Promise<PreparedQuoteAcceptanceCertificate> {
  if (
    source.aggregateState !== "accepted" ||
    source.versionState !== "accepted"
  ) {
    throw new QuoteAcceptanceCertificateError(
      "not_accepted",
      "An acceptance certificate requires an accepted quote version.",
    );
  }
  const document = QuoteDocumentSnapshotSchema.safeParse(
    source.documentSnapshot,
  );
  const signer = SignerSnapshotSchema.safeParse(source.signerSnapshot);
  const configuration = ConfigurationSnapshotSchema.safeParse(
    source.configurationSnapshot,
  );
  if (!document.success || !signer.success || !configuration.success) {
    throw new QuoteAcceptanceCertificateError(
      "evidence_mismatch",
      "The acceptance signer or configuration snapshot is incomplete.",
    );
  }
  if (
    document.data.documentType !== configuration.data.documentType ||
    document.data.schedulingMode !== configuration.data.schedulingMode ||
    !source.consentAffirmed ||
    source.consentVersion !== document.data.terms.consentVersion
  ) {
    throw new QuoteAcceptanceCertificateError(
      "evidence_mismatch",
      "The acceptance does not match the issued proposal configuration or consent.",
    );
  }
  for (const [value, label] of [
    [source.configurationHash, "Configuration hash"],
    [source.consentHash, "Consent hash"],
    [source.contentHash, "Response content hash"],
    [source.versionContentHash, "Version content hash"],
    [source.issuedPdfHash, "Issued PDF hash"],
    [source.proposalDocumentHash, "Proposal document hash"],
  ] as const) {
    assertHash(value, label);
  }
  if (
    source.configurationHash !==
      hashQuoteContent(source.configurationSnapshot) ||
    source.consentHash !==
      hashQuoteContent({
        text: source.consentText,
        version: source.consentVersion,
        affirmed: true,
      }) ||
    source.contentHash !== source.versionContentHash ||
    source.issuedPdfHash !== source.proposalDocumentHash
  ) {
    throw new QuoteAcceptanceCertificateError(
      "evidence_mismatch",
      "The acceptance hashes do not reconcile to the immutable proposal evidence.",
    );
  }
  const configuredOptionIds = [...configuration.data.selectedOptionIds].sort();
  const responseOptionIds = [...source.selectedOptionIds].sort();
  if (!exactStringArray(configuredOptionIds, responseOptionIds)) {
    throw new QuoteAcceptanceCertificateError(
      "evidence_mismatch",
      "The accepted option selection does not match its configuration snapshot.",
    );
  }

  const model = buildQuoteRenderModel({
    quoteId: source.quoteId,
    versionId: source.versionId,
    quoteNumber: source.quoteNumber,
    versionNumber: source.versionNumber,
    issuedAt: source.issuedAt,
    expiresAt: source.expiresAt,
    document: document.data,
    selectedOptionIds: responseOptionIds,
    attachments: [],
  });
  const accepted = {
    totalMinCents: source.acceptedTotalMinCents,
    totalMaxCents: source.acceptedTotalMaxCents,
    depositCents: source.acceptedDepositCents,
    balanceMinCents: source.acceptedBalanceMinCents,
    balanceMaxCents: source.acceptedBalanceMaxCents,
  };
  if (
    model.totals.totalMinCents !== accepted.totalMinCents ||
    model.totals.totalMaxCents !== accepted.totalMaxCents ||
    model.totals.depositCents !== accepted.depositCents ||
    model.totals.balanceMinCents !== accepted.balanceMinCents ||
    model.totals.balanceMaxCents !== accepted.balanceMaxCents ||
    configuration.data.totals.totalMinCents !== accepted.totalMinCents ||
    configuration.data.totals.totalMaxCents !== accepted.totalMaxCents ||
    configuration.data.totals.depositCents !== accepted.depositCents ||
    configuration.data.totals.balanceMinCents !== accepted.balanceMinCents ||
    configuration.data.totals.balanceMaxCents !== accepted.balanceMaxCents
  ) {
    throw new QuoteAcceptanceCertificateError(
      "evidence_mismatch",
      "The accepted totals do not reconcile to the selected proposal options.",
    );
  }

  const evidence: z.input<typeof QuoteAcceptanceCertificateSchema> = {
    responseId: source.responseId,
    signerName: signer.data.name,
    signerTitle: signer.data.title,
    signerCompany: signer.data.company ?? null,
    authorityAffirmed: true,
    acceptedAt: source.acceptedAt,
    consentText: source.consentText,
    consentVersion: source.consentVersion,
    selectedOptionIds: responseOptionIds,
    acceptedTotalMinCents: accepted.totalMinCents,
    acceptedTotalMaxCents: accepted.totalMaxCents,
    acceptedDepositCents: accepted.depositCents,
    acceptedBalanceMinCents: accepted.balanceMinCents,
    acceptedBalanceMaxCents: accepted.balanceMaxCents,
    configurationHash: source.configurationHash,
    consentHash: source.consentHash,
    contentHash: source.contentHash,
    issuedPdfHash: source.issuedPdfHash,
  };
  const body = await renderQuoteAcceptanceCertificate({
    model,
    issuedContentHash: source.versionContentHash,
    evidence,
  });
  const sha256 = createHash("sha256").update(body).digest("hex");
  const storageObjectKey =
    `quotes/${source.quoteId}/versions/${source.versionId}/` +
    `acceptance-${source.responseId}-${sha256}.pdf`;
  return {
    quoteId: source.quoteId,
    versionId: source.versionId,
    responseId: source.responseId,
    filename: `${source.quoteNumber}-v${source.versionNumber}-accepted.pdf`,
    storageObjectKey,
    byteSize: body.byteLength,
    sha256,
    body,
    metadata: {
      evidenceSchemaVersion: 1,
      responseId: source.responseId,
      configurationHash: source.configurationHash,
      consentHash: source.consentHash,
      contentHash: source.contentHash,
      issuedPdfHash: source.issuedPdfHash,
    },
  };
}

function metadataHash(
  metadata: Record<string, unknown>,
  key: string,
): string | null {
  const value = metadata[key];
  return typeof value === "string" ? value : null;
}

function existingCertificateMatches(
  row: {
    metadata: Record<string, unknown>;
    sha256: string;
  },
  source: QuoteAcceptanceCertificateSource,
  expectedSha256: string,
): boolean {
  return (
    row.sha256 === expectedSha256 &&
    row.metadata["evidenceSchemaVersion"] === 1 &&
    metadataHash(row.metadata, "responseId") === source.responseId &&
    metadataHash(row.metadata, "configurationHash") ===
      source.configurationHash &&
    metadataHash(row.metadata, "consentHash") === source.consentHash &&
    metadataHash(row.metadata, "contentHash") === source.contentHash &&
    metadataHash(row.metadata, "issuedPdfHash") === source.issuedPdfHash
  );
}

async function loadAcceptanceSource(
  db: DatabaseClient,
  responseId: string,
): Promise<{
  source: QuoteAcceptanceCertificateSource;
  existing: Array<{
    id: string;
    sha256: string;
    metadata: Record<string, unknown>;
  }>;
} | null> {
  const [row] = await db
    .select({
      quoteId: quotes.id,
      versionId: quoteVersions.id,
      responseId: quoteResponses.id,
      quoteNumber: quotes.quoteNumber,
      engineVersion: quotes.engineVersion,
      aggregateState: quotes.aggregateState,
      publishedVersionId: quotes.publishedVersionId,
      versionNumber: quoteVersions.versionNumber,
      versionState: quoteVersions.state,
      issuedAt: quoteVersions.issuedAt,
      expiresAt: quoteVersions.expiresAt,
      documentSnapshot: quoteVersions.documentSnapshot,
      versionContentHash: quoteVersions.contentHash,
      responseType: quoteResponses.responseType,
      acceptedAt: quoteResponses.respondedAt,
      signerSnapshot: quoteResponses.signerSnapshot,
      configurationSnapshot: quoteResponses.configurationSnapshot,
      selectedOptionIds: quoteResponses.selectedOptionIds,
      consentText: quoteResponses.consentText,
      consentVersion: quoteResponses.consentVersion,
      consentAffirmed: quoteResponses.consentAffirmed,
      configurationHash: quoteResponses.configurationHash,
      consentHash: quoteResponses.consentHash,
      contentHash: quoteResponses.contentHash,
      issuedPdfHash: quoteResponses.issuedPdfHash,
      acceptedTotalMinCents: quoteResponses.acceptedTotalMinCents,
      acceptedTotalMaxCents: quoteResponses.acceptedTotalMaxCents,
      acceptedDepositCents: quoteResponses.acceptedDepositCents,
      acceptedBalanceMinCents: quoteResponses.acceptedBalanceMinCents,
      acceptedBalanceMaxCents: quoteResponses.acceptedBalanceMaxCents,
    })
    .from(quoteResponses)
    .innerJoin(
      quoteVersions,
      and(
        eq(quoteVersions.id, quoteResponses.quoteVersionId),
        eq(quoteVersions.quoteId, quoteResponses.quoteId),
      ),
    )
    .innerJoin(quotes, eq(quotes.id, quoteResponses.quoteId))
    .where(eq(quoteResponses.id, responseId))
    .limit(1);
  if (!row || row.engineVersion !== "v2" || row.responseType !== "accepted") {
    return null;
  }
  const documents = await db
    .select({
      id: quoteVersionDocuments.id,
      kind: quoteVersionDocuments.kind,
      sha256: quoteVersionDocuments.sha256,
      metadata: quoteVersionDocuments.metadata,
    })
    .from(quoteVersionDocuments)
    .where(eq(quoteVersionDocuments.quoteVersionId, row.versionId))
    .orderBy(desc(quoteVersionDocuments.generatedAt));
  const proposal = documents.find(
    (document) =>
      document.kind === "proposal_pdf" && document.sha256 === row.issuedPdfHash,
  );
  if (
    !row.quoteNumber ||
    row.aggregateState !== "accepted" ||
    row.versionState !== "accepted" ||
    row.publishedVersionId !== row.versionId ||
    !row.issuedAt ||
    !row.expiresAt ||
    !row.versionContentHash ||
    !row.signerSnapshot ||
    !row.configurationSnapshot ||
    !row.consentText ||
    !row.consentVersion ||
    row.consentAffirmed !== true ||
    !row.configurationHash ||
    !row.consentHash ||
    !row.contentHash ||
    !row.issuedPdfHash ||
    row.acceptedTotalMinCents === null ||
    row.acceptedTotalMaxCents === null ||
    row.acceptedDepositCents === null ||
    row.acceptedBalanceMinCents === null ||
    row.acceptedBalanceMaxCents === null ||
    !proposal
  ) {
    throw new QuoteAcceptanceCertificateError(
      "evidence_mismatch",
      "The accepted response is missing immutable certificate evidence.",
    );
  }
  return {
    source: {
      quoteId: row.quoteId,
      versionId: row.versionId,
      responseId: row.responseId,
      quoteNumber: row.quoteNumber,
      versionNumber: row.versionNumber,
      aggregateState: row.aggregateState,
      versionState: row.versionState,
      issuedAt: row.issuedAt,
      expiresAt: row.expiresAt,
      acceptedAt: row.acceptedAt,
      documentSnapshot: row.documentSnapshot,
      signerSnapshot: row.signerSnapshot,
      configurationSnapshot: row.configurationSnapshot,
      selectedOptionIds: row.selectedOptionIds,
      consentText: row.consentText,
      consentVersion: row.consentVersion,
      consentAffirmed: row.consentAffirmed,
      configurationHash: row.configurationHash,
      consentHash: row.consentHash,
      contentHash: row.contentHash,
      versionContentHash: row.versionContentHash,
      issuedPdfHash: row.issuedPdfHash,
      proposalDocumentHash: proposal.sha256,
      acceptedTotalMinCents: row.acceptedTotalMinCents,
      acceptedTotalMaxCents: row.acceptedTotalMaxCents,
      acceptedDepositCents: row.acceptedDepositCents,
      acceptedBalanceMinCents: row.acceptedBalanceMinCents,
      acceptedBalanceMaxCents: row.acceptedBalanceMaxCents,
    },
    existing: documents
      .filter((document) => document.kind === "acceptance_pdf")
      .map((document) => ({
        id: document.id,
        sha256: document.sha256,
        metadata: document.metadata,
      })),
  };
}

export type QuoteAcceptanceCertificateReceipt = {
  documentId: string;
  quoteId: string;
  versionId: string;
  responseId: string;
  sha256: string;
  state: "created" | "existing";
};

export type QuoteAcceptanceCertificateReconciliation =
  | Readonly<{
      state: "ready";
      documentId: string;
      sha256: string;
    }>
  | Readonly<{
      state: "pending";
      retryable: boolean;
    }>;

export async function ensureQuoteAcceptanceCertificate(
  db: DatabaseClient,
  input: {
    responseId: string;
    generatedByTeamMemberId?: string | null;
    correlationId?: string | null;
    now?: Date;
  },
): Promise<QuoteAcceptanceCertificateReceipt> {
  const loaded = await loadAcceptanceSource(db, input.responseId);
  if (!loaded) {
    throw new QuoteAcceptanceCertificateError(
      "not_found",
      "The accepted response was not found.",
    );
  }
  const artifact = await prepareQuoteAcceptanceCertificate(loaded.source);
  for (const existing of loaded.existing) {
    if (existingCertificateMatches(existing, loaded.source, artifact.sha256)) {
      return {
        documentId: existing.id,
        quoteId: loaded.source.quoteId,
        versionId: loaded.source.versionId,
        responseId: loaded.source.responseId,
        sha256: existing.sha256,
        state: "existing",
      };
    }
  }
  if (loaded.existing.length > 0) {
    throw new QuoteAcceptanceCertificateError(
      "evidence_mismatch",
      "An acceptance certificate exists with conflicting evidence.",
    );
  }

  const storageProvider = getMediaStorageProvider();
  const storageBucket = getMediaStorageBucket();
  await putImmutableMediaObject({
    key: artifact.storageObjectKey,
    body: artifact.body,
    contentType: "application/pdf",
  });
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const documentId = randomUUID();
    const [created] = await tx
      .insert(quoteVersionDocuments)
      .values({
        id: documentId,
        quoteVersionId: artifact.versionId,
        kind: "acceptance_pdf",
        filename: artifact.filename,
        contentType: "application/pdf",
        storageProvider,
        storageBucket,
        storageObjectKey: artifact.storageObjectKey,
        byteSize: artifact.byteSize,
        sha256: artifact.sha256,
        generatedByTeamMemberId: input.generatedByTeamMemberId ?? null,
        metadata: artifact.metadata,
        generatedAt: now,
        createdAt: now,
      })
      .onConflictDoNothing({
        target: [
          quoteVersionDocuments.storageProvider,
          quoteVersionDocuments.storageBucket,
          quoteVersionDocuments.storageObjectKey,
        ],
      })
      .returning({ id: quoteVersionDocuments.id });
    if (created) {
      await tx.insert(quoteActivityEvents).values({
        quoteId: artifact.quoteId,
        quoteVersionId: artifact.versionId,
        eventType: "acceptance_certificate_generated",
        actorType: input.generatedByTeamMemberId ? "team_member" : "system",
        actorTeamMemberId: input.generatedByTeamMemberId ?? null,
        correlationId: input.correlationId ?? null,
        metadata: {
          responseId: artifact.responseId,
          documentId: created.id,
          certificateHash: artifact.sha256,
        },
        occurredAt: now,
        createdAt: now,
      });
      return {
        documentId: created.id,
        quoteId: artifact.quoteId,
        versionId: artifact.versionId,
        responseId: artifact.responseId,
        sha256: artifact.sha256,
        state: "created" as const,
      };
    }
    const [existing] = await tx
      .select({
        id: quoteVersionDocuments.id,
        sha256: quoteVersionDocuments.sha256,
        metadata: quoteVersionDocuments.metadata,
      })
      .from(quoteVersionDocuments)
      .where(
        and(
          eq(quoteVersionDocuments.storageProvider, storageProvider),
          eq(quoteVersionDocuments.storageBucket, storageBucket),
          eq(quoteVersionDocuments.storageObjectKey, artifact.storageObjectKey),
        ),
      )
      .limit(1);
    if (
      !existing ||
      existing.sha256 !== artifact.sha256 ||
      !existingCertificateMatches(existing, loaded.source, artifact.sha256)
    ) {
      throw new QuoteAcceptanceCertificateError(
        "evidence_mismatch",
        "The acceptance certificate storage key contains conflicting evidence.",
      );
    }
    return {
      documentId: existing.id,
      quoteId: artifact.quoteId,
      versionId: artifact.versionId,
      responseId: artifact.responseId,
      sha256: existing.sha256,
      state: "existing" as const,
    };
  });
}

export type QuoteAcceptanceCertificateEnsurer =
  typeof ensureQuoteAcceptanceCertificate;

/**
 * Best-effort materialization for a certificate whose immutable intent and
 * source evidence were committed with the accepted quote response. Derived
 * PDF/storage failure must never rewrite a truthful acceptance into a failed
 * mutation response; every fresh or idempotent replay can safely retry.
 */
export async function reconcileQuoteAcceptanceCertificate(
  db: DatabaseClient,
  input: {
    responseId: string;
    generatedByTeamMemberId?: string | null;
    correlationId?: string | null;
    now?: Date;
  },
  dependencies: Readonly<{
    ensure: QuoteAcceptanceCertificateEnsurer;
  }> = { ensure: ensureQuoteAcceptanceCertificate },
): Promise<QuoteAcceptanceCertificateReconciliation> {
  try {
    const receipt = await dependencies.ensure(db, input);
    return {
      state: "ready",
      documentId: receipt.documentId,
      sha256: receipt.sha256,
    };
  } catch (error) {
    const evidenceFailure =
      error instanceof QuoteAcceptanceCertificateError &&
      error.code === "evidence_mismatch";
    console.warn("[quote-v2] acceptance certificate remains pending", {
      responseId: input.responseId,
      correlationId: input.correlationId ?? null,
      error: error instanceof Error ? error.name : "unknown",
      retryable: !evidenceFailure,
    });
    return { state: "pending", retryable: !evidenceFailure };
  }
}

export async function ensureQuoteAcceptanceCertificateForVersion(
  db: DatabaseClient,
  input: {
    versionId: string;
    generatedByTeamMemberId?: string | null;
    correlationId?: string | null;
    now?: Date;
  },
): Promise<QuoteAcceptanceCertificateReceipt> {
  const [response] = await db
    .select({ id: quoteResponses.id })
    .from(quoteResponses)
    .innerJoin(
      quoteVersions,
      and(
        eq(quoteVersions.id, quoteResponses.quoteVersionId),
        eq(quoteVersions.quoteId, quoteResponses.quoteId),
      ),
    )
    .innerJoin(quotes, eq(quotes.id, quoteResponses.quoteId))
    .where(
      and(
        eq(quoteResponses.quoteVersionId, input.versionId),
        eq(quoteResponses.responseType, "accepted"),
        eq(quoteVersions.state, "accepted"),
        eq(quotes.aggregateState, "accepted"),
        eq(quotes.engineVersion, "v2"),
      ),
    )
    .limit(1);
  if (!response) {
    throw new QuoteAcceptanceCertificateError(
      "not_found",
      "The accepted response was not found for this quote version.",
    );
  }
  return ensureQuoteAcceptanceCertificate(db, {
    responseId: response.id,
    generatedByTeamMemberId: input.generatedByTeamMemberId,
    correlationId: input.correlationId,
    now: input.now,
  });
}

export async function getQuoteAcceptanceCertificateDocument(
  db: DatabaseClient,
  versionId: string,
): Promise<{
  id: string;
  filename: string;
  contentType: string;
  storageObjectKey: string;
  byteSize: number;
  sha256: string;
} | null> {
  const [document] = await db
    .select({
      id: quoteVersionDocuments.id,
      filename: quoteVersionDocuments.filename,
      contentType: quoteVersionDocuments.contentType,
      storageObjectKey: quoteVersionDocuments.storageObjectKey,
      byteSize: quoteVersionDocuments.byteSize,
      sha256: quoteVersionDocuments.sha256,
    })
    .from(quoteVersionDocuments)
    .innerJoin(
      quoteVersions,
      eq(quoteVersions.id, quoteVersionDocuments.quoteVersionId),
    )
    .innerJoin(quotes, eq(quotes.id, quoteVersions.quoteId))
    .where(
      and(
        eq(quoteVersionDocuments.quoteVersionId, versionId),
        eq(quoteVersionDocuments.kind, "acceptance_pdf"),
        eq(quoteVersions.state, "accepted"),
        eq(quotes.engineVersion, "v2"),
      ),
    )
    .orderBy(desc(quoteVersionDocuments.generatedAt))
    .limit(1);
  return document ?? null;
}
