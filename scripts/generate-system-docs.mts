import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const checkOnly = process.argv.includes("--check");

const HTTP_METHODS = [
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
] as const;

type RouteEntry = {
  file: string;
  methods: string[];
  routePath: string;
};

type TableEntry = {
  exportName: string;
  tableName: string;
  columns: string[];
};

type OutboxEntry = {
  type: string;
  queuedBy: Set<string>;
  handlers: Set<string>;
};

function fingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex")
    .slice(0, 16);
}

function markdown(lines: readonly string[]): string {
  return `${lines.join("\n").trimEnd()}\n`;
}

function relativeFile(file: string): string {
  return path.relative(repositoryRoot, file).replaceAll("\\", "/");
}

async function walkFiles(
  directory: string,
  predicate: (file: string) => boolean,
): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(fullPath, predicate)));
    } else if (entry.isFile() && predicate(fullPath)) {
      files.push(fullPath);
    }
  }
  return files.sort((left, right) => left.localeCompare(right));
}

function routeMethods(source: string): string[] {
  const methods = new Set<string>();
  for (const method of HTTP_METHODS) {
    const direct = new RegExp(
      `export\\s+(?:(?:async\\s+)?function|const)\\s+${method}\\b`,
      "u",
    );
    if (direct.test(source)) methods.add(method);
  }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/gsu)) {
    for (const item of (match[1] ?? "").split(",")) {
      const exportedName = item
        .trim()
        .split(/\s+as\s+/u)
        .at(-1)
        ?.trim();
      if (
        HTTP_METHODS.includes(exportedName as (typeof HTTP_METHODS)[number])
      ) {
        methods.add(exportedName!);
      }
    }
  }
  return HTTP_METHODS.filter((method) => methods.has(method));
}

function nextRoutePath(file: string, appRoot: string): string {
  const directory = path.dirname(path.relative(appRoot, file));
  const segments = directory
    .split(path.sep)
    .filter(Boolean)
    .filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
    .filter((segment) => !segment.startsWith("@"));
  return `/${segments.join("/")}`.replace(/\/$/u, "") || "/";
}

async function collectRoutes(appRoot: string): Promise<RouteEntry[]> {
  const routeFiles = await walkFiles(
    appRoot,
    (file) =>
      path.basename(file) === "route.ts" || path.basename(file) === "route.js",
  );
  return Promise.all(
    routeFiles.map(async (file) => {
      const source = await readFile(file, "utf8");
      return {
        file: relativeFile(file),
        methods: routeMethods(source),
        routePath: nextRoutePath(file, appRoot),
      };
    }),
  );
}

