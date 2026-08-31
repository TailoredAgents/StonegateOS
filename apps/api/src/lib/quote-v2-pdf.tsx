import React from "react";
import { createRequire } from "node:module";
import {
  Document,
  Font,
  Image,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
} from "@react-pdf/renderer";
import { z } from "zod";
import {
  formatQuoteTotal,
  formatUsd,
  type QuoteRenderModel,
} from "@/lib/quote-v2-render-model";

let fontsRegistered = false;
const moduleRequire = createRequire(import.meta.url);

function registerProposalFonts(): void {
  if (fontsRegistered) return;
  Font.register({
    family: "Noto Sans",
    fonts: [
      {
        src: moduleRequire.resolve(
          "@fontsource/noto-sans/files/noto-sans-latin-ext-400-normal.woff",
        ),
        fontWeight: 400,
      },
      {
        src: moduleRequire.resolve(
          "@fontsource/noto-sans/files/noto-sans-latin-ext-700-normal.woff",
        ),
        fontWeight: 700,
      },
    ],
  });
  Font.registerHyphenationCallback((word) => [word]);
  fontsRegistered = true;
}

const palette = {
  evergreen: "#173f2b",
  green: "#19633a",
  ink: "#17221a",
  muted: "#59675e",
  line: "#d9e2da",
  wash: "#f3f7f3",
  white: "#ffffff",
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 42,
    paddingBottom: 56,
    paddingHorizontal: 42,
    fontFamily: "Noto Sans",
    fontSize: 9,
    lineHeight: 1.45,
    color: palette.ink,
    backgroundColor: palette.white,
  },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    paddingBottom: 18,
    borderBottomWidth: 2,
    borderBottomColor: palette.evergreen,
    marginBottom: 22,
  },
  brandRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  logo: { width: 82, height: 34, objectFit: "contain" },
  brand: { color: palette.evergreen, fontSize: 15, fontWeight: 700 },
  title: { color: palette.evergreen, fontSize: 22, fontWeight: 700 },
  eyebrow: {
    color: palette.muted,
    fontSize: 8,
    textTransform: "uppercase",
    letterSpacing: 1.2,
    marginBottom: 3,
  },
  meta: { color: palette.muted, textAlign: "right", marginTop: 3 },
  hero: {
    backgroundColor: palette.evergreen,
    color: palette.white,
    borderRadius: 8,
    padding: 18,
    marginBottom: 20,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  heroLabel: { fontSize: 8, textTransform: "uppercase", letterSpacing: 1 },
  heroTotal: { fontSize: 24, fontWeight: 700, marginTop: 3 },
  heroDetail: { fontSize: 8, textAlign: "right", lineHeight: 1.5 },
  columns: { flexDirection: "row", gap: 18, marginBottom: 20 },
  column: { flexGrow: 1, flexBasis: 0 },
  sectionTitle: {
    color: palette.evergreen,
    fontSize: 12,
    fontWeight: 700,
    marginBottom: 8,
  },
  label: { color: palette.muted, fontSize: 7, textTransform: "uppercase" },
  value: { marginBottom: 5 },
  table: { borderWidth: 1, borderColor: palette.line, marginBottom: 20 },
  tableHeader: {
    flexDirection: "row",
    backgroundColor: palette.wash,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
    paddingVertical: 7,
    paddingHorizontal: 8,
    fontWeight: 700,
    color: palette.evergreen,
  },
  tableRow: {
    flexDirection: "row",
    paddingVertical: 8,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: palette.line,
  },
  tableRowLast: { borderBottomWidth: 0 },
  item: { width: "45%", paddingRight: 8 },
  quantity: { width: "15%", textAlign: "right" },
  rate: { width: "20%", textAlign: "right" },
  amount: { width: "20%", textAlign: "right" },
  description: { color: palette.muted, fontSize: 8, marginTop: 2 },
  optionBadge: {
    color: palette.green,
    fontSize: 7,
    marginTop: 3,
    textTransform: "uppercase",
  },
  totals: { width: "48%", marginLeft: "52%", marginBottom: 22 },
  totalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginBottom: 5,
  },
  grandTotal: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 1.5,
    borderTopColor: palette.evergreen,
    paddingTop: 8,
    marginTop: 3,
    fontSize: 12,
    fontWeight: 700,
    color: palette.evergreen,
  },
  section: { marginBottom: 18 },
  paragraph: { marginBottom: 5 },
  bulletRow: { flexDirection: "row", marginBottom: 4 },
  bullet: { width: 12, color: palette.green },
  bulletText: { flex: 1 },
  terms: {
    backgroundColor: palette.wash,
    borderRadius: 6,
    padding: 14,
    marginBottom: 16,
  },
  footer: {
    position: "absolute",
    left: 42,
    right: 42,
    bottom: 25,
    borderTopWidth: 1,
    borderTopColor: palette.line,
    paddingTop: 8,
    flexDirection: "row",
    justifyContent: "space-between",
    color: palette.muted,
    fontSize: 7,
  },
  certificate: {
    borderWidth: 1.5,
    borderColor: palette.evergreen,
    borderRadius: 8,
    padding: 18,
    marginBottom: 18,
  },
  hash: { fontSize: 6.5, color: palette.muted, marginTop: 3 },
});

