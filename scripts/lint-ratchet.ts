import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type EslintMessage = {
  severity: number;
  ruleId: string | null;
  fatal?: boolean;
};

type EslintFileResult = {
  filePath: string;
  messages: EslintMessage[];
};

type RuleCounts = Record<string, number>;

type AppBaseline = {
  totalErrors: number;
  byFile: Record<string, RuleCounts>;
};

type LintBaseline = {
  version: 1;
  cleanTouchedFilesSince: string;
  totalErrors: number;
  apps: Record<string, AppBaseline>;
};

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = resolve(workspaceRoot, "quality/lint-baseline.json");
const apps = ["api", "site"] as const;
const update = process.argv.includes("--update");

function runGit(args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed:\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout.trim();
}

function sortRecord<T>(value: Record<string, T>): Record<string, T> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function collectApp(app: (typeof apps)[number]): AppBaseline {
  const result = spawnSync(
    resolve(workspaceRoot, `apps/${app}/node_modules/.bin/eslint`),
    [".", "--format", "json"],
    {
      cwd: resolve(workspaceRoot, `apps/${app}`),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: process.env,
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(
      `${app} ESLint failed before producing a report:\n${result.stderr}`,
    );
  }

  let report: EslintFileResult[];
  try {
    report = JSON.parse(result.stdout) as EslintFileResult[];
  } catch {
    throw new Error(
      `${app} ESLint did not return JSON:\n${result.stderr || result.stdout}`,
    );
  }

  let totalErrors = 0;
  const byFile: Record<string, RuleCounts> = {};
  for (const file of report) {
    const counts: RuleCounts = {};
    for (const message of file.messages) {
      if (message.severity !== 2) continue;
      totalErrors += 1;
      const rule = message.ruleId ?? (message.fatal ? "__fatal__" : "__unknown__");
      counts[rule] = (counts[rule] ?? 0) + 1;
    }
    if (Object.keys(counts).length > 0) {
      byFile[relative(workspaceRoot, file.filePath)] = sortRecord(counts);
    }
  }

  return { totalErrors, byFile: sortRecord(byFile) };
}

const currentApps = Object.fromEntries(
  apps.map((app) => [app, collectApp(app)]),
) as Record<string, AppBaseline>;
const current: LintBaseline = {
  version: 1,
  cleanTouchedFilesSince: runGit(["rev-parse", "HEAD"]),
  totalErrors: Object.values(currentApps).reduce(
    (sum, app) => sum + app.totalErrors,
    0,
  ),
  apps: currentApps,
};

if (update) {
  writeFileSync(baselinePath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  console.log(
    `Recorded ${current.totalErrors} existing lint errors in ${relative(workspaceRoot, baselinePath)}.`,
  );
  process.exit(0);
}

const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as LintBaseline;
const increases: string[] = [];

for (const [appName, app] of Object.entries(current.apps)) {
  const oldApp = baseline.apps[appName];
  for (const [file, rules] of Object.entries(app.byFile)) {
    for (const [rule, count] of Object.entries(rules)) {
      const allowed = oldApp?.byFile[file]?.[rule] ?? 0;
      if (count > allowed) {
        increases.push(`${file} · ${rule}: ${allowed} → ${count}`);
      }
    }
  }
}

const touchedBase =
  process.env["LINT_TOUCHED_BASE_REF"]?.trim() ||
  baseline.cleanTouchedFilesSince;
if (!touchedBase) {
  throw new Error(
    "quality/lint-baseline.json must define cleanTouchedFilesSince",
  );
}
const touchedFiles = new Set(
  runGit([
    "diff",
    "--name-only",
    touchedBase,
    "--",
    "apps/api",
    "apps/site",
  ])
    .split("\n")
    .filter(Boolean),
);
const touchedFileErrors: string[] = [];
for (const app of Object.values(current.apps)) {
  for (const [file, rules] of Object.entries(app.byFile)) {
    if (!touchedFiles.has(file)) continue;
    const count = Object.values(rules).reduce(
      (sum, ruleCount) => sum + ruleCount,
      0,
    );
    touchedFileErrors.push(`${file}: ${count}`);
  }
}

if (increases.length > 0 || touchedFileErrors.length > 0) {
  if (touchedFileErrors.length > 0) {
    console.error(
      `Touched files must have zero lint errors (base ${touchedBase}):`,
    );
    for (const error of touchedFileErrors) console.error(`  ${error}`);
  }
  if (increases.length === 0) process.exit(1);
  console.error("Lint debt increased:");
  for (const increase of increases) console.error(`  ${increase}`);
  console.error(
    "Fix the new errors. Only refresh the baseline for an intentional repository-wide debt change.",
  );
  process.exit(1);
}

console.log(
  `Lint ratchet passed: ${current.totalErrors} errors (baseline ${baseline.totalErrors}).`,
);
