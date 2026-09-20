import Module from "node:module";
import path from "node:path";

type ModuleResolver = (
  request: string,
  parent: unknown,
  isMain: boolean,
  options: unknown,
) => string;

/** Shared by the production worker and its isolated runtime verification. */
export function registerApiAliases() {
  const moduleInternals = Module as unknown as {
    _resolveFilename: ModuleResolver;
  };
  const originalResolve = moduleInternals._resolveFilename;
  moduleInternals._resolveFilename = function (
    request: string,
    parent: unknown,
    isMain: boolean,
    options: unknown,
  ) {
    if (request.startsWith("@/")) {
      const absolute = path.resolve("apps/api/src", request.slice(2));
      return originalResolve.call(this, absolute, parent, isMain, options);
    }
    return originalResolve.call(this, request, parent, isMain, options);
  };
}