function issuerContact(model: QuoteRenderModel): string {
  const issuer = model.document.issuer;
  return `${issuer.address}\n${issuer.phoneE164} · ${issuer.email}${issuer.website ? `\n${issuer.website}` : ""}`;
}

function priceForLine(
  line: QuoteRenderModel["totals"]["lines"][number],
): string {
  return line.amountMinCents === line.amountMaxCents
    ? formatUsd(line.amountMinCents)
    : `${formatUsd(line.amountMinCents)}–${formatUsd(line.amountMaxCents)}`;
}

function rateForLine(
  line: QuoteRenderModel["totals"]["lines"][number],
): string {
  const maximum = line.unitPriceMaxCents ?? line.unitPriceMinCents;
  return maximum === line.unitPriceMinCents
    ? formatUsd(line.unitPriceMinCents)
    : `${formatUsd(line.unitPriceMinCents)}–${formatUsd(maximum)}`;
}

function BulletList({ values }: { values: string[] }): React.ReactElement {
  return (
    <View>
      {values.map((value, index) => (
        <View style={styles.bulletRow} key={`${index}-${value}`} wrap={false}>
          <Text style={styles.bullet}>•</Text>
          <Text style={styles.bulletText}>{value}</Text>
        </View>
      ))}
    </View>
  );
}

function ProposalFooter({
  model,
}: {
  model: QuoteRenderModel;
}): React.ReactElement {
  return (
    <View style={styles.footer} fixed>
      <Text>
        {model.document.issuer.displayName} · {model.quoteNumber} · v
        {model.versionNumber}
      </Text>
      <Text
        render={({ pageNumber, totalPages }) =>
          `Page ${pageNumber} of ${totalPages}`
        }
      />
    </View>
  );
}

