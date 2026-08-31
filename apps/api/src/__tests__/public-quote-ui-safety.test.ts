import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = process.cwd();
const REPO_ROOT = join(API_ROOT, "../..");

function repoSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.[cm]?[jt]sx?$/u.test(entry.name) ? [path] : [];
  });
}

function functionSlice(source: string, start: string, end: string): string {
  const startIndex = source.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
}

describe("public quote UI safety", () => {
  const publicPage = repoSource("apps/site/src/app/quote/[token]/page.tsx");
  const publicForms = repoSource(
    "apps/site/src/app/quote/[token]/PublicQuoteForms.tsx",
  );
  const normalizedPublicPage = publicPage.replace(/\s+/gu, " ");

  it("binds change, accept, and decline submissions to the rendered quote version", () => {
    const acceptAction = functionSlice(
      publicPage,
      "export async function acceptQuoteAction",
      "export async function declineQuoteAction",
    );
    const declineAction = functionSlice(
      publicPage,
      "export async function declineQuoteAction",
      "export async function refreshQuoteAction",
    );
    const changeAction = functionSlice(
      publicPage,
      "export async function requestQuoteChangesAction",
      "export async function bookQuoteAction",
    );

    for (const action of [acceptAction, declineAction, changeAction]) {
      expect(action).toContain('formData.get("quoteId")');
      expect(action).toContain('formData.get("expectedRevision")');
      expect(action).toContain("quoteId: quoteId.trim()");
      expect(action).toContain("expectedRevision,");
    }
    expect(publicForms).toContain('name="quoteId"');
    expect(publicForms).toContain('name="expectedRevision"');
    expect(publicPage).toContain('name="expectedRevision"');
    expect(publicPage).toContain("value={String(quote.revision)}");
  });

  it("preserves a failed change request and announces exact success or error feedback", () => {
    expect(publicForms).toContain("value={reason}");
    expect(publicForms).toContain("value={details}");
    expect(publicForms).toContain("setDetails(event.target.value)");
    expect(publicForms).toContain("Your text stays here if sending fails");
    expect(publicForms).toContain('role={actionState.ok ? "status" : "alert"}');
    expect(publicForms).toContain(
      'aria-live={actionState.ok ? "polite" : "assertive"}',
    );
    expect(changeActionSource(publicPage)).toContain("Your text is still here");
    expect(changeActionSource(publicPage)).toContain(
      "Change request received. Stonegate will review it and follow up.",
    );
  });

  it("keeps loading, available, confirmed-empty, and unavailable scheduling states distinct", () => {
    for (const state of [
      "loading",
      "available",
      "confirmed-empty",
      "unavailable",
    ]) {
      expect(publicPage).toContain(`data-availability-state="${state}"`);
    }
    expect(publicPage).toContain(
      "<Suspense fallback={<AvailabilityLoadingState />}",
    );
    expect(publicPage).toContain('value["ok"] !== true');
    expect(publicPage).toContain('return { kind: "unavailable" }');
    expect(normalizedPublicPage).toContain(
      "which does not mean appointment windows are full",
    );
    expect(normalizedPublicPage).toContain(
      "We checked current online availability",
    );
    expect(publicPage).toContain("Retry availability");
    expect(publicPage).not.toContain("That time was no longer available");
    expect(publicPage).not.toContain(
      "No online windows are available right now",
    );
  });

  it("provides pending controls and localized form/table semantics", () => {
    expect(publicForms).toContain("useFormStatus()");
    expect(publicForms).toContain("disabled={pending}");
    expect(publicPage).toContain('pendingLabel="Booking…"');
    expect(publicForms).toContain("Sending request…");
    expect(publicPage).toContain("Requesting refresh…");
    expect(publicPage).toContain("Approving quote…");
    expect(publicPage).toContain("Sending decision…");
    expect(publicPage).toContain("Quoted services and prices");
    expect(publicPage).toContain('<th scope="col">Service</th>');
    expect(publicPage).toContain('scope="row"');
    expect(publicPage).toContain("quote-decline-reason-");
    expect(publicPage).toContain("quote-decline-notes-");
  });

  it("does not use the undefined custom primary-950 token", () => {
    const offenders = sourceFiles(join(REPO_ROOT, "apps/site/src")).filter(
      (path) => readFileSync(path, "utf8").includes("primary-950"),
    );
    expect(offenders).toEqual([]);
  });
});

function changeActionSource(publicPage: string): string {
  return functionSlice(
    publicPage,
    "export async function requestQuoteChangesAction",
    "export async function bookQuoteAction",
  );
}
