import type {
  ConsoleMessage,
  Page,
  Request,
  Response,
  Route,
  TestInfo,
} from "@playwright/test";

export type SurfaceHealthIssueKind =
  | "console_error"
  | "external_request"
  | "page_error"
  | "same_origin_http_error"
  | "same_origin_request_failed";

export type SurfaceHealthIssue = {
  kind: SurfaceHealthIssueKind;
  detail: string;
  method?: string;
  status?: number;
  url?: string;
};

export type SurfaceHealthAllowance = {
  kind: SurfaceHealthIssueKind;
  reason: string;
  detail?: RegExp;
  method?: string;
  pathname?: string;
  status?: number;
};

type SurfaceHealthMonitor = {
  assertHealthy(testInfo: TestInfo): Promise<void>;
  issues(): readonly SurfaceHealthIssue[];
  stop(): Promise<void>;
};

type LoadingSnapshot = {
  busy: string[];
  loadingText: string[];
  skeletonCount: number;
};

const MAX_DIAGNOSTIC_LENGTH = 500;
const SURFACE_SETTLE_TIMEOUT_MS = 15_000;
const SURFACE_CLEAR_WINDOW_MS = 750;
const SURFACE_POLL_INTERVAL_MS = 100;

const LOADING_TEXT_PATTERN =
  /^(?:(?:checking|fetching|loading|preparing|refreshing|syncing)(?:\b|\.{3}|…)[\s\S]*|[\s\S]*\b(?:is|are)\s+loading\s*(?:[.!]|\.{3}|…)?\s*)$/iu;

/**
 * Normal owner smoke has no expected browser errors or failed requests. Any
 * future exception must be narrow, documented here, and supported by a test.
 */
export const OWNER_ALL_TAB_HEALTH_ALLOWANCES =
  [] as const satisfies readonly SurfaceHealthAllowance[];