export function QuoteProposalDocument({
  model,
  logoSource,
}: {
  model: QuoteRenderModel;
  logoSource?: string | null;
}): React.ReactElement {
  registerProposalFonts();
  const parties = model.document.parties;
  const adjustments = model.totals.adjustments;
  return (
    <Document
      title={`${model.title} ${model.quoteNumber}`}
      author={model.document.issuer.legalName}
      subject={parties.projectName ?? parties.serviceAddress}
      creator={model.document.issuer.displayName}
      producer="StonegateOS Quote V2"
      creationDate={new Date(model.issuedAt)}
      modificationDate={new Date(model.issuedAt)}
      language="en-US"
    >
      <Page size="LETTER" style={styles.page} wrap>
        <View style={styles.header}>
          <View style={styles.brandRow}>
            {logoSource ? (
              /* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf's Image is not a DOM image and has no alt prop. */
              <Image style={styles.logo} src={logoSource} />
            ) : null}
            <View>
              <Text style={styles.brand}>
                {model.document.issuer.displayName}
              </Text>
              <Text>{issuerContact(model)}</Text>
            </View>
          </View>
          <View>
            <Text style={styles.title}>{model.title}</Text>
            <Text style={styles.meta}>
              {model.quoteNumber} · Version {model.versionNumber}
            </Text>
            <Text style={styles.meta}>Issued {model.issuedDateLabel}</Text>
            <Text style={styles.meta}>
              Valid through {model.expiryDateLabel}
            </Text>
          </View>
        </View>

        <View style={styles.hero} wrap={false}>
          <View>
            <Text style={styles.heroLabel}>{model.title} total</Text>
            <Text style={styles.heroTotal}>
              {formatQuoteTotal(model.totals)}
            </Text>
          </View>
          <View>
            <Text style={styles.heroDetail}>
              Deposit {formatUsd(model.totals.depositCents)}
            </Text>
            <Text style={styles.heroDetail}>
              Balance{" "}
              {model.totals.documentType === "range"
                ? `${formatUsd(model.totals.balanceMinCents)}–${formatUsd(model.totals.balanceMaxCents)}`
                : formatUsd(model.totals.balanceMinCents)}
            </Text>
            <Text style={styles.heroDetail}>USD · No sales tax calculated</Text>
          </View>
        </View>

        <View style={styles.columns} wrap={false}>
          <View style={styles.column}>
            <Text style={styles.sectionTitle}>Prepared for</Text>
            <Text style={styles.value}>
              {parties.companyName ?? parties.customerName}
            </Text>
            {parties.attentionName ? (
              <Text>
                Attn: {parties.attentionName}
                {parties.attentionTitle ? `, ${parties.attentionTitle}` : ""}
              </Text>
            ) : null}
            {parties.billingAddress ? (
              <Text>{parties.billingAddress}</Text>
            ) : null}
            {parties.email ? <Text>{parties.email}</Text> : null}
            {parties.phoneE164 ? <Text>{parties.phoneE164}</Text> : null}
          </View>
          <View style={styles.column}>
            <Text style={styles.sectionTitle}>Project</Text>
            {parties.projectName ? (
              <Text style={styles.value}>{parties.projectName}</Text>
            ) : null}
            <Text style={styles.label}>Service site</Text>
            <Text style={styles.value}>{parties.serviceAddress}</Text>
            {parties.purchaseOrder ? (
              <Text>PO: {parties.purchaseOrder}</Text>
            ) : null}
            {parties.reference ? (
              <Text>Reference: {parties.reference}</Text>
            ) : null}
            <Text>Prepared by {parties.preparerName}</Text>
          </View>
        </View>

        <View style={styles.table}>
          <View style={styles.tableHeader} fixed>
            <Text style={styles.item}>Item</Text>
            <Text style={styles.quantity}>Qty / unit</Text>
            <Text style={styles.rate}>Rate</Text>
            <Text style={styles.amount}>Amount</Text>
          </View>
          {model.totals.lines.map((line, index) => (
            <View
              key={line.id}
              style={[
                styles.tableRow,
                index === model.totals.lines.length - 1
                  ? styles.tableRowLast
                  : {},
              ]}
              wrap={false}
            >
              <View style={styles.item}>
                <Text>{line.name}</Text>
                {line.description ? (
                  <Text style={styles.description}>{line.description}</Text>
                ) : null}
                {line.optionGroupId ? (
                  <Text style={styles.optionBadge}>
                    {line.selected ? "Selected option" : "Available option"}
                  </Text>
                ) : null}
              </View>
              <Text style={styles.quantity}>
                {line.quantity} {line.unit}
              </Text>
              <Text style={styles.rate}>{rateForLine(line)}</Text>
              <Text style={styles.amount}>
                {line.selected ? priceForLine(line) : "—"}
              </Text>
            </View>
          ))}
        </View>

        <View style={styles.totals} wrap={false}>
          <View style={styles.totalRow}>
            <Text>Subtotal</Text>
            <Text>
              {model.totals.documentType === "range"
                ? `${formatUsd(model.totals.subtotalMinCents)}–${formatUsd(model.totals.subtotalMaxCents)}`
                : formatUsd(model.totals.subtotalMinCents)}
            </Text>
          </View>
          {adjustments.map((adjustment) => (
            <View style={styles.totalRow} key={adjustment.id}>
              <Text>{adjustment.label}</Text>
              <Text>
                {adjustment.kind === "discount" ? "−" : "+"}
                {adjustment.amountMinCents === adjustment.amountMaxCents
                  ? formatUsd(adjustment.amountMinCents)
                  : `${formatUsd(adjustment.amountMinCents)}–${formatUsd(adjustment.amountMaxCents)}`}
              </Text>
            </View>
          ))}
          <View style={styles.grandTotal}>
            <Text>Total</Text>
            <Text>{formatQuoteTotal(model.totals)}</Text>
          </View>
        </View>

        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Scope of work</Text>
          <Text style={styles.paragraph}>{model.document.scope}</Text>
        </View>
        {model.document.inclusions.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Included</Text>
            <BulletList values={model.document.inclusions} />
          </View>
        ) : null}
        {model.document.exclusions.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Excluded</Text>
            <BulletList values={model.document.exclusions} />
          </View>
        ) : null}
        {model.document.assumptions.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Assumptions</Text>
            <BulletList values={model.document.assumptions} />
          </View>
        ) : null}
        {model.attachments.length > 0 ? (
          <View style={styles.section}>
            <Text style={styles.sectionTitle}>Customer attachments</Text>
            <BulletList
              values={model.attachments.map((attachment) =>
                attachment.caption
                  ? `${attachment.fileName} — ${attachment.caption}`
                  : attachment.fileName,
              )}
            />
          </View>
        ) : null}
        <View style={styles.terms}>
          <Text style={styles.sectionTitle}>Terms and payment</Text>
          <Text style={styles.paragraph}>{model.document.terms.terms}</Text>
          <Text style={styles.paragraph}>
            {model.document.terms.paymentTerms}
          </Text>
          <Text style={styles.paragraph}>
            {model.document.terms.changeOrderRules}
          </Text>
          <Text>
            Terms version {model.document.terms.templateVersion} · Consent{" "}
            {model.document.terms.consentVersion}
          </Text>
        </View>
        <Text style={styles.hash}>Content SHA-256: {model.contentHash}</Text>
        <ProposalFooter model={model} />
      </Page>
    </Document>
  );
}

