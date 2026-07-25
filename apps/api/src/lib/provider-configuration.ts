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

export function inspectSquareConfiguration(
  environment: Environment = process.env,
): ProviderConfigurationInspection {
  const required = [
    "SQUARE_APPLICATION_ID",
    "SQUARE_ACCESS_TOKEN",
    "SQUARE_LOCATION_ID",
    "SQUARE_POS_CALLBACK_URL",
    "SQUARE_POS_FALLBACK_URL",
    "SQUARE_POS_STATE_SECRET",
    "SQUARE_WEBHOOK_SIGNATURE_KEY",
    "SQUARE_WEBHOOK_NOTIFICATION_URL",
  ] as const;
  const missing = required.filter((key) => !hasValue(environment, key));
  const stateSecret = environment["SQUARE_POS_STATE_SECRET"]?.trim() ?? "";
  const invalid =
    stateSecret && Buffer.byteLength(stateSecret, "utf8") < 32
      ? ["SQUARE_POS_STATE_SECRET must contain at least 32 bytes"]
      : [];
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
  return {
    configured: missing.length === 0,
    missing,
    invalid: [],
  };
}
