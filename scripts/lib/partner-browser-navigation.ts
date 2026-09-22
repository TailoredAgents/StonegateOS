import type { Page, Request, Response } from "@playwright/test";

type DocumentRequests = {
  pending: Set<Request>;
  changed: Set<() => void>;
  closed: boolean;
};

const documents = new WeakMap<Page, DocumentRequests>();

function trackDocumentRequests(page: Page): DocumentRequests {
  const existing = documents.get(page);
  if (existing) return existing;
  const state: DocumentRequests = {
    pending: new Set(),
    changed: new Set(),
    closed: page.isClosed(),
  };
  const notify = () => {
    for (const listener of state.changed) listener();
  };
  const started = (request: Request) => {
    state.pending.add(request);
    notify();
  };
  const settled = (request: Request) => {
    state.pending.delete(request);
    notify();
  };
  page.on("request", started);
  page.on("requestfinished", settled);
  page.on("requestfailed", settled);
  page.once("close", () => {
    state.closed = true;
    state.pending.clear();
    page.off("request", started);
    page.off("requestfinished", settled);
    page.off("requestfailed", settled);
    documents.delete(page);
    notify();
  });
  documents.set(page, state);
  return state;
}

async function settleDocumentRequests(page: Page): Promise<void> {
  const state = trackDocumentRequests(page);
  if (state.closed)
    throw new Error("The browser page closed before navigation.");
  if (page.url() === "about:blank") return;
  // Playwright's networkidle lifecycle can already be set when later Next
  // prefetches start. Observe current requests and a fresh quiet window instead.
  // Only harness-forced document boundaries wait; actual UI clicks are unchanged.
  await new Promise<void>((resolve, reject) => {
    let quiet: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(
      () =>
        finish(
          new Error(
            `Browser requests did not settle before navigation (${state.pending.size} pending).`,
          ),
        ),
      15_000,
    );
    function finish(error?: Error) {
      clearTimeout(deadline);
      clearTimeout(quiet);
      state.changed.delete(changed);
      if (error) reject(error);
      else resolve();
    }
    function changed() {
      clearTimeout(quiet);
      if (state.closed) {
        finish(
          new Error("The browser page closed while requests were settling."),
        );
      } else if (state.pending.size === 0) {
        quiet = setTimeout(() => finish(), 500);
      }
    }
    state.changed.add(changed);
    changed();
  });
}

export async function navigatePartnerBrowserPage(
  page: Page,
  url: string,
): Promise<Response | null> {
  await settleDocumentRequests(page);
  const response = await page.goto(url);
  await settleDocumentRequests(page);
  return response;
}

export async function reloadPartnerBrowserPage(
  page: Page,
): Promise<Response | null> {
  await settleDocumentRequests(page);
  const response = await page.reload();
  await settleDocumentRequests(page);
  return response;
}
