const fs = require("node:fs");
const { syncBuiltinESMExports } = require("node:module");

const originalReadFileSync = fs.readFileSync;

/**
 * Source-contract tests compare repository text with LF-based literals. Git
 * may materialize those files with CRLF on Windows, so normalize decoded UTF-8
 * text while leaving buffers and every other encoding untouched.
 */
fs.readFileSync = function readFileSyncWithStableNewlines(path, options) {
  const value = originalReadFileSync.apply(this, arguments);
  const encoding =
    typeof options === "string"
      ? options
      : options && typeof options === "object"
        ? options.encoding
        : null;
  return encoding === "utf8" && typeof value === "string"
    ? value.replace(/\r\n?/gu, "\n")
    : value;
};

// Keep `import { readFileSync } from "node:fs"` aligned with the CommonJS
// export patched above when a dependency is loaded as ESM.
syncBuiltinESMExports();
