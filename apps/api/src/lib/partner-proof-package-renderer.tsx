import { createRequire } from "node:module";
import React from "react";
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
import sharp from "sharp";
import {
  createPartnerProofArchive,
  sha256PartnerProofBytes,
} from "@/lib/partner-proof-package-archive";

const moduleRequire = createRequire(import.meta.url);
let fontsRegistered = false;

function registerFonts(): void {
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

export type PartnerProofPackageRequirement = Readonly<{
  category: string;
  required: boolean;
  minimumCount: number;
  readyCount: number;
  satisfied: boolean;
}>;

export type PartnerProofPackageEvidence = Readonly<{
  reference: string;
  category: string;
  caption: string | null;
  sortOrder: number;
  contentType: string;
  filename: string;
  byteSize: number;
  width: number | null;
  height: number | null;
  sha256: string;
  capturedAt: string;
  originalBytes: Buffer;
}>;

export type PartnerProofPackageRenderInput = Readonly<{
  version: number;
  generatedAt: string;
  manifestChecksumSha256: string;
  job: Readonly<{
    status: "completed";
    serviceKey: string | null;
    tierKey: string | null;
    projectReference: string | null;
    locationName: string | null;
    city: string | null;
    state: string | null;
    promisedArrivalStartAt: string | null;
    promisedArrivalEndAt: string | null;
    timezone: string;
    completedAt: string;
  }>;
  requirements: readonly PartnerProofPackageRequirement[];
  evidence: readonly PartnerProofPackageEvidence[];
}>;

export type PartnerProofPackageArtifacts = Readonly<{
  pdf: Readonly<{ body: Buffer; sha256: string; filename: string }>;
  zip: Readonly<{ body: Buffer; sha256: string; filename: string }>;
  publicRecord: Record<string, unknown>;
}>;

function text(value: string | null | undefined, maximum = 500): string | null {
  const normalized = value
    ?.normalize("NFKC")
    .split("")
    .map((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point >= 32 && point !== 127 ? character : " ";
    })
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized ? [...normalized].slice(0, maximum).join("") : null;
}

function label(value: string | null): string {
  return (
    text(value, 100)
      ?.replace(/[-_]+/gu, " ")
      .replace(/\b\w/gu, (character) => character.toUpperCase()) ?? "Service"
  );
}

function safeExtension(contentType: string): string {
  if (contentType === "image/jpeg") return "jpg";
  if (contentType === "image/png") return "png";
  if (contentType === "image/webp") return "webp";
  if (contentType === "image/heic") return "heic";
  if (contentType === "image/heif") return "heif";
  return "bin";
}

function archiveFilename(input: PartnerProofPackageEvidence, index: number): string {
  const category = (text(input.category, 40) ?? "proof")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "") || "proof";
  const basename = (text(input.filename, 120) ?? "photo")
    .replace(/\.[^.]+$/u, "")
    .replace(/[^a-zA-Z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "") || "photo";
  return `proof/${String(index + 1).padStart(2, "0")}-${category}-${basename}.${safeExtension(input.contentType)}`;
}

function canonical(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  ) {
    return value;
  }
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  throw new TypeError("The completion record contains an unsupported value.");
}

function completionRecord(
  input: PartnerProofPackageRenderInput,
  paths: readonly string[],
): Record<string, unknown> {
  return canonical({
    schemaVersion: 1,
    package: {
      version: input.version,
      generatedAt: input.generatedAt,
      manifestChecksumSha256: input.manifestChecksumSha256,
    },
    job: {
      status: "completed",
      service: {
        key: text(input.job.serviceKey, 100),
        tier: text(input.job.tierKey, 100),
      },
      projectReference: text(input.job.projectReference, 160),
      location: {
        name: text(input.job.locationName, 160),
        city: text(input.job.city, 100),
        state: text(input.job.state, 32),
      },
      promisedArrivalWindow:
        input.job.promisedArrivalStartAt && input.job.promisedArrivalEndAt
          ? {
              startAt: input.job.promisedArrivalStartAt,
              endAt: input.job.promisedArrivalEndAt,
              timezone: text(input.job.timezone, 100),
            }
          : null,
      completedAt: input.job.completedAt,
    },
    proof: {
      requirements: input.requirements.map((requirement) => ({
        category: text(requirement.category, 40),
        required: requirement.required,
        minimumCount: requirement.minimumCount,
        readyCount: requirement.readyCount,
        satisfied: requirement.satisfied,
      })),
      evidence: input.evidence.map((item, index) => ({
        category: text(item.category, 40),
        caption: text(item.caption, 500),
        capturedAt: item.capturedAt,
        contentType: item.contentType,
        byteSize: item.byteSize,
        width: item.width,
        height: item.height,
        sha256: item.sha256,
        archivePath: paths[index],
      })),
    },
  }) as Record<string, unknown>;
}

