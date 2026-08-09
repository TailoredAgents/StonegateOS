import {
  getSquareApiBaseUrl,
  isControlledProviderTestRuntime,
} from "@myst-os/sdk";
import { getEmailProviderConfiguration } from "@/lib/email-provider";

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

function isControlledProductionAudit(environment: Environment): boolean {
  if (!isProduction(environment)) return false;
  try {
    return isControlledProviderTestRuntime(environment);
  } catch {
    return false;
  }
}

function providerTestRuntimeIssue(environment: Environment): string | null {
  try {
    isControlledProviderTestRuntime(environment);
    return null;
  } catch (error) {
    return error instanceof Error
      ? error.message
      : "Provider-test runtime sentinels are invalid";
  }
}

function isTruthy(value: string | undefined): boolean {
  return ["1", "true", "yes", "on"].includes(value?.trim().toLowerCase() ?? "");
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/gu, "");
  if (
    normalized === "localhost" ||
    normalized === "::1" ||
    normalized === "localstack" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".localstack")
  ) {
    return true;
  }
  const parts = normalized.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every(
      (part) => /^\d{1,3}$/u.test(part) && Number.parseInt(part, 10) <= 255,
    )
  );
}

function inspectProviderUrl(input: {
  environment: Environment;
  key: string;
  expectedPath?: string;
}): string | null {
  const value = input.environment[input.key]?.trim();
  if (!value) return null;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `${input.key} must be a valid URL`;
  }

  if (!url.hostname || url.username || url.password || url.search || url.hash) {
    return `${input.key} must be an origin URL without credentials, query parameters, or a fragment`;
  }

  const production = isProduction(input.environment);
  const localHostname = isLocalHostname(url.hostname);
  const controlledProductionAuditMode = isControlledProductionAudit(
    input.environment,
  );
  if (controlledProductionAuditMode && !localHostname) {
    return `${input.key} must target a local service during a controlled production-build audit`;
  }
  const localHttp =
    url.protocol === "http:" &&
    localHostname &&
    (!production || controlledProductionAuditMode);
  if (url.protocol !== "https:" && !localHttp) {
    return `${input.key} must use HTTPS${
      production
        ? " in production"
        : " unless it targets a local development service"
    }`;
  }
  if (production && localHostname && !controlledProductionAuditMode) {
    return `${input.key} cannot target a local host in production`;
  }
  if (input.expectedPath && url.pathname !== input.expectedPath) {
    return `${input.key} must use path ${input.expectedPath}`;
  }
  return null;
}

export function inspectSquareConfiguration(
  environment: Environment = process.env,
): ProviderConfigurationInspection {
  const production = isProduction(environment);
  const controlledProductionAudit = isControlledProductionAudit(environment);
  const required: string[] = [
    "SQUARE_APPLICATION_ID",
    "SQUARE_ACCESS_TOKEN",
    "SQUARE_LOCATION_ID",
    "SQUARE_POS_CALLBACK_URL",
    "SQUARE_POS_FALLBACK_URL",
    "SQUARE_POS_STATE_SECRET",
    "SQUARE_WEBHOOK_SIGNATURE_KEY",
    "SQUARE_WEBHOOK_NOTIFICATION_URL",
    ...(production ? ["SQUARE_ENVIRONMENT"] : []),
  ];
  const missing = required.filter((key) => !hasValue(environment, key));
  const stateSecret = environment["SQUARE_POS_STATE_SECRET"]?.trim() ?? "";
  const invalid: string[] = [];
  if (stateSecret && Buffer.byteLength(stateSecret, "utf8") < 32) {
    invalid.push("SQUARE_POS_STATE_SECRET must contain at least 32 bytes");
  }
  try {
    getSquareApiBaseUrl(environment);
  } catch (error) {
    invalid.push(
      error instanceof Error ? error.message : "SQUARE_API_BASE_URL is invalid",
    );
  }

  const squareEnvironment =
    environment["SQUARE_ENVIRONMENT"]?.trim().toLowerCase() ?? "";
  if (
    production &&
    controlledProductionAudit &&
    squareEnvironment &&
    squareEnvironment !== "sandbox"
  ) {
    invalid.push(
      "SQUARE_ENVIRONMENT must be sandbox during a controlled production-build audit",
    );
  } else if (
    production &&
    !controlledProductionAudit &&
    squareEnvironment &&
    squareEnvironment !== "production"
  ) {
    invalid.push(
      "SQUARE_ENVIRONMENT must be production when NODE_ENV=production",
    );
  } else if (
    squareEnvironment &&
    squareEnvironment !== "production" &&
    squareEnvironment !== "sandbox"
  ) {
    invalid.push("SQUARE_ENVIRONMENT must be production or sandbox");
  }

  const urlRequirements = [
    {
      key: "SQUARE_POS_CALLBACK_URL",
      expectedPath: "/mobile/payment-return",
    },
    {
      key: "SQUARE_POS_FALLBACK_URL",
      expectedPath: "/mobile/square-setup",
    },
    {
      key: "SQUARE_WEBHOOK_NOTIFICATION_URL",
      expectedPath: "/api/webhooks/square",
    },
  ] as const;
  for (const requirement of urlRequirements) {
    const issue = inspectProviderUrl({
      environment,
      key: requirement.key,
      expectedPath: requirement.expectedPath,
    });
    if (issue) invalid.push(issue);
  }

  return {
    configured: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
  };
}

export function inspectEmailProviderConfiguration(
  environment: Environment = process.env,
): ProviderConfigurationInspection {
  const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_FROM"] as const;
  const missing = required.filter((key) => !hasValue(environment, key));
  const invalid: string[] = [];
  try {
    getEmailProviderConfiguration(environment);
  } catch (error) {
    invalid.push(
      error instanceof Error ? error.message : "SMTP configuration is invalid",
    );
  }
  return {
    configured: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
  };
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
  const controlledProductionAudit = isControlledProductionAudit(environment);
  const runtimeIssue = providerTestRuntimeIssue(environment);
  if (runtimeIssue) invalid.push(runtimeIssue);
  const configuredEndpoint = firstValue(
    environment,
    "MEDIA_OBJECT_ENDPOINT",
    "R2_ENDPOINT",
    "LOCALSTACK_ENDPOINT",
  );
  const accountId = environment["R2_ACCOUNT_ID"]?.trim();
  const endpoint =
    configuredEndpoint ??
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : null);

  if (
    production &&
    !controlledProductionAudit &&
    hasValue(environment, "LOCALSTACK_ENDPOINT")
  ) {
    invalid.push("LOCALSTACK_ENDPOINT cannot be used when NODE_ENV=production");
  }
  if (
    production &&
    !controlledProductionAudit &&
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
