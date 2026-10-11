import { jest as jestObject } from "@jest/globals";
import { fileURLToPath } from "node:url";
import "./jest-source-compat.cjs";

/**
 * Keep legacy API tests running while Jest executes the suite as native ESM.
 *
 * All current tests that still reference CommonJS `__dirname` live beside this
 * setup file, so this directory matches the value those tests historically
 * received. New tests should import `jest` from `@jest/globals` and derive
 * paths from `import.meta.url` directly.
 */
Object.defineProperty(globalThis, "jest", {
  configurable: true,
  value: jestObject,
});

Object.defineProperty(globalThis, "__dirname", {
  configurable: true,
  value: fileURLToPath(new URL(".", import.meta.url)),
});
