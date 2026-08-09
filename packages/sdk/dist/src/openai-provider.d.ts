export type OpenAiProviderEnvironment = Readonly<Record<string, string | undefined>>;
export type OpenAiApiEndpoint = "responses" | "audio/transcriptions";
export declare const DEFAULT_OPENAI_API_BASE_URL = "https://api.openai.com/v1";
export declare function getOpenAiApiBaseUrl(environment: OpenAiProviderEnvironment): URL;
export declare function resolveOpenAiApiEndpoint(endpoint: OpenAiApiEndpoint, environment: OpenAiProviderEnvironment): string;
//# sourceMappingURL=openai-provider.d.ts.map