const { existsSync, readdirSync, readFileSync, statSync } = require("node:fs");
const { dirname, extname, join, relative, resolve } = require("node:path");

const testsRoot = join(__dirname, "src", "__tests__");
const nativeEsmSyntax = /\b(?:import\.meta|unstable_mockModule)\b/u;
const nativeEsmDependencies =
  /(?:from\s*|import\s*\(\s*)["']@react-pdf\/renderer(?:["'/])/u;
const moduleExtensions = [".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs"];
const moduleModeCache = new Map();

function testFiles(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return testFiles(path);
    return /\.(?:test|spec)\.tsx?$/u.test(entry.name) ? [path] : [];
  });
}

function resolveLocalModule(fromFile, specifier) {
  let candidate;
  if (specifier.startsWith("@/")) {
    candidate = resolve(__dirname, "src", specifier.slice(2));
  } else if (specifier.startsWith(".")) {
    candidate = resolve(dirname(fromFile), specifier);
  } else {
    return null;
  }
  const candidates = extname(candidate)
    ? [candidate]
    : [
        ...moduleExtensions.map((extension) => `${candidate}${extension}`),
        ...moduleExtensions.map((extension) =>
          join(candidate, `index${extension}`),
        ),
      ];
  return candidates.find((path) => existsSync(path) && statSync(path).isFile());
}

function localDependencies(file, source) {
  const specifiers = new Set();
  for (const pattern of [
    /\bfrom\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\bimport\s*["']([^"']+)["']/gu,
  ]) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers]
    .map((specifier) => resolveLocalModule(file, specifier))
    .filter(Boolean);
}

function requiresNativeEsm(file, visiting = new Set()) {
  const cached = moduleModeCache.get(file);
  if (cached !== undefined) return cached;
  if (visiting.has(file)) return false;
  visiting.add(file);
  const source = readFileSync(file, "utf8");
  const required =
    nativeEsmSyntax.test(source) ||
    nativeEsmDependencies.test(source) ||
    localDependencies(file, source).some((dependency) =>
      requiresNativeEsm(dependency, visiting),
    );
  visiting.delete(file);
  moduleModeCache.set(file, required);
  return required;
}

function testMatchFor(moduleMode) {
  return testFiles(testsRoot)
    .filter((file) => {
      const nativeEsm = requiresNativeEsm(file);
      return moduleMode === "esm" ? nativeEsm : !nativeEsm;
    })
    .map(
      (file) => `<rootDir>/${relative(__dirname, file).replaceAll("\\", "/")}`,
    );
}

module.exports = { testMatchFor };