const styles = StyleSheet.create({
  page: {
    paddingTop: 42,
    paddingBottom: 54,
    paddingHorizontal: 42,
    fontFamily: "Noto Sans",
    fontSize: 9,
    lineHeight: 1.45,
    color: "#17221a",
  },
  header: {
    borderBottomWidth: 2,
    borderBottomColor: "#173f2b",
    paddingBottom: 16,
    marginBottom: 20,
  },
  eyebrow: { fontSize: 8, color: "#59675e", textTransform: "uppercase", letterSpacing: 1 },
  title: { fontSize: 22, color: "#173f2b", fontWeight: 700, marginTop: 3 },
  subtitle: { fontSize: 10, color: "#59675e", marginTop: 5 },
  summary: { flexDirection: "row", gap: 12, marginBottom: 18 },
  summaryCard: { flexGrow: 1, flexBasis: 0, backgroundColor: "#f3f7f3", padding: 11, borderRadius: 6 },
  label: { fontSize: 7, color: "#59675e", textTransform: "uppercase", marginBottom: 3 },
  value: { fontSize: 10, fontWeight: 700, color: "#173f2b" },
  section: { marginBottom: 18 },
  sectionTitle: { fontSize: 13, color: "#173f2b", fontWeight: 700, marginBottom: 8 },
  row: { flexDirection: "row", justifyContent: "space-between", borderBottomWidth: 1, borderBottomColor: "#d9e2da", paddingVertical: 6 },
  proofCard: { borderWidth: 1, borderColor: "#d9e2da", borderRadius: 6, padding: 10, marginBottom: 12, breakInside: "avoid" },
  image: { width: "100%", maxHeight: 320, objectFit: "contain", backgroundColor: "#f3f7f3", marginBottom: 8 },
  caption: { fontSize: 9, marginTop: 3 },
  checksum: { color: "#59675e", fontSize: 7, marginTop: 4 },
  footer: { position: "absolute", left: 42, right: 42, bottom: 24, borderTopWidth: 1, borderTopColor: "#d9e2da", paddingTop: 7, flexDirection: "row", justifyContent: "space-between", color: "#59675e", fontSize: 7 },
});

function formatInstant(value: string, timezone: string): string {
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return "Not recorded";
  try {
    return new Intl.DateTimeFormat("en-US", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: timezone,
    }).format(at);
  } catch {
    return at.toISOString();
  }
}

async function pdfImageData(original: Buffer): Promise<string | null> {
  try {
    const jpeg = await sharp(original, { failOn: "error" })
      .rotate()
      .resize({ width: 900, height: 650, fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 76, progressive: false })
      .toBuffer();
    return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  } catch {
    return null;
  }
}

