import { promises as fs } from "node:fs";
import path from "node:path";
import { getEnvVar } from "./env";
import { ADMIN_SESSION_COOKIE, adminSessionCookieOptions } from "../../../apps/site/src/lib/admin-session";

const storageDir = path.resolve(process.cwd(), "tests/e2e/storage");

type StorageState = {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite?: "Strict" | "Lax" | "None";
  }>;
  origins: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
    sessionStorage?: Array<{ name: string; value: string }>;
  }>;
};

export async function ensureStorageState(filename: string, state?: StorageState): Promise<void> {
  await fs.mkdir(storageDir, { recursive: true });
  const filePath = path.resolve(process.cwd(), filename);

  const defaultState: StorageState =
    state ??
    ({
      cookies: [],
      origins: []
    } as StorageState);

  await fs.writeFile(filePath, JSON.stringify(defaultState, null, 2));
}

export async function bootstrapVisitorStorage(filename: string): Promise<void> {
  await ensureStorageState(filename);
}

export async function bootstrapAdminStorage(filename: string): Promise<void> {
  const adminKey = getEnvVar("ADMIN_API_KEY");
  const siteBase = getEnvVar("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");

  try {
    const storageState = await bootstrapViaSessionEndpoint(siteBase, adminKey);
    await ensureStorageState(filename, storageState);
    return;
  } catch (error) {
    if (error instanceof AdminSessionEndpointMissingError) {
      console.warn(
        `[e2e] ${error.message}; synthesizing admin session cookie directly for ${siteBase}.`
      );
      const storageState = buildSyntheticAdminStorage(adminKey, siteBase);
      await ensureStorageState(filename, storageState);
      return;
    }
    throw error;
  }
}

async function bootstrapViaSessionEndpoint(siteBase: string, adminKey: string): Promise<StorageState> {
  const response = await fetch(new URL("/api/admin/session", siteBase).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ key: adminKey }),
    redirect: "manual"
  });

  if (response.status === 404 || response.status === 405) {
    throw new AdminSessionEndpointMissingError(response.status);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Failed to bootstrap admin session (${response.status}): ${text}`);
  }

  const cookies = extractSetCookies(response);
  if (!cookies.length) {
    throw new Error("Admin session endpoint did not return Set-Cookie header");
  }

  return buildStorageStateFromCookies(cookies, siteBase);
}

function buildSyntheticAdminStorage(adminKey: string, siteBase: string): StorageState {
  const cookieOptions = adminSessionCookieOptions();
  const now = Math.floor(Date.now() / 1000);
  const expires = cookieOptions.maxAge ? now + cookieOptions.maxAge : now + 60 * 60 * 8;
  const url = new URL(siteBase);

  return {
    cookies: [
      {
        name: ADMIN_SESSION_COOKIE,
        value: adminKey,
        domain: url.hostname,
        path: cookieOptions.path ?? "/",
        expires,
        httpOnly: cookieOptions.httpOnly ?? true,
        secure: cookieOptions.secure ?? url.protocol === "https:",
        sameSite: parseSameSite(cookieOptions.sameSite) ?? "Lax"
      }
    ],
    origins: []
  };
}

function buildStorageStateFromCookies(cookies: CookieParseResult[], siteBase: string): StorageState {
  const url = new URL(siteBase);

  return {
    cookies: cookies.map((cookie) => ({
      name: cookie.name,
      value: cookie.value,
      domain:
        typeof cookie.attributes.domain === "string"
          ? cookie.attributes.domain
          : url.hostname,
      path:
        typeof cookie.attributes.path === "string"
          ? cookie.attributes.path
          : "/",
      expires: cookie.attributes.expires
        ? Math.floor(
            new Date(
              typeof cookie.attributes.expires === "string"
                ? cookie.attributes.expires
                : Date.now(),
            ).getTime() / 1000,
          )
        : Math.floor(Date.now() / 1000) + 60 * 60 * 8,
      httpOnly: "httponly" in cookie.attributes,
      secure: "secure" in cookie.attributes,
      sameSite: parseSameSite(cookie.attributes.samesite)
    })),
    origins: []
  };
}

type CookieParseResult = {
  name: string;
  value: string;
  attributes: Record<string, string | boolean>;
};

function extractSetCookies(response: Response): CookieParseResult[] {
  const headers = (response.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  const fallbackHeader = response.headers.get("set-cookie");
  const allHeaders = headers.length ? headers : fallbackHeader ? [fallbackHeader] : [];
  return allHeaders.map(parseSetCookie).filter((cookie): cookie is CookieParseResult => Boolean(cookie));
}

function parseSetCookie(header: string | undefined): CookieParseResult | undefined {
  if (!header) {
    return undefined;
  }
  const parts = header.split(";");
  const [nameValue, ...attributePairs] = parts;
  const [name, ...valueParts] = nameValue.split("=");
  if (!name) {
    return undefined;
  }
  const value = valueParts.join("=").trim();
  const attributes: Record<string, string | boolean> = {};
  attributePairs.forEach((pair) => {
    const [attrName, ...attrValue] = pair.trim().split("=");
    if (!attrName) {
      return;
    }
    if (attrValue.length === 0) {
      attributes[attrName.toLowerCase()] = true;
    } else {
      attributes[attrName.toLowerCase()] = attrValue.join("=");
    }
  });

  return {
    name: name.trim(),
    value,
    attributes
  };
}

function parseSameSite(value: string | boolean | undefined): "Strict" | "Lax" | "None" | undefined {
  if (!value || typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "strict") {
    return "Strict";
  }
  if (normalized === "none") {
    return "None";
  }
  if (normalized === "lax") {
    return "Lax";
  }
  return undefined;
}

class AdminSessionEndpointMissingError extends Error {
  status: number;

  constructor(status: number) {
    super(`/api/admin/session returned ${status}`);
    this.name = "AdminSessionEndpointMissingError";
    this.status = status;
  }
}
