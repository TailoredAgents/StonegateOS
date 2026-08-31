import { writeFile } from "node:fs/promises";
import {
  buildQuoteV2LatencyMetric,
  createQuoteV2PerformanceFixture,
  measureQuoteV2Operation,
  QUOTE_V2_PDF_P95_THRESHOLD_MS,
  QUOTE_V2_PDF_WARMUPS,
  QUOTE_V2_STANDARD_PDF_MAX_BYTES,
  QUOTE_V2_STANDARD_PDF_MIN_BYTES,
  QuoteV2PerformanceError,
} from "../../scripts/quote-v2-performance-core";
import { renderQuoteProposalPdf } from "../lib/quote-v2-pdf";

const SAMPLE_PATTERN = /^(?:2[0-9]|3[0-9]|4[0-9]|50)$/u;

function requiredConfiguration(): { samples: number; resultPath: string } {
  if (process.env["QUOTE_V2_PDF_PERFORMANCE_EXECUTE"] !== "1") {
    throw new QuoteV2PerformanceError(
      "performance_pdf_worker_authorization_required",
    );
  }
  const rawSamples =
    process.env["QUOTE_V2_PDF_PERFORMANCE_SAMPLES"]?.trim() ?? "";
  const resultPath =
    process.env["QUOTE_V2_PDF_PERFORMANCE_RESULT"]?.trim() ?? "";
  if (!SAMPLE_PATTERN.test(rawSamples)) {
    throw new QuoteV2PerformanceError("performance_pdf_worker_samples_invalid");
  }
  if (
    !resultPath.startsWith("/") ||
    resultPath.length > 1_000 ||
    !resultPath.endsWith("/pdf-result.json")
  ) {
    throw new QuoteV2PerformanceError(
      "performance_pdf_worker_result_path_invalid",
    );
  }
  return { samples: Number(rawSamples), resultPath };
}

describe("Quote V2 standard proposal PDF performance worker", () => {
  it(
    "records a bounded canonical PDF p95 result for the release harness",
    async () => {
      const configuration = requiredConfiguration();
      const fixture = createQuoteV2PerformanceFixture();
      let standardPdfBytes = 0;
      const durations = await measureQuoteV2Operation({
        samples: configuration.samples,
        warmups: QUOTE_V2_PDF_WARMUPS,
        operation: () => renderQuoteProposalPdf({ model: fixture.renderModel }),
        validate: (pdf) => {
          if (
            pdf.subarray(0, 5).toString("ascii") !== "%PDF-" ||
            pdf.byteLength < QUOTE_V2_STANDARD_PDF_MIN_BYTES ||
            pdf.byteLength > QUOTE_V2_STANDARD_PDF_MAX_BYTES
          ) {
            throw new QuoteV2PerformanceError(
              "performance_standard_pdf_invalid",
            );
          }
          standardPdfBytes = pdf.byteLength;
        },
      });
      const metric = buildQuoteV2LatencyMetric({
        name: "standard_proposal_pdf",
        durationsMs: durations,
        warmups: QUOTE_V2_PDF_WARMUPS,
        thresholdMs: QUOTE_V2_PDF_P95_THRESHOLD_MS,
      });
      await writeFile(
        configuration.resultPath,
        `${JSON.stringify({ metric, standardPdfBytes })}\n`,
        { encoding: "utf8", flag: "wx", mode: 0o600 },
      );
      expect(durations).toHaveLength(configuration.samples);
    },
    5 * 60 * 1_000,
  );
});
