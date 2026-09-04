import { promises as fs } from "node:fs";
import path from "node:path";

type Mapping = {
  src: string;
  dest: string;
};

const copies: Mapping[] = [
  { src: ".env.e2e", dest: ".env" },
  { src: "apps/site/.env.e2e.local", dest: "apps/site/.env.local" },
  { src: "apps/api/.env.e2e.local", dest: "apps/api/.env.local" },
];

const e2eEnvOverrides: Record<string, string> = {
  QUOTE_DELIVERY_ADDRESS_HMAC_KEY_BASE64:
    "c3RvbmVnYXRlLXF1b3RlLXYyLWhtYWMta2V5LTAwMSE=",
  QUOTE_DELIVERY_ENCRYPTION_KEY_ID: "e2e-primary",
  QUOTE_DELIVERY_ENCRYPTION_KEYS_JSON:
    '{"e2e-primary":"c3RvbmVnYXRlLXF1b3RlLXYyLWUyZS1rZXktMDAwMSE="}',
  QUOTE_RATE_LIMIT_HMAC_SECRET: "stonegate-quote-v2-e2e-rate-limit-secret-only",
  QUOTE_PUBLIC_PROXY_SHARED_SECRET:
    "stonegate-quote-v2-e2e-proxy-shared-secret-only",
  QUOTE_PUBLIC_TRUSTED_PROXY_HOPS: "1",
  QUOTE_V2_STAFF_ENABLED: "true",
  QUOTE_V2_SENDER_ENABLED: "true",
  QUOTE_V2_PUBLIC_ENABLED: "true",
  QUOTE_V2_MUTATIONS_ENABLED: "true",
  QUOTE_V2_DEPOSITS_ENABLED: "true",
  QUOTE_V2_BOOKING_ENABLED: "true",
};

async function copy(mapping: Mapping) {
  const cwd = process.cwd();
  const sourcePath = path.resolve(cwd, mapping.src);
  const destPath = path.resolve(cwd, mapping.dest);

  try {
    await fs.access(sourcePath);
  } catch {
    throw new Error(`Missing source env file: ${mapping.src}`);
  }

  await fs.copyFile(sourcePath, destPath);
  console.info(`[e2e:env] ${mapping.src} -> ${mapping.dest}`);
}

async function upsertEnvValues(
  filename: string,
  values: Record<string, string>,
): Promise<void> {
  const target = path.resolve(process.cwd(), filename);
  let contents = await fs.readFile(target, "utf8");
  for (const [name, value] of Object.entries(values)) {
    const line = `${name}=${value}`;
    const pattern = new RegExp(`^${name}=.*$`, "mu");
    contents = pattern.test(contents)
      ? contents.replace(pattern, line)
      : `${contents.replace(/\s*$/u, "")}\n${line}\n`;
  }
  await fs.writeFile(target, contents, "utf8");
}

async function main() {
  await Promise.all(copies.map(copy));
  await Promise.all([
    upsertEnvValues(".env", e2eEnvOverrides),
    upsertEnvValues("apps/site/.env.local", e2eEnvOverrides),
    upsertEnvValues("apps/api/.env.local", e2eEnvOverrides),
  ]);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