export async function renderQuoteProposalPdf(input: {
  model: QuoteRenderModel;
  logoSource?: string | null;
}): Promise<Buffer> {
  return renderToBuffer(
    <QuoteProposalDocument model={input.model} logoSource={input.logoSource} />,
  );
}

export const QuoteAcceptanceCertificateSchema = z
  .object({
    responseId: z.string().uuid(),
    signerName: z.string().trim().min(1).max(240),
    signerTitle: z.string().trim().min(1).max(160),
    signerCompany: z.string().trim().max(240).nullable().optional(),
    authorityAffirmed: z.literal(true),
    acceptedAt: z.coerce.date(),
    consentText: z.string().trim().min(1).max(8_000),
    consentVersion: z.string().trim().min(1).max(80),
    selectedOptionIds: z.array(z.string().trim().min(1).max(80)).max(100),
    acceptedTotalMinCents: z.number().int().positive(),
    acceptedTotalMaxCents: z.number().int().positive(),
    acceptedDepositCents: z.number().int().nonnegative(),
    acceptedBalanceMinCents: z.number().int().nonnegative(),
    acceptedBalanceMaxCents: z.number().int().nonnegative(),
    configurationHash: z.string().regex(/^[0-9a-f]{64}$/u),
    consentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/u),
    issuedPdfHash: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (
      evidence.acceptedTotalMaxCents < evidence.acceptedTotalMinCents ||
      evidence.acceptedDepositCents > evidence.acceptedTotalMinCents ||
      evidence.acceptedBalanceMinCents !==
        evidence.acceptedTotalMinCents - evidence.acceptedDepositCents ||
      evidence.acceptedBalanceMaxCents !==
        evidence.acceptedTotalMaxCents - evidence.acceptedDepositCents
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["acceptedTotalMinCents"],
        message: "Accepted totals, deposit, and balances must reconcile.",
      });
    }
  });

