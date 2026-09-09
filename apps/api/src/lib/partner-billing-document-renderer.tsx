import React from "react";
import type { StyleSheet } from "@react-pdf/renderer";
import { z } from "zod";

const Minor = z.number().int().min(0).max(2_147_483_647);
export const PartnerBillingDocumentSnapshotSchema = z
  .object({
    title: z.enum([
      "Invoice",
      "Receipt",
      "Credit note",
      "Voided invoice",
      "Statement",
      "Refund receipt",
    ]),
    number: z.string().min(1).max(120),
    accountName: z.string().min(1).max(200),
    issuedAt: z.string().datetime(),
    currency: z.literal("USD"),
    lines: z
      .array(
        z.object({
          description: z.string().min(1).max(1000),
          quantity: z.string().max(30).optional(),
          amountCents: Minor,
        }),
      )
      .max(500),
    totals: z
      .array(
        z.object({
          label: z.string().min(1).max(80),
          amountCents: z.number().int().min(-2_147_483_647).max(2_147_483_647),
        }),
      )
      .max(12),
    notes: z.array(z.string().max(1000)).max(20),
    statement: z
      .object({
        periodStart: z.string().date(),
        periodEnd: z.string().date(),
        revision: z.number().int().positive(),
        openingBalanceCents: z.number().int(),
        invoiceCents: Minor,
        paymentCents: Minor,
        refundCents: Minor,
        creditCents: Minor,
        closingBalanceCents: z.number().int(),
      })
      .optional(),
  })
  .strict();
export type PartnerBillingDocumentSnapshot = z.infer<
  typeof PartnerBillingDocumentSnapshotSchema
>;

const defineStyles: typeof StyleSheet.create = (styles) => styles;
const style = defineStyles({
  page: {
    padding: 40,
    fontFamily: "Helvetica",
    color: "#17221a",
    fontSize: 10,
    lineHeight: 1.5,
  },
  brand: { fontSize: 18, color: "#173f2b", marginBottom: 8 },
  heading: { fontSize: 24, marginBottom: 12 },
  meta: { fontSize: 10, color: "#59675e", marginBottom: 4 },
  table: { marginTop: 24, borderTop: "1 solid #d9e2da" },
  row: {
    display: "flex",
    flexDirection: "row",
    paddingVertical: 8,
    borderBottom: "1 solid #d9e2da",
  },
  description: { width: "76%", paddingRight: 10 },
  amount: { width: "24%", textAlign: "right" },
  total: { display: "flex", flexDirection: "row", paddingTop: 8 },
  note: { marginTop: 10, color: "#59675e", fontSize: 9 },
  footer: {
    position: "absolute",
    left: 40,
    right: 40,
    bottom: 22,
    fontSize: 8,
    color: "#59675e",
  },
});
function money(value: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
  }).format(value / 100);
}

export async function renderPartnerBillingDocument(
  raw: unknown,
): Promise<Buffer> {
  const snapshot = PartnerBillingDocumentSnapshotSchema.parse(raw);
  const { Document, Page, Text, View, renderToBuffer } = await import("@react-pdf/renderer");
  const issuedAt = new Date(snapshot.issuedAt);
  return renderToBuffer(
    <Document
      title={`${snapshot.title} ${snapshot.number}`}
      author="Stonegate Junk Removal"
      creator="Stonegate"
      producer="Stonegate"
      creationDate={issuedAt}
      modificationDate={issuedAt}
    >
      <Page size="LETTER" style={style.page}>
        <Text style={style.brand}>Stonegate Junk Removal</Text>
        <Text style={style.heading}>{snapshot.title}</Text>
        <Text style={style.meta}>{snapshot.number}</Text>
        <Text style={style.meta}>{snapshot.accountName}</Text>
        <Text style={style.meta}>
          Issued{" "}
          {new Intl.DateTimeFormat("en-US", {
            dateStyle: "long",
            timeZone: "America/New_York",
          }).format(issuedAt)}
        </Text>
        <View style={style.table}>
          {snapshot.lines.map((line, index) => (
            <View key={index} style={style.row} wrap={false}>
              <Text style={style.description}>
                {line.description}
                {line.quantity ? ` × ${line.quantity}` : ""}
              </Text>
              <Text style={style.amount}>{money(line.amountCents)}</Text>
            </View>
          ))}
        </View>
        {snapshot.totals.map((total) => (
          <View key={total.label} style={style.total} wrap={false}>
            <Text style={style.description}>{total.label}</Text>
            <Text style={style.amount}>{money(total.amountCents)}</Text>
          </View>
        ))}
        {snapshot.notes.map((note, index) => (
          <Text key={index} style={style.note}>
            {note}
          </Text>
        ))}
        <Text style={style.footer} fixed>
          sales@stonegatejunkremoval.com · 404-777-2631
        </Text>
      </Page>
    </Document>,
  );
}
