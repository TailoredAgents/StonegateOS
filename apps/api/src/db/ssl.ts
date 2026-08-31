type DatabaseSslEnvironment = {
  NODE_ENV?: string;
  DATABASE_SSL?: string;
  DATABASE_SSL_CA?: string;
  DATABASE_SSL_CA_BASE64?: string;
  DATABASE_SSL_ALLOW_INSECURE?: string;
};

export type DatabaseSslOptions =
  | undefined
  | {
      rejectUnauthorized: boolean;
      ca?: string;
    };

function enabled(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(
    value?.trim().toLowerCase() ?? "",
  );
}

function connectionSslMode(connectionString: string): string | null {
  try {
    return new URL(connectionString).searchParams.get("sslmode")?.toLowerCase() ?? null;
  } catch {
    return null;
  }
}

function readCertificateAuthority(
  environment: DatabaseSslEnvironment,
): string | undefined {
  const plain = environment.DATABASE_SSL_CA?.trim();
  if (plain) return plain.replace(/\\n/gu, "\n");

  const encoded = environment.DATABASE_SSL_CA_BASE64?.trim();
  if (!encoded) return undefined;
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8").trim();
    return decoded.length ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Render injects a private-network database URL for co-located services, which
 * does not require TLS. External URLs opt into TLS through sslmode or the
 * explicit flag. Production TLS always verifies the server identity; the only
 * insecure escape hatch is intentionally restricted to local development.
 */
export function resolveDatabaseSslOptions(
  connectionString: string,
  environment: DatabaseSslEnvironment = process.env,
): DatabaseSslOptions {
  const sslMode = connectionSslMode(connectionString);
  const shouldUseSsl =
    enabled(environment.DATABASE_SSL) ||
    (sslMode !== null && sslMode !== "disable" && sslMode !== "allow");
  if (!shouldUseSsl) return undefined;

  const allowInsecure = enabled(environment.DATABASE_SSL_ALLOW_INSECURE);
  if (allowInsecure && environment.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_SSL_ALLOW_INSECURE cannot be enabled in production",
    );
  }

  const ca = readCertificateAuthority(environment);
  return {
    rejectUnauthorized: !allowInsecure,
    ...(ca ? { ca } : {}),
  };
}
