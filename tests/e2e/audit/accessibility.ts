import { createRequire } from "node:module";
import type { Page, TestInfo } from "@playwright/test";

const WCAG_22_AA_TAGS = [
  "wcag2a",
  "wcag2aa",
  "wcag21a",
  "wcag21aa",
  "wcag22aa",
] as const;

type AxeImpact = "minor" | "moderate" | "serious" | "critical" | null;

type AxeRunOptions = {
  runOnly: { type: "tag"; values: string[] };
  reporter: "v2";
  resultTypes: Array<"violations" | "incomplete">;
  selectors: boolean;
  ancestry: boolean;
  xpath: boolean;
  absolutePaths: boolean;
  iframes: boolean;
  elementRef: boolean;
};

type AxeNodeResult = {
  target: unknown;
  impact?: AxeImpact;
  failureSummary?: string;
};

type AxeResult = {
  id: string;
  impact?: AxeImpact;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: AxeNodeResult[];
};

type AxeResults = {
  violations: AxeResult[];
  incomplete: AxeResult[];
};

type AxeCoreModule = {
  source: string;
  version: string;
};

const BLOCKING_IMPACTS = new Set<AxeImpact>(["serious", "critical"]);
const requireFromAudit = createRequire(__filename);

type BrowserAxeApi = {
  run: (
    context: Document | string,
    options: AxeRunOptions,
  ) => Promise<AxeResults>;
};

type EvidenceNode = {
  target: unknown;
  impact: AxeImpact | undefined;
  failureSummary: string | undefined;
};

type EvidenceResult = {
  id: string;
  impact: AxeImpact | undefined;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: EvidenceNode[];
};

export type TeamAccessibilityState =
  | "normal"
  | "empty"
  | "error"
  | "modal"
  | "drawer";

export type TeamAccessibilityScanOptions = {
  page: Page;
  testInfo: TestInfo;
  surface: string;
  state: TeamAccessibilityState;
  /**
   * Restrict a scan to a named subtree only when the surrounding document is
   * deliberately outside the state under test. Exclusion lists and disabled
   * rules are intentionally unsupported so regressions cannot be hidden.
   */
  context?: string;
};

function loadAxeCore(): AxeCoreModule {
  let candidate: unknown;
  try {
    candidate = requireFromAudit("axe-core");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The declared axe-core test dependency is not linked. Run the pinned offline install before the Team accessibility suite. ${detail}`,
    );
  }
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof (candidate as { source?: unknown }).source !== "string" ||
    typeof (candidate as { version?: unknown }).version !== "string"
  ) {
    throw new Error("The linked axe-core module has an invalid runtime shape.");
  }
  return candidate as AxeCoreModule;
}

function evidenceResult(result: AxeResult): EvidenceResult {
  return {
    id: result.id,
    impact: result.impact,
    help: result.help,
    helpUrl: result.helpUrl,
    tags: [...result.tags],
    nodes: result.nodes.map((node) => ({
      target: node.target,
      impact: node.impact,
      failureSummary: node.failureSummary,
    })),
  };
}

function safePageLocation(page: Page): {
  pathname: string;
  queryKeys: string[];
} {
  const url = new URL(page.url());
  return {
    pathname: url.pathname,
    queryKeys: [...url.searchParams.keys()].sort(),
  };
}

function evidenceName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
}

function blockingSummary(violations: AxeResult[]): string {
  return violations
    .map((violation) => {
      const targets = violation.nodes
        .slice(0, 5)
        .map((node) => JSON.stringify(node.target))
        .join(", ");
      return `${violation.id} (${violation.impact}, ${violation.nodes.length} node${
        violation.nodes.length === 1 ? "" : "s"
      }): ${targets}`;
    })
    .join("\n");
}

/**
 * Runs axe-core's automated WCAG 2.2 AA rules and stores redacted evidence.
 *
 * This gate deliberately fails on serious or critical violations and records
 * every lower-impact violation and incomplete/manual-review result. Automated
 * rules cover only part of WCAG; keyboard, screen-reader, zoom, contrast-mode,
 * reduced-motion, and full-page conformance reviews remain mandatory release
 * evidence and must never be replaced by this helper.
 */
export async function expectTeamStateToPassAutomatedWcag({
  page,
  testInfo,
  surface,
  state,
  context,
}: TeamAccessibilityScanOptions): Promise<AxeResults> {
  await page.evaluate(async () => {
    await document.fonts?.ready;
    await new Promise<void>((resolve) => {
      globalThis.requestAnimationFrame(() => {
        globalThis.requestAnimationFrame(() => resolve());
      });
    });
  });

  const axeIsReady = await page.evaluate(
    () =>
      typeof (globalThis as typeof globalThis & { axe?: BrowserAxeApi }).axe
        ?.run === "function",
  );
  const axeCore = loadAxeCore();
  if (!axeIsReady) {
    // Runtime.evaluate is used instead of a network script so the audit is
    // deterministic, works offline, and does not weaken the application's CSP.
    await page.evaluate(axeCore.source);
  }

  const options: AxeRunOptions = {
    runOnly: { type: "tag", values: [...WCAG_22_AA_TAGS] },
    reporter: "v2",
    resultTypes: ["violations", "incomplete"],
    selectors: true,
    ancestry: true,
    xpath: false,
    absolutePaths: false,
    iframes: true,
    elementRef: false,
  };

  const results = await page.evaluate(
    async ({ scanContext, runOptions }) => {
      const axeApi = (globalThis as typeof globalThis & { axe?: BrowserAxeApi })
        .axe;
      if (!axeApi) {
        throw new Error("axe-core did not initialize in the browser page.");
      }
      return axeApi.run(scanContext ?? document, runOptions);
    },
    { scanContext: context, runOptions: options },
  );

  const blockingViolations = results.violations.filter((violation) =>
    BLOCKING_IMPACTS.has(violation.impact ?? null),
  );
  const evidence = {
    schemaVersion: 1,
    engine: { name: "axe-core", version: axeCore.version },
    standard: "WCAG 2.2 AA automated rules",
    project: testInfo.project.name,
    surface,
    state,
    location: safePageLocation(page),
    scannedAt: new Date().toISOString(),
    summary: {
      violations: results.violations.length,
      blockingViolations: blockingViolations.length,
      incompleteManualReview: results.incomplete.length,
    },
    violations: results.violations.map(evidenceResult),
    incomplete: results.incomplete.map(evidenceResult),
    manualCertificationStillRequired: true,
  };
  const attachmentName = `wcag-${evidenceName(surface)}-${state}`;
  await testInfo.attach(attachmentName, {
    body: Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`, "utf8"),
    contentType: "application/json",
  });
  if (results.incomplete.length > 0) {
    testInfo.annotations.push({
      type: "wcag-manual-review",
      description: `${surface} (${state}) has ${results.incomplete.length} axe result${
        results.incomplete.length === 1 ? "" : "s"
      } that automation could not decide; review the attached evidence.`,
    });
  }

  if (blockingViolations.length > 0) {
    throw new Error(
      `${surface} (${state}) has ${blockingViolations.length} serious/critical automated WCAG violation${
        blockingViolations.length === 1 ? "" : "s"
      }. See the ${attachmentName} evidence attachment.\n${blockingSummary(
        blockingViolations,
      )}`,
    );
  }

  return results;
}