export async function renderQuoteAcceptanceCertificate(input: {
  model: QuoteRenderModel;
  issuedContentHash: string;
  evidence: z.input<typeof QuoteAcceptanceCertificateSchema>;
}): Promise<Buffer> {
  registerProposalFonts();
  const evidence = QuoteAcceptanceCertificateSchema.parse(input.evidence);
  if (
    evidence.acceptedTotalMinCents !== input.model.totals.totalMinCents ||
    evidence.acceptedTotalMaxCents !== input.model.totals.totalMaxCents ||
    evidence.acceptedDepositCents !== input.model.totals.depositCents ||
    evidence.acceptedBalanceMinCents !== input.model.totals.balanceMinCents ||
    evidence.acceptedBalanceMaxCents !== input.model.totals.balanceMaxCents ||
    evidence.contentHash !== input.issuedContentHash ||
    evidence.selectedOptionIds.join("\0") !==
      input.model.totals.selectedOptionIds.join("\0")
  ) {
    throw new Error(
      "Acceptance evidence does not reconcile to the issued proposal.",
    );
  }
  const acceptedAt = evidence.acceptedAt.toISOString();
  return renderToBuffer(
    <Document
      title={`Acceptance certificate ${input.model.quoteNumber}`}
      author={input.model.document.issuer.legalName}
      creator="StonegateOS Quote V2"
      producer="StonegateOS Quote V2"
      creationDate={evidence.acceptedAt}
      modificationDate={evidence.acceptedAt}
      language="en-US"
    >
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <View>
            <Text style={styles.brand}>
              {input.model.document.issuer.displayName}
            </Text>
            <Text>Acceptance evidence</Text>
          </View>
          <View>
            <Text style={styles.title}>Accepted proposal</Text>
            <Text style={styles.meta}>
              {input.model.quoteNumber} · Version {input.model.versionNumber}
            </Text>
          </View>
        </View>
        <View style={styles.certificate}>
          <Text style={styles.sectionTitle}>Signer</Text>
          <Text>{evidence.signerName}</Text>
          <Text>
            {evidence.signerTitle}
            {evidence.signerCompany ? ` · ${evidence.signerCompany}` : ""}
          </Text>
          <Text>Authority to approve affirmed</Text>
          <Text style={styles.label}>Accepted at</Text>
          <Text>{acceptedAt}</Text>
        </View>
        <View style={styles.hero}>
          <View>
            <Text style={styles.heroLabel}>
              Accepted {input.model.title.toLowerCase()}
            </Text>
            <Text style={styles.heroTotal}>
              {formatQuoteTotal(input.model.totals)}
            </Text>
          </View>
          <Text style={styles.heroDetail}>
            Deposit {formatUsd(evidence.acceptedDepositCents)}\nBalance{" "}
            {input.model.totals.documentType === "range"
              ? `${formatUsd(evidence.acceptedBalanceMinCents)}–${formatUsd(evidence.acceptedBalanceMaxCents)}`
              : formatUsd(evidence.acceptedBalanceMinCents)}
            \n{input.model.quoteNumber} · Version {input.model.versionNumber}
          </Text>
        </View>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Consent</Text>
          <Text>{evidence.consentText}</Text>
          <Text style={styles.label}>
            Consent version {evidence.consentVersion}
          </Text>
        </View>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Selected options</Text>
          <Text>
            {evidence.selectedOptionIds.length > 0
              ? evidence.selectedOptionIds.join(", ")
              : "No customer-selectable options"}
          </Text>
        </View>
        <View style={styles.terms}>
          <Text style={styles.sectionTitle}>Evidence hashes</Text>
          <Text style={styles.hash}>
            Proposal content: {evidence.contentHash}
          </Text>
          <Text style={styles.hash}>Issued PDF: {evidence.issuedPdfHash}</Text>
          <Text style={styles.hash}>
            Configuration: {evidence.configurationHash}
          </Text>
          <Text style={styles.hash}>Consent: {evidence.consentHash}</Text>
          <Text style={styles.hash}>Response: {evidence.responseId}</Text>
        </View>
        <ProposalFooter model={input.model} />
      </Page>
    </Document>,
  );
}
