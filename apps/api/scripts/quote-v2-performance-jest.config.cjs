const path = require("node:path");
const base = require("../jest.config.cjs");

module.exports = {
  ...base,
  rootDir: path.resolve(__dirname, ".."),
  testMatch: [
    "<rootDir>/src/__benchmarks__/quote-v2-pdf-performance.benchmark.ts",
  ],
};
