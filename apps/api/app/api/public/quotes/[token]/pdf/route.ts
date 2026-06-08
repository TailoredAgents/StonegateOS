import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { getDb, contacts, properties, quotePdfDownloads, quotes } from "@/db";
import { eq } from "drizzle-orm";

type PdfLine = {
  text: string;
  size?: number;
  bold?: boolean;
  gap?: number;
};

type LineItemRecord = {
  id?: string;
  label?: string;
  amount?: number;
  category?: string | null;
};

function currency(value: unknown): string {
  const numeric = Number(value ?? 0);
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(numeric);
  } catch {
    return `$${numeric.toFixed(2)}`;
  }
}

function dateLabel(value: Date | null): string {
  if (!value) return "-";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(value);
}

function escapePdf(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapText(value: string, max = 86): string[] {
  const words = value.replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > max && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [""];
}

function makeTextOps(lines: PdfLine[]): string[] {
  const pages: string[] = [];
  let y = 760;
  let ops = ["BT"];

  const flush = () => {
    ops.push("ET");
    pages.push(ops.join("\n"));
    ops = ["BT"];
    y = 760;
  };

  for (const line of lines) {
    const size = line.size ?? 10;
    const gap = line.gap ?? 14;
    const font = line.bold ? "F2" : "F1";
    for (const wrapped of wrapText(line.text, size >= 16 ? 58 : 92)) {
      if (y < 62) flush();
      ops.push(`/${font} ${size} Tf`);
      ops.push(`1 0 0 1 50 ${y} Tm`);
      ops.push(`(${escapePdf(wrapped)}) Tj`);
      y -= gap;
    }
  }
  flush();
  return pages;
}

function generatePdf(lines: PdfLine[]): Buffer {
  const pageStreams = makeTextOps(lines);
  const objects: string[] = [];
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");

  const pageObjectIds = pageStreams.map((_, index) => 5 + index * 2);
  objects.push(`<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>");

  pageStreams.forEach((stream, index) => {
    const contentId = 6 + index * 2;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId} 0 R >>`);
    objects.push(`<< /Length ${Buffer.byteLength(stream, "utf8")} >>\nstream\n${stream}\nendstream`);
  });

  const chunks = ["%PDF-1.4\n"];
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(chunks.join(""), "utf8"));
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  });
  const xrefOffset = Buffer.byteLength(chunks.join(""), "utf8");
  chunks.push(`xref\n0 ${objects.length + 1}\n`);
  chunks.push("0000000000 65535 f \n");
  offsets.slice(1).forEach((offset) => {
    chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`);
  });
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`);
  return Buffer.from(chunks.join(""), "utf8");
}

function lineItems(value: unknown): LineItemRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const label = typeof record["label"] === "string" ? record["label"] : null;
    const amount = Number(record["amount"] ?? 0);
    if (!label || !Number.isFinite(amount)) return [];
    return [{ label, amount, category: typeof record["category"] === "string" ? record["category"] : null }];
  });
}

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ token: string }> },
): Promise<Response> {
  const { token } = await context.params;
  if (!token) {
    return NextResponse.json({ error: "missing_token" }, { status: 400 });
  }

  const db = getDb();
  const [quote] = await db
    .select({
      id: quotes.id,
      quoteNumber: quotes.quoteNumber,
      services: quotes.services,
      lineItems: quotes.lineItems,
      total: quotes.total,
      subtotal: quotes.subtotal,
      depositDue: quotes.depositDue,
      balanceDue: quotes.balanceDue,
      clientScope: quotes.clientScope,
      sentAt: quotes.sentAt,
      expiresAt: quotes.expiresAt,
      customerFirstName: contacts.firstName,
      customerLastName: contacts.lastName,
      addressLine1: properties.addressLine1,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode,
    })
    .from(quotes)
    .leftJoin(contacts, eq(quotes.contactId, contacts.id))
    .leftJoin(properties, eq(quotes.propertyId, properties.id))
    .where(eq(quotes.shareToken, token))
    .limit(1);

  if (!quote?.id) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const ipAddress = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  await db.insert(quotePdfDownloads).values({
    quoteId: quote.id,
    userAgent: request.headers.get("user-agent"),
    ipAddress,
  });

  const customerName = [quote.customerFirstName, quote.customerLastName].filter(Boolean).join(" ").trim() || "Customer";
  const address = [quote.addressLine1, quote.city, quote.state, quote.postalCode].filter(Boolean).join(", ");
  const items = lineItems(quote.lineItems);
  const lines: PdfLine[] = [
    { text: "Stonegate Junk Removal", size: 18, bold: true, gap: 24 },
    { text: "Formal Quote Proposal", size: 14, bold: true, gap: 22 },
    { text: `Quote: ${quote.quoteNumber ?? quote.id.slice(0, 8).toUpperCase()}`, bold: true },
    { text: `Prepared for: ${customerName}` },
    { text: `Property: ${address}` },
    { text: `Sent: ${dateLabel(quote.sentAt)}    Valid until: ${dateLabel(quote.expiresAt)}`, gap: 22 },
    { text: "Scope of Work", size: 13, bold: true, gap: 18 },
    {
      text:
        quote.clientScope?.trim() ||
        "Loading, haul-away, disposal, and completion of the quoted junk removal scope. Final price may change if volume, weight, materials, or access differ on site.",
      gap: 16,
    },
    { text: "Line Items", size: 13, bold: true, gap: 18 },
    ...items.map((item) => ({ text: `${item.label}: ${currency(item.amount)}`, gap: 14 })),
    { text: `Subtotal: ${currency(quote.subtotal)}`, bold: true },
    { text: `Total: ${currency(quote.total)}`, size: 14, bold: true, gap: 20 },
    { text: "Payment Terms", size: 13, bold: true, gap: 18 },
    {
      text:
        Number(quote.depositDue ?? 0) > 0
          ? `${currency(quote.depositDue)} deposit is listed. Remaining balance: ${currency(quote.balanceDue)}.`
          : "No deposit is required. Payment is due after service.",
      gap: 20,
    },
    { text: "Terms", size: 13, bold: true, gap: 18 },
    {
      text:
        "This quote assumes the listed scope, normal access, and non-hazardous materials. Pricing may change if volume, weight, access, disposal requirements, or item conditions differ on site.",
    },
  ];

  const filename = `${quote.quoteNumber ?? "stonegate-quote"}.pdf`.replace(/[^a-z0-9_.-]/gi, "_");
  const pdf = generatePdf(lines);
  return new NextResponse(new Uint8Array(pdf), {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
