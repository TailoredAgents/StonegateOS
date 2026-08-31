import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(process.cwd(), "../..");

describe("partner portal Site proxy headers", () => {
  it("preserves Headers instances through the authenticated server client", () => {
    const client = readFileSync(
      join(ROOT, "apps/site/src/app/partners/lib/api.ts"),
      "utf8",
    );
    const proxy = readFileSync(
      join(
        ROOT,
        "apps/site/src/app/api/partners/portal/[...segments]/route.ts",
      ),
      "utf8",
    );

    expect(client).toContain("function mergeHeaders(");
    expect(client).toContain("new Headers(incoming)");
    expect(client).toContain(
      "headers: mergeHeaders(defaultHeaders, requestInit.headers)",
    );
    expect(client).toContain("headers: mergeHeaders({}, init?.headers");
    expect(client).not.toContain("...(requestInit?.headers ?? {})");
    expect(proxy).toContain('"idempotency-key"');
    expect(proxy).toContain('"if-match"');
    expect(proxy).toContain('"x-correlation-id"');
  });

  it("drains debounced autosaves before revision-sensitive booking actions", () => {
    const wizard = readFileSync(
      join(
        ROOT,
        "apps/site/src/app/partners/components/PartnerBookingWizard.tsx",
      ),
      "utf8",
    );

    expect(wizard).toContain("const autosaveTimeoutRef = React.useRef");
    expect(wizard).toContain("const cancelPendingAutosave");
    expect(wizard).toContain("const flushPersist");
    expect(wizard).toContain("await saveQueueRef.current");
    expect(wizard.match(/await flushPersist\(form\)/gu)).toHaveLength(2);
  });
});
