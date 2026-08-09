import fs from "node:fs";
import path from "node:path";

const REPOSITORY_ROOT = path.resolve(__dirname, "../../../..");
const AUDIT_ROOT = path.resolve(REPOSITORY_ROOT, "tests/e2e/audit");

function auditSpecSources(): Array<{ file: string; source: string }> {
  return fs
    .readdirSync(AUDIT_ROOT)
    .filter((file) => file.endsWith(".spec.ts"))
    .sort()
    .map((file) => ({
      file,
      source: fs.readFileSync(path.resolve(AUDIT_ROOT, file), "utf8"),
    }));
}

function calls(source: string, marker: string): string[] {
  const matches: string[] = [];
  let searchAt = 0;
  while (searchAt < source.length) {
    const start = source.indexOf(marker, searchAt);
    if (start < 0) break;
    let depth = 1;
    let index = start + marker.length;
    let quote: '"' | "'" | "`" | null = null;
    let escaped = false;
    for (; index < source.length && depth > 0; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
      } else if (character === '"' || character === "'" || character === "`") {
        quote = character;
      } else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
    }
    matches.push(source.slice(start, index));
    searchAt = index;
  }
  return matches;
}

describe("Team audit executable-test contract", () => {
  it("contains no disabled placeholder or unconditional skip", () => {
    for (const { file, source } of auditSpecSources()) {
      expect({
        file,
        containsDisabledPlaceholder:
          /\b(?:test|it|describe)\.(?:fixme|todo)\b|\bdescribe\.skip\b/u.test(
            source,
          ),
      }).toEqual({ file, containsDisabledPlaceholder: false });
      for (const call of calls(source, "test.skip(")) {
        expect(call).not.toMatch(/^test\.skip\(\s*true\b/u);
        expect(call).toMatch(/,\s*["'`](?:[^"'`]|\\.)+["'`]\s*,?\s*\)$/su);
      }
    }
  });

  it("keeps the nine remaining audit skips limited to declared project or viewport routing", () => {
    const skipCalls = auditSpecSources().flatMap(({ source }) =>
      calls(source, "test.skip("),
    );
    expect(skipCalls).toHaveLength(9);
    for (const call of skipCalls) {
      expect(call).toMatch(/testInfo\.project\.name|viewport\.width/u);
    }
  });

  it("keeps all seven required critical journeys executable", () => {
    const source = fs.readFileSync(
      path.resolve(AUDIT_ROOT, "team-console-audit.spec.ts"),
      "utf8",
    );
    for (const title of [
      "lead to booked job with database and audit assertions",
      "day-of-service completion through payment and crew attribution",
      "Sales HQ lead recovery through Inbox outcome",
      "outbound import through partner conversion",
      "money close through locked and paid payout",
      "automation policy through simulation and approval boundary",
      "custom role creation through revocation",
    ]) {
      expect(source).toContain(`test("${title}"`);
      expect(source).not.toContain(`test.fixme("${title}"`);
      expect(source).not.toContain(`test.skip("${title}"`);
    }
  });

  it("does not allow unavailable local services to become a silent CI skip", () => {
    const harness = fs.readFileSync(
      path.resolve(REPOSITORY_ROOT, "tests/e2e/test.ts"),
      "utf8",
    );
    const ciFailure = harness.indexOf("if (process.env.CI)");
    const localSkip = harness.indexOf("testInfo.skip(true, reason)");
    expect(ciFailure).toBeGreaterThanOrEqual(0);
    expect(localSkip).toBeGreaterThan(ciFailure);
    expect(harness.slice(ciFailure, localSkip)).toContain(
      "throw new Error(reason)",
    );
  });

  it("keeps the Team audit retry-free so flakiness cannot masquerade as a pass", () => {
    const config = fs.readFileSync(
      path.resolve(REPOSITORY_ROOT, "playwright.team-audit.config.ts"),
      "utf8",
    );
    expect(config).toMatch(/\bretries:\s*0\b/u);
  });
});