async function renderPdf(
  input: PartnerProofPackageRenderInput,
  previewImages: readonly (string | null)[],
): Promise<Buffer> {
  registerFonts();
  const location =
    text(input.job.locationName, 160) ??
    [text(input.job.city, 100), text(input.job.state, 32)].filter(Boolean).join(", ") ??
    "Service location";
  const completedAt = formatInstant(input.job.completedAt, input.job.timezone);
  const pdf = await renderToBuffer(
    <Document title={`Stonegate completion proof - ${location}`} author="Stonegate">
      <Page size="LETTER" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.eyebrow}>Stonegate verified service record</Text>
          <Text style={styles.title}>Completion proof</Text>
          <Text style={styles.subtitle}>{location} · Package v{input.version}</Text>
        </View>
        <View style={styles.summary}>
          <View style={styles.summaryCard}><Text style={styles.label}>Service</Text><Text style={styles.value}>{label(input.job.serviceKey)}</Text></View>
          <View style={styles.summaryCard}><Text style={styles.label}>Completed</Text><Text style={styles.value}>{completedAt}</Text></View>
          <View style={styles.summaryCard}><Text style={styles.label}>Proof status</Text><Text style={styles.value}>Complete</Text></View>
        </View>
        {input.job.projectReference ? <View style={styles.section}><Text style={styles.sectionTitle}>Project reference</Text><Text>{text(input.job.projectReference, 160)}</Text></View> : null}
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Evidence requirements</Text>
          {input.requirements.map((requirement) => <View key={requirement.category} style={styles.row}><Text>{label(requirement.category)}</Text><Text>{requirement.readyCount} of {requirement.minimumCount} ready · {requirement.satisfied ? "Satisfied" : "Incomplete"}</Text></View>)}
        </View>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Before-and-after service proof</Text>
          {input.evidence.map((item, index) => <View key={item.reference} style={styles.proofCard} wrap={false}>
            {/* React PDF images are document content; DOM alt attributes do not apply. */}
            {/* eslint-disable-next-line jsx-a11y/alt-text */}
            {previewImages[index] ? <Image src={previewImages[index]} style={styles.image} /> : null}
            <Text style={styles.value}>{label(item.category)} photo</Text>
            {item.caption ? <Text style={styles.caption}>{text(item.caption, 500)}</Text> : null}
            <Text style={styles.checksum}>Captured {formatInstant(item.capturedAt, input.job.timezone)} · SHA-256 {item.sha256}</Text>
          </View>)}
        </View>
        <View style={styles.footer} fixed><Text>Immutable completion record · Manifest {input.manifestChecksumSha256.slice(0, 16)}…</Text><Text render={({ pageNumber, totalPages }) => `Page ${pageNumber} of ${totalPages}`} /></View>
      </Page>
    </Document>,
  );
  return Buffer.from(pdf);
}

export async function renderPartnerProofPackageArtifacts(
  input: PartnerProofPackageRenderInput,
): Promise<PartnerProofPackageArtifacts> {
  if (!input.evidence.length || input.requirements.some((item) => !item.satisfied)) {
    throw new TypeError("A proof package requires complete, ready evidence.");
  }
  for (const item of input.evidence) {
    if (
      item.byteSize !== item.originalBytes.byteLength ||
      sha256PartnerProofBytes(item.originalBytes) !== item.sha256
    ) {
      throw new TypeError("A proof-package original does not match its immutable evidence record.");
    }
  }
  const paths = input.evidence.map(archiveFilename);
  const publicRecord = completionRecord(input, paths);
  const recordBytes = Buffer.from(`${JSON.stringify(publicRecord, null, 2)}\n`, "utf8");
  const zip = createPartnerProofArchive(
    [
      { path: "completion-record.json", body: recordBytes },
      ...input.evidence.map((item, index) => ({
        path: paths[index] ?? `proof/${index + 1}.bin`,
        body: item.originalBytes,
      })),
    ],
    new Date(input.generatedAt),
  );
  const previewImages = await Promise.all(
    input.evidence.map((item) => pdfImageData(item.originalBytes)),
  );
  const pdf = await renderPdf(input, previewImages);
  return {
    pdf: {
      body: pdf,
      sha256: sha256PartnerProofBytes(pdf),
      filename: `stonegate-completion-proof-v${input.version}.pdf`,
    },
    zip: {
      body: zip,
      sha256: sha256PartnerProofBytes(zip),
      filename: `stonegate-original-proof-v${input.version}.zip`,
    },
    publicRecord,
  };
}
