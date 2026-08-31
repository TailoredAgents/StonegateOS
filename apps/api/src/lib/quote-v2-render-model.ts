import { z } from "zod";
import {
  QuoteDocumentSnapshotSchema,
  type QuoteDocumentSnapshot,
} from "@/lib/quote-v2-contract";
import {
  calculateQuoteV2Totals,
  canonicalQuoteJson,
  hashQuoteContent,
  type QuoteTotals,
} from "@/lib/quote-v2-domain";

const RenderAttachmentSchema = z
  .object({
    id: z.string().uuid(),
    caption: z.string().trim().max(500).nullable().optional(),
    fileName: z.string().trim().min(1).max(500),
    mediaType: z.enum([
      "image/jpeg",
      "image/png",
      "image/webp",
      "image/heic",
      "application/pdf",
    ]),
    displayOrder: z.number().int().min(0).max(1_000),
  })
  .strict();

export const QuoteRenderInputSchema = z
  .object({
    quoteId: z.string().uuid(),
    versionId: z.string().uuid(),
    quoteNumber: z.string().trim().min(1).max(80),
    versionNumber: z.number().int().positive(),
    issuedAt: z.coerce.date(),
    expiresAt: z.coerce.date(),
    document: QuoteDocumentSnapshotSchema,
    selectedOptionIds: z
      .array(z.string().trim().min(1).max(80))
      .max(100)
      .default([]),
    attachments: z.array(RenderAttachmentSchema).max(10).default([]),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.expiresAt <= input.issuedAt) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["expiresAt"],
        message: "Proposal expiry must follow its issue time.",
      });
    }
  });

export type QuoteRenderInput = z.input<typeof QuoteRenderInputSchema>;

export type QuoteRenderModel = {
  quoteId: string;
  versionId: string;
  quoteNumber: string;
  versionNumber: number;
  title: "Fixed quote" | "Estimate" | "Price range";
  issuedAt: string;
  expiresAt: string;
  issuedDateLabel: string;
  expiryDateLabel: string;
  document: QuoteDocumentSnapshot;
  totals: QuoteTotals;
  attachments: z.infer<typeof RenderAttachmentSchema>[];
  contentHash: string;
};

function proposalTitle(
  type: QuoteDocumentSnapshot["documentType"],
): QuoteRenderModel["title"] {
  if (type === "fixed_quote") return "Fixed quote";
  if (type === "estimate") return "Estimate";
  return "Price range";
}

export function formatUsd(cents: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(cents / 100);
}

export function formatQuoteTotal(totals: QuoteTotals): string {
  return totals.documentType === "range"
    ? `${formatUsd(totals.totalMinCents)}–${formatUsd(totals.totalMaxCents)}`
    : formatUsd(totals.totalMinCents);
}

function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

export function buildQuoteRenderModel(input: unknown): QuoteRenderModel {
  const parsed = QuoteRenderInputSchema.parse(input);
  const totals = calculateQuoteV2Totals(
    parsed.document.pricing,
    parsed.selectedOptionIds,
  );
  if (totals.totalMinCents <= 0) {
    throw new Error("An issued proposal must have a positive total.");
  }
  const hashInput = {
    quoteId: parsed.quoteId,
    versionId: parsed.versionId,
    quoteNumber: parsed.quoteNumber,
    versionNumber: parsed.versionNumber,
    issuedAt: parsed.issuedAt.toISOString(),
    expiresAt: parsed.expiresAt.toISOString(),
    document: parsed.document,
    selectedOptionIds: totals.selectedOptionIds,
    totals,
    attachments: [...parsed.attachments].sort(
      (left, right) =>
        left.displayOrder - right.displayOrder ||
        left.id.localeCompare(right.id),
    ),
  };
  return {
    quoteId: parsed.quoteId,
    versionId: parsed.versionId,
    quoteNumber: parsed.quoteNumber,
    versionNumber: parsed.versionNumber,
    title: proposalTitle(parsed.document.documentType),
    issuedAt: parsed.issuedAt.toISOString(),
    expiresAt: parsed.expiresAt.toISOString(),
    issuedDateLabel: formatDate(parsed.issuedAt),
    expiryDateLabel: formatDate(parsed.expiresAt),
    document: parsed.document,
    totals,
    attachments: hashInput.attachments,
    contentHash: hashQuoteContent(hashInput),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => {
    return (
      {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "'": "&#39;",
        '"': "&quot;",
      }[character] ?? character
    );
  });
}

function actionableUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.hostname !== "localhost") {
    throw new Error("Customer proposal links must use HTTPS.");
  }
  return url.toString();
}

export function renderQuoteEmail(input: {
  model: QuoteRenderModel;
  proposalUrl: string;
  coverMessage?: string | null;
}): { subject: string; html: string; text: string } {
  const { model } = input;
  const url = actionableUrl(input.proposalUrl);
  const cover = input.coverMessage?.trim().slice(0, 4_000) || null;
  const total = formatQuoteTotal(model.totals);
  const project =
    model.document.parties.projectName ?? model.document.parties.serviceAddress;
  const subject = `${model.title} ${model.quoteNumber} for ${project}`;
  const intro = cover
    ? `${cover}\n\n`
    : `Your ${model.title.toLowerCase()} is ready to review.\n\n`;
  const text =
    `${intro}${model.document.parties.customerName}\n` +
    `${project}\n${model.title} ${model.quoteNumber} · Version ${model.versionNumber}\n` +
    `${total}\nValid through ${model.expiryDateLabel}\n` +
    `Review proposal: ${url}\n\n` +
    `${model.document.issuer.displayName} · ${model.document.issuer.phoneE164} · ${model.document.issuer.email}`;
  const html = `<!doctype html><html lang="en"><body style="margin:0;background:#f5f7f5;color:#17221a;font-family:Arial,sans-serif"><main style="max-width:640px;margin:0 auto;padding:32px 20px"><section style="background:#fff;border:1px solid #dce5dc;border-radius:16px;overflow:hidden"><header style="background:#173f2b;color:#fff;padding:24px"><p style="margin:0 0 6px;font-size:13px;letter-spacing:.08em;text-transform:uppercase">${escapeHtml(model.document.issuer.displayName)}</p><h1 style="margin:0;font-size:26px">${escapeHtml(model.title)}</h1></header><div style="padding:28px">${cover ? `<p>${escapeHtml(cover).replace(/\n/gu, "<br>")}</p>` : ""}<p>Prepared for <strong>${escapeHtml(model.document.parties.customerName)}</strong></p><p style="color:#52625a">${escapeHtml(project)}</p><p style="font-size:30px;font-weight:700;margin:24px 0 4px">${escapeHtml(total)}</p><p style="color:#52625a;margin-top:0">Valid through ${escapeHtml(model.expiryDateLabel)}</p><p><a href="${escapeHtml(url)}" style="display:inline-block;background:#19633a;color:#fff;text-decoration:none;font-weight:700;padding:14px 20px;border-radius:10px">Review proposal</a></p><p style="color:#52625a;font-size:13px">Quote ${escapeHtml(model.quoteNumber)} · Version ${model.versionNumber}</p></div></section><footer style="padding:18px 8px;color:#52625a;font-size:13px">${escapeHtml(model.document.issuer.displayName)} · ${escapeHtml(model.document.issuer.phoneE164)} · ${escapeHtml(model.document.issuer.email)}</footer></main></body></html>`;
  return { subject, html, text };
}

export function renderQuoteSms(input: {
  model: QuoteRenderModel;
  proposalUrl: string;
}): string {
  const url = actionableUrl(input.proposalUrl);
  return `${input.model.document.issuer.displayName}: ${input.model.title} ${input.model.quoteNumber} (${formatQuoteTotal(input.model.totals)}) is ready. Review by ${input.model.expiryDateLabel}: ${url}`;
}

export function canonicalQuoteRenderJson(model: QuoteRenderModel): string {
  return canonicalQuoteJson(model);
}
