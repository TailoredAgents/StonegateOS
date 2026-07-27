import { getEnvVar, getOptionalEnvVar } from "./env";

type DependencyStatus = {
  ok: boolean;
  reason?: string;
};

const controllerTimeoutMs = 10_000;
const probeAttempts = 3;
const retryDelayMs = 500;

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function probeOnce(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), controllerTimeoutMs);
  try {
    const response = await fetch(url, {
      cache: "no-store",
      signal: controller.signal,
    });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function probe(url: string): Promise<boolean> {
  for (let attempt = 1; attempt <= probeAttempts; attempt += 1) {
    if (await probeOnce(url)) {
      return true;
    }
    if (attempt < probeAttempts) {
      await delay(retryDelayMs * attempt);
    }
  }

  return false;
}

export async function checkDependencies(): Promise<DependencyStatus> {
  const siteBase = getEnvVar("NEXT_PUBLIC_SITE_URL", "http://localhost:3000");
  const apiBase = getEnvVar("API_BASE_URL", "http://localhost:3001");
  const mailhogBase = (
    getOptionalEnvVar("MAILHOG_UI", "http://localhost:8025") ??
    "http://localhost:8025"
  ).replace(/\/$/, "");
  const twilioBase = (
    getOptionalEnvVar("TWILIO_API_BASE_URL", "http://localhost:4010") ??
    "http://localhost:4010"
  ).replace(/\/$/, "");

  const healthChecks = [
    { name: "site", url: new URL("/api/healthz", siteBase).toString() },
    { name: "api", url: new URL("/api/healthz", apiBase).toString() },
    { name: "mailhog", url: `${mailhogBase}/api/v2/messages` },
    { name: "twilio-mock", url: `${twilioBase}/messages` },
  ];

  const results = await Promise.all(
    healthChecks.map(async ({ name, url }) => ({
      name,
      ok: await probe(url),
    })),
  );

  const failed = results.filter((item) => !item.ok).map((item) => item.name);
  if (failed.length) {
    return { ok: false, reason: `Missing dependencies: ${failed.join(", ")}` };
  }

  return { ok: true };
}
