const { spawnSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { dirname, resolve } = require("node:path");

const requireFromHere = createRequire(__filename);
const jestPackage = requireFromHere.resolve("jest/package.json");
const jestCli = resolve(dirname(jestPackage), "bin", "jest.js");
const forwardedArguments = process.argv.slice(2);
const partitions = [
  { label: "legacy CommonJS", config: "jest.legacy.config.cjs", esm: false },
  { label: "native ESM", config: "jest.modern.config.cjs", esm: true },
];

let failed = false;
for (const partition of partitions) {
  process.stdout.write(`\nAPI Jest partition: ${partition.label}\n`);
  const nodeOptions = [
    process.env.NODE_OPTIONS ?? "",
    partition.esm ? "--experimental-vm-modules" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const result = spawnSync(
    process.execPath,
    [
      jestCli,
      "--config",
      partition.config,
      "--passWithNoTests",
      ...forwardedArguments,
    ],
    {
      cwd: resolve(__dirname, ".."),
      env: { ...process.env, NODE_OPTIONS: nodeOptions },
      stdio: "inherit",
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) failed = true;
}

process.exitCode = failed ? 1 : 0;
