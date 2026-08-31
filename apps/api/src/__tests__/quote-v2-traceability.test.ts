import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(process.cwd(), "../..");
const AUDIT = path.join(
  REPO_ROOT,
  "docs/audits/professional-quote-audit-2026-08-30.md",
);
const TRACE = path.join(
  REPO_ROOT,
  "docs/audits/professional-quote-traceability-2026-08-30.md",
);
const ID = /^\| (QTE-(?:\d{3}|TST-\d{3})) \|/gmu;

function ids(source: string): string[] {
  return [...source.matchAll(ID)].map((match) => match[1] as string).sort();
}

describe("Professional Quote audit traceability", () => {
  const audit = fs.readFileSync(AUDIT, "utf8");
  const trace = fs.readFileSync(TRACE, "utf8");

  it("maps every product and automated-confidence audit ID exactly once", () => {
    const auditIds = ids(audit);
    const traceIds = ids(trace);
    expect(auditIds).toHaveLength(100);
    expect(new Set(traceIds).size).toBe(100);
    expect(traceIds).toEqual(auditIds);
  });

  it("gives every item a severity, status, implementation/test evidence, and gate", () => {
    const rows = trace
      .split("\n")
      .filter((line) => /^\| QTE-(?:\d{3}|TST-\d{3}) \|/u.test(line));
    expect(rows).toHaveLength(100);
    for (const row of rows) {
      const cells = row
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
      expect(cells[1]).toMatch(/^P[0-3]$/u);
      expect(cells[2].length).toBeGreaterThan(3);
      expect(cells[3].length).toBeGreaterThan(8);
      expect(cells[4].length).toBeGreaterThan(3);
    }
  });

  it("keeps all open P2 work explicit and GA unapproved", () => {
    expect(trace).toContain("No P2 item is silently deferred");
    expect(trace).toContain("QTE-TST-012");
    expect(trace).toContain("General availability remains **not approved**");
    expect(trace).not.toContain(
      "canonical V2 service or public resolver is wired",
    );
  });
});
