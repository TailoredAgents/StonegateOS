type Environment = Readonly<Record<string, string | undefined>>;

export type ProviderConfigurationInspection = {
  configured: boolean;
  missing: string[];
  invalid: string[];
};

export function isProviderConfigurationBlocking(input: {
  enabled: boolean;
  configuration: ProviderConfigurationInspection;
}): boolean {
  return input.enabled && !input.configuration.configured;
}

function hasValue(
  environment: Environment,
  ...keys: readonly string[]
): boolean {
  return keys.some((key) => Boolean(environment[key]?.trim()));
}

function firstValue(
  environment: Environment,
  ...keys: readonly string[]
): string | null {
  for (const key of keys) {
    const value = environment[key]?.trim();
    if (value) return value;
  }
  return null;
}

function isProduction(environment: Environment): boolean {
  return environment["NODE_ENV"]?.trim().toLowerCase() === "production";
}

function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(
    value?.trim().toLowerCase() ?? "",
  );
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "localstack" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".localstack")
  );
}

function inspectProviderUrl(input: {
  environment: Environment;
  key: string;
}): string | null {
  const value = input.environment[input.key]?.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${input.key} must be a valid URL`;
  }

  const production = isProduction(input.environment);
  const localHttp =
    !production &&
    url.protocol === "http:" &&
    isLocalHostname(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    return `${input.key} must use HTTPS${
      production
        ? " in production"
        : " unless it targets a local development service"
    }`;
  }
  if (production && isLocalHostname(url.hostname)) {
    return `${input.key} cannot target a local host in production`;
  }
  if (
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return `${input.key} must be an origin URL without credentials, query parameters, or a fragment`;
  }
  return null;
}

export function inspectObjectStorageConfiguration(
  environment: Environment = process.env,
): ProviderConfigurationInspection {
  const requirements: Array<{
    label: string;
    keys: readonly string[];
  }> = [
    {
      label:
        "MEDIA_OBJECT_ENDPOINT (or R2_ENDPOINT, LOCALSTACK_ENDPOINT, R2_ACCOUNT_ID)",
      keys: [
        "MEDIA_OBJECT_ENDPOINT",
        "R2_ENDPOINT",
        "LOCALSTACK_ENDPOINT",
        "R2_ACCOUNT_ID",
      ],
    },
    {
      label: "MEDIA_OBJECT_BUCKET (or R2_BUCKET_NAME)",
      keys: ["MEDIA_OBJECT_BUCKET", "R2_BUCKET_NAME"],
    },
    {
      label:
        "MEDIA_OBJECT_ACCESS_KEY_ID (or R2_ACCESS_KEY_ID, AWS_ACCESS_KEY_ID)",
      keys: [
        "MEDIA_OBJECT_ACCESS_KEY_ID",
        "R2_ACCESS_KEY_ID",
        "AWS_ACCESS_KEY_ID",
      ],
    },
    {
      label:
        "MEDIA_OBJECT_SECRET_ACCESS_KEY (or R2_SECRET_ACCESS_KEY, AWS_SECRET_ACCESS_KEY)",
      keys: [
        "MEDIA_OBJECT_SECRET_ACCESS_KEY",
        "R2_SECRET_ACCESS_KEY",
        "AWS_SECRET_ACCESS_KEY",
      ],
    },
  ];
  const missing = requirements
    .filter((requirement) => !hasValue(environment, ...requirement.keys))
    .map((requirement) => requirement.label);
  const invalid: string[] = [];
  const production = isProduction(environment);
  const configuredEndpoint = firstValue(
    environment,
    "MEDIA_OBJECT_ENDPOINT",
    "R2_ENDPOINT",
    "LOCALSTACK_ENDPOINT",
  );
  const accountId = environment["R2_ACCOUNT_ID"]?.trim();
  const endpoint =
    configuredEndpoint ??
    (accountId
      ? `https://${accountId}.r2.cloudflarestorage.com`
      : null);

  if (production && hasValue(environment, "LOCALSTACK_ENDPOINT")) {
    invalid.push(
      "LOCALSTACK_ENDPOINT cannot be used when NODE_ENV=production",
    );
  }
  if (
    production &&
    isTruthy(environment["MEDIA_OBJECT_AUTO_CREATE_BUCKET"])
  ) {
    invalid.push(
      "MEDIA_OBJECT_AUTO_CREATE_BUCKET must be disabled in production",
    );
  }
  if (endpoint) {
    const endpointEnvironment: Environment = {
      ...environment,
      MEDIA_OBJECT_ENDPOINT: endpoint,
    };
    const issue = inspectProviderUrl({
      environment: endpointEnvironment,
      key: "MEDIA_OBJECT_ENDPOINT",
    });
    if (issue) invalid.push(issue);
  }

  return {
    configured: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
  };
}