function compact(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function bounded(value: string): string {
  const normalized = compact(value);
  return normalized.length <= MAX_DIAGNOSTIC_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_DIAGNOSTIC_LENGTH - 1)}…`;
}

export function safeAuditUrl(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "[invalid-url]";
  }
}

export function isActiveLoadingText(value: string): boolean {
  return LOADING_TEXT_PATTERN.test(compact(value));
}

function scrubDiagnostic(value: string): string {
  return bounded(
    value
      .replace(/https?:\/\/[^\s"')]+/giu, (url) => safeAuditUrl(url))
      .replace(
        /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu,
        "[redacted-email]",
      )
      .replace(
        /\b(authorization|cookie|password|secret|token)\s*[:=]\s*[^\s,;]+/giu,
        "$1=[redacted]",
      ),
  );
}

function comparableOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function networkProtocol(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

export function consoleHealthIssue(
  type: string,
  text: string,
): SurfaceHealthIssue | null {
  if (type !== "error" && type !== "assert") return null;
  return {
    kind: "console_error",
    detail: scrubDiagnostic(text || `console.${type}`),
  };
}

export function failedRequestHealthIssue(
  baseURL: string,
  requestURL: string,
  method: string,
  failureText: string | null,
): SurfaceHealthIssue | null {
  if (comparableOrigin(requestURL) !== comparableOrigin(baseURL)) return null;
  return {
    kind: "same_origin_request_failed",
    detail: scrubDiagnostic(failureText ?? "request failed without a reason"),
    method,
    url: safeAuditUrl(requestURL),
  };
}

export function responseHealthIssue(
  baseURL: string,
  responseURL: string,
  method: string,
  status: number,
): SurfaceHealthIssue | null {
  if (
    status < 400 ||
    comparableOrigin(responseURL) !== comparableOrigin(baseURL)
  ) {
    return null;
  }
  return {
    kind: "same_origin_http_error",
    detail: `HTTP ${status}`,
    method,
    status,
    url: safeAuditUrl(responseURL),
  };
}

export function externalRequestHealthIssue(
  baseURL: string,
  requestURL: string,
  method: string,
): SurfaceHealthIssue | null {
  if (
    !networkProtocol(requestURL) ||
    comparableOrigin(requestURL) === comparableOrigin(baseURL)
  ) {
    return null;
  }
  return {
    kind: "external_request",
    detail: "Browser traffic outside the audited Site origin was blocked.",
    method,
    url: safeAuditUrl(requestURL),
  };
}

function issueAllowed(
  issue: SurfaceHealthIssue,
  allowance: SurfaceHealthAllowance,
): boolean {
  if (issue.kind !== allowance.kind) return false;
  if (allowance.method && issue.method !== allowance.method) return false;
  if (allowance.status !== undefined && issue.status !== allowance.status) {
    return false;
  }
  if (allowance.detail && !allowance.detail.test(issue.detail)) return false;
  if (allowance.pathname) {
    if (!issue.url) return false;
    try {
      if (new URL(issue.url).pathname !== allowance.pathname) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function unexpectedSurfaceHealthIssues(
  issues: readonly SurfaceHealthIssue[],
  allowances: readonly SurfaceHealthAllowance[],
): SurfaceHealthIssue[] {
  return issues.filter(
    (issue) => !allowances.some((allowance) => issueAllowed(issue, allowance)),
  );
}

export function surfaceHealthAllowanceViolations(
  allowances: readonly SurfaceHealthAllowance[],
): string[] {
  return allowances.flatMap((allowance, index) => {
    const prefix = `allowance ${index + 1} (${allowance.kind})`;
    const violations: string[] = [];
    if (!allowance.reason.trim()) {
      violations.push(`${prefix} must document a reason.`);
    }
    if (allowance.kind === "console_error" || allowance.kind === "page_error") {
      if (!allowance.detail) {
        violations.push(
          `${prefix} must use an exact, anchored detail matcher.`,
        );
      }
    } else {
      if (!allowance.method || !allowance.pathname) {
        violations.push(`${prefix} must declare an exact method and pathname.`);
      }
      if (
        allowance.kind === "same_origin_http_error" &&
        allowance.status === undefined
      ) {
        violations.push(`${prefix} must declare an exact HTTP status.`);
      }
    }
    if (allowance.detail) {
      if (
        allowance.detail.global ||
        allowance.detail.sticky ||
        !allowance.detail.source.startsWith("^") ||
        !allowance.detail.source.endsWith("$")
      ) {
        violations.push(
          `${prefix} detail must be anchored and must not be global or sticky.`,
        );
      }
    }
    return violations;
  });
}

function issueKey(issue: SurfaceHealthIssue): string {
  return JSON.stringify([
    issue.kind,
    issue.method ?? null,
    issue.status ?? null,
    issue.url ?? null,
    issue.detail,
  ]);
}

function formatIssues(issues: readonly SurfaceHealthIssue[]): string {
  return issues
    .map((issue, index) => {
      const request = [issue.method, issue.url].filter(Boolean).join(" ");
      return `${index + 1}. ${issue.kind}${request ? ` (${request})` : ""}: ${issue.detail}`;
    })
    .join("\n");
}

async function loadingSnapshot(page: Page): Promise<LoadingSnapshot> {
  return page.locator("main").evaluate((main, loadingPatternSource) => {
    const loadingPattern = new RegExp(loadingPatternSource, "iu");
    const visible = (element: Element): boolean => {
      const style = globalThis.getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        element.getClientRects().length > 0
      );
    };
    const describe = (element: Element): string => {
      const label = element.getAttribute("aria-label") ?? "";
      const text = element.textContent ?? "";
      return `${element.tagName.toLowerCase()} ${label || text}`
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 160);
    };
    const busy = Array.from(
      main.querySelectorAll(
        '[aria-busy="true"], [data-loading="true"], [data-state="loading"]',
      ),
    )
      .filter(visible)
      .map(describe);
    const loadingText = Array.from(
      main.querySelectorAll('[role="status"], div, p, span'),
    )
      .filter(
        (element) =>
          (element.matches('[role="status"]') ||
            element.children.length === 0) &&
          visible(element) &&
          loadingPattern.test(
            (element.textContent ?? "").replace(/\s+/gu, " ").trim(),
          ),
      )
      .map(describe);
    return {
      busy,
      loadingText,
      skeletonCount: Array.from(main.querySelectorAll(".animate-pulse")).filter(
        visible,
      ).length,
    };
  }, LOADING_TEXT_PATTERN.source);
}

function loadingSnapshotEmpty(snapshot: LoadingSnapshot): boolean {
  return (
    snapshot.busy.length === 0 &&
    snapshot.loadingText.length === 0 &&
    snapshot.skeletonCount === 0
  );
}

function describeLoadingSnapshot(snapshot: LoadingSnapshot): string {
  return JSON.stringify(snapshot, null, 2);
}

export async function waitForTeamSurfaceToSettle(page: Page): Promise<void> {
  await page.waitForLoadState("domcontentloaded");
  await page.locator("main").waitFor({ state: "visible" });

  const deadline = Date.now() + SURFACE_SETTLE_TIMEOUT_MS;
  let clearSince: number | null = null;
  let latest: LoadingSnapshot = {
    busy: [],
    loadingText: [],
    skeletonCount: 0,
  };

  while (Date.now() < deadline) {
    latest = await loadingSnapshot(page);
    if (loadingSnapshotEmpty(latest)) {
      clearSince ??= Date.now();
      if (Date.now() - clearSince >= SURFACE_CLEAR_WINDOW_MS) return;
    } else {
      clearSince = null;
    }
    await page.waitForTimeout(SURFACE_POLL_INTERVAL_MS);
  }

  throw new Error(
    `Team surface did not settle within ${SURFACE_SETTLE_TIMEOUT_MS}ms. Active indicators:\n${describeLoadingSnapshot(latest)}`,
  );
}

export async function monitorTeamSurfaceHealth(
  page: Page,
  baseURL: string,
  allowances: readonly SurfaceHealthAllowance[] = OWNER_ALL_TAB_HEALTH_ALLOWANCES,
): Promise<SurfaceHealthMonitor> {
  const invalidAllowances = surfaceHealthAllowanceViolations(allowances);
  if (invalidAllowances.length > 0) {
    throw new Error(
      `Team surface health allowances are too broad:\n${invalidAllowances.join("\n")}`,
    );
  }
  const recorded = new Map<string, SurfaceHealthIssue>();
  const record = (issue: SurfaceHealthIssue | null): void => {
    if (issue) recorded.set(issueKey(issue), issue);
  };

  const onConsole = (message: ConsoleMessage): void => {
    record(consoleHealthIssue(message.type(), message.text()));
  };
  const onPageError = (error: Error): void => {
    record({ kind: "page_error", detail: scrubDiagnostic(error.message) });
  };
  const onRequestFailed = (request: Request): void => {
    record(
      failedRequestHealthIssue(
        baseURL,
        request.url(),
        request.method(),
        request.failure()?.errorText ?? null,
      ),
    );
  };
  const onResponse = (response: Response): void => {
    record(
      responseHealthIssue(
        baseURL,
        response.url(),
        response.request().method(),
        response.status(),
      ),
    );
  };

  page.on("console", onConsole);
  page.on("pageerror", onPageError);
  page.on("requestfailed", onRequestFailed);
  page.on("response", onResponse);
  const routeHandler = async (route: Route): Promise<void> => {
    const request = route.request();
    const issue = externalRequestHealthIssue(
      baseURL,
      request.url(),
      request.method(),
    );
    if (issue) {
      record(issue);
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  };
  await page.route("**/*", routeHandler);

  return {
    async assertHealthy(testInfo) {
      const unexpected = unexpectedSurfaceHealthIssues(
        [...recorded.values()],
        allowances,
      );
      if (unexpected.length === 0) return;
      const body = formatIssues(unexpected);
      await testInfo.attach("team-surface-health.txt", {
        body,
        contentType: "text/plain",
      });
      throw new Error(
        `Team surface emitted unexpected browser failures:\n${body}`,
      );
    },
    issues() {
      return [...recorded.values()];
    },
    async stop() {
      page.off("console", onConsole);
      page.off("pageerror", onPageError);
      page.off("requestfailed", onRequestFailed);
      page.off("response", onResponse);
      await page.unroute("**/*", routeHandler);
    },
  };
}
