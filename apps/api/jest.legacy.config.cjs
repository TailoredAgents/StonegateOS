const base = require("./jest.config.cjs");
const { testMatchFor } = require("./jest.test-partition.cjs");

/**
 * Compatibility runner for the API tests that still use CommonJS Jest mock
 * hoisting. Native-ESM tests run through jest.config.cjs instead.
 *
 * @type {import('jest').Config}
 */
module.exports = {
  ...base,
  preset: "ts-jest",
  testMatch: testMatchFor("legacy"),
  extensionsToTreatAsEsm: [],
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        useESM: false,
        tsconfig: "<rootDir>/tsconfig.jest.json",
      },
    ],
  },
  setupFilesAfterEnv: ["<rootDir>/src/__tests__/jest-source-compat.cjs"],
};