function routeIndex(title: string, entries: RouteEntry[]): string {
  const rows = entries.map(
    (entry) =>
      `| ${entry.methods.length > 0 ? entry.methods.join(", ") : "Unknown"} | \`${entry.routePath}\` | \`${entry.file}\` |`,
  );
  return markdown([
    `# API Route Index (${title})`,
    "",
    `Generated from source. Fingerprint: \`${fingerprint(entries)}\`.`,
    "",
    `Routes discovered: ${entries.length}`,
    "",
    "This index inventories exported HTTP handlers. It does not replace endpoint authentication, request-schema, response-schema, or side-effect documentation.",
    "",
    "| Method(s) | Path | Handler |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ]);
}

type NestingState = {
  braces: number;
  brackets: number;
  parentheses: number;
  blockComment: boolean;
  quote: "'" | '"' | "`" | null;
  escaped: boolean;
};

function advanceNesting(line: string, state: NestingState): void {
  let lineComment = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    const next = line[index + 1] ?? "";
    if (lineComment) break;
    if (state.blockComment) {
      if (character === "*" && next === "/") {
        state.blockComment = false;
        index += 1;
      }
      continue;
    }
    if (state.quote) {
      if (state.escaped) {
        state.escaped = false;
      } else if (character === "\\") {
        state.escaped = true;
      } else if (character === state.quote) {
        state.quote = null;
      }
      continue;
    }
    if (character === "/" && next === "/") {
      lineComment = true;
      continue;
    }
    if (character === "/" && next === "*") {
      state.blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      state.quote = character;
      continue;
    }
    if (character === "{") state.braces += 1;
    if (character === "}") state.braces -= 1;
    if (character === "[") state.brackets += 1;
    if (character === "]") state.brackets -= 1;
    if (character === "(") state.parentheses += 1;
    if (character === ")") state.parentheses -= 1;
  }
}

function matchingBrace(source: string, start: number): number | null {
  const state: NestingState = {
    braces: 0,
    brackets: 0,
    parentheses: 0,
    blockComment: false,
    quote: null,
    escaped: false,
  };
  for (let index = start; index < source.length; index += 1) {
    const character = source[index]!;
    advanceNesting(character, state);
    if (index > start && state.braces === 0) return index;
  }
  return null;
}

function topLevelObjectKeys(source: string): string[] {
  const keys: string[] = [];
  const state: NestingState = {
    braces: 0,
    brackets: 0,
    parentheses: 0,
    blockComment: false,
    quote: null,
    escaped: false,
  };
  for (const line of source.split(/\r?\n/u)) {
    if (
      state.braces === 0 &&
      state.brackets === 0 &&
      state.parentheses === 0 &&
      !state.blockComment &&
      !state.quote
    ) {
      const match = line.match(
        /^\s*(?:["']([^"']+)["']|([A-Za-z_$][\w$]*))\s*:/u,
      );
      const key = match?.[1] ?? match?.[2];
      if (key) keys.push(key);
    }
    advanceNesting(line, state);
  }
  return [...new Set(keys)];
}

function collectTables(schemaSource: string): TableEntry[] {
  const tables: TableEntry[] = [];
  const pattern =
    /export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*pgTable\s*\(\s*["'`]([^"'`]+)["'`]/gu;
  for (const match of schemaSource.matchAll(pattern)) {
    const matchEnd = (match.index ?? 0) + match[0].length;
    const openingBrace = schemaSource.indexOf("{", matchEnd);
    if (openingBrace < 0) continue;
    const closingBrace = matchingBrace(schemaSource, openingBrace);
    if (closingBrace == null) continue;
    tables.push({
      exportName: match[1]!,
      tableName: match[2]!,
      columns: topLevelObjectKeys(
        schemaSource.slice(openingBrace + 1, closingBrace),
      ),
    });
  }
  return tables.sort((left, right) =>
    left.tableName.localeCompare(right.tableName),
  );
}

function dataDictionaryIndex(entries: TableEntry[]): string {
  const sections = entries.flatMap((entry) => [
    `## ${entry.tableName}`,
    "",
    `Schema export: \`${entry.exportName}\``,
    "",
    `Columns (${entry.columns.length}):`,
    "",
    ...(entry.columns.length > 0
      ? entry.columns.map((column) => `- \`${column}\``)
      : ["- No inline columns detected; inspect the schema export directly."]),
    "",
  ]);
  return markdown([
    "# Data Dictionary (Generated Columns)",
    "",
    `Generated from \`apps/api/src/db/schema.ts\`. Fingerprint: \`${fingerprint(entries)}\`.`,
    "",
    `Parsed tables: ${entries.length}`,
    "",
    "This is a structural inventory, not a relationship or data-retention specification. Use `DATA_DICTIONARY.md` for curated domain guidance and verify both against schema and migrations before operational changes.",
    "",
    ...sections,
  ]);
}

function eventLiteral(value: string): string | null {
  const trimmed = value.trim();
  const literal = trimmed.match(/^["'`]([A-Za-z0-9_.:-]+)["'`]$/u)?.[1];
  return literal?.includes(".") ? literal : null;
}

async function collectOutboxEntries(): Promise<OutboxEntry[]> {
  const roots = [
    path.join(repositoryRoot, "apps", "api", "app"),
    path.join(repositoryRoot, "apps", "api", "src"),
    path.join(repositoryRoot, "scripts"),
  ];
  const files = (
    await Promise.all(
      roots.map((root) =>
        walkFiles(
          root,
          (file) =>
            /\.(?:ts|tsx|mts|mjs)$/u.test(file) &&
            !file.includes(`${path.sep}__tests__${path.sep}`) &&
            !/\.(?:test|spec)\.[^.]+$/u.test(file),
        ),
      ),
    )
  ).flat();
  const sources = await Promise.all(
    files.map(async (file) => ({ file, source: await readFile(file, "utf8") })),
  );
  const constants = new Map<string, string>();
  for (const { source } of sources) {
    for (const match of source.matchAll(
      /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*=\s*(["'`][A-Za-z0-9_.:-]+["'`])/gu,
    )) {
      const value = eventLiteral(match[2]!);
      if (value) constants.set(match[1]!, value);
    }
  }
  const entries = new Map<string, OutboxEntry>();
  const getEntry = (type: string): OutboxEntry => {
    const existing = entries.get(type);
    if (existing) return existing;
    const created = {
      type,
      queuedBy: new Set<string>(),
      handlers: new Set<string>(),
    };
    entries.set(type, created);
    return created;
  };
  for (const { file, source } of sources) {
    const lines = source.split(/\r?\n/u);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(/\btype\s*:\s*([^,}\s]+)/gu)) {
        const expression = match[1]!;
        const type =
          eventLiteral(expression) ?? constants.get(expression) ?? null;
        if (type)
          getEntry(type).queuedBy.add(`${relativeFile(file)}:${index + 1}`);
      }
      const caseMatch = line.match(/\bcase\s+([^:]+):/u);
      if (caseMatch) {
        const expression = caseMatch[1]!.trim();
        const type =
          eventLiteral(expression) ?? constants.get(expression) ?? null;
        if (type)
          getEntry(type).handlers.add(`${relativeFile(file)}:${index + 1}`);
      }
    });
  }
  return [...entries.values()].sort((left, right) =>
    left.type.localeCompare(right.type),
  );
}

function outboxIndex(entries: OutboxEntry[]): string {
  const cell = (values: Set<string>): string =>
    [...values]
      .sort((left, right) => left.localeCompare(right))
      .slice(0, 3)
      .map((value) => `\`${value}\``)
      .join("<br>") || "Not found by literal scan";
  return markdown([
    "# Outbox Event Index",
    "",
    `Generated from production TypeScript sources. Fingerprint: \`${fingerprint(
      entries.map((entry) => ({
        type: entry.type,
        queuedBy: [...entry.queuedBy].sort(),
        handlers: [...entry.handlers].sort(),
      })),
    )}\`.`,
    "",
    `Literal event types discovered: ${entries.length}`,
    "",
    "Outbox events are durable asynchronous jobs stored in `outbox_events`. This index reports literal queue sites and switch handlers; computed event names and delegated workers still require curated review.",
    "",
    "| Type | Queued by (up to 3 examples) | Handler candidates |",
    "| --- | --- | --- |",
    ...entries.map(
      (entry) =>
        `| \`${entry.type}\` | ${cell(entry.queuedBy)} | ${cell(entry.handlers)} |`,
    ),
    "",
  ]);
}

const apiRoot = path.join(repositoryRoot, "apps", "api", "app");
const siteRoot = path.join(repositoryRoot, "apps", "site", "src", "app");
const schemaFile = path.join(
  repositoryRoot,
  "apps",
  "api",
  "src",
  "db",
  "schema.ts",
);

const [apiRoutes, siteRoutes, schemaSource, outboxEntries] = await Promise.all([
  collectRoutes(apiRoot),
  collectRoutes(siteRoot),
  readFile(schemaFile, "utf8"),
  collectOutboxEntries(),
]);

const outputs = new Map<string, string>([
  [
    path.join(repositoryRoot, "docs", "system", "API_ROUTE_INDEX_API.md"),
    routeIndex("apps/api", apiRoutes),
  ],
  [
    path.join(repositoryRoot, "docs", "system", "API_ROUTE_INDEX_SITE.md"),
    routeIndex("apps/site", siteRoutes),
  ],
  [
    path.join(repositoryRoot, "docs", "system", "DATA_DICTIONARY_COLUMNS.md"),
    dataDictionaryIndex(collectTables(schemaSource)),
  ],
  [
    path.join(repositoryRoot, "docs", "system", "OUTBOX_EVENT_INDEX.md"),
    outboxIndex(outboxEntries),
  ],
]);

let drift = false;
for (const [file, expected] of outputs) {
  if (checkOnly) {
    const current = await readFile(file, "utf8").catch(() => "");
    if (current !== expected) {
      drift = true;
      process.stderr.write(
        `Generated documentation is stale: ${relativeFile(file)}\n`,
      );
    }
  } else {
    await writeFile(file, expected, "utf8");
    process.stdout.write(`Updated ${relativeFile(file)}\n`);
  }
}

if (drift) {
  process.stderr.write("Run `pnpm docs:generate` and commit the results.\n");
  process.exitCode = 1;
}
