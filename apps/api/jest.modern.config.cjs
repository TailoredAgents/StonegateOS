const base = require("./jest.config.cjs");
const { testMatchFor } = require("./jest.test-partition.cjs");

/** @type {import('jest').Config} */
module.exports = {
  ...base,
  testMatch: testMatchFor("esm"),
};
