export type MetaProviderEnvironment = Readonly<Record<string, string | undefined>>;
export declare const DEFAULT_META_GRAPH_API_BASE_URL = "https://graph.facebook.com";
export declare const META_GRAPH_API_VERSION = "v24.0";
/**
 * Resolve and validate the one base URL used for every Meta Graph request.
 * Provider credentials belong in request parameters, never in this URL.
 */
export declare function getMetaGraphApiBaseUrl(environment: MetaProviderEnvironment): URL;
export declare function resolveMetaGraphApiEndpoint(pathSegments: readonly string[], environment: MetaProviderEnvironment, options?: {
    versioned?: boolean;
}): string;
/**
 * Meta Ads pagination supplies a complete URL. Keep it on the configured
 * provider origin and within the versioned Graph namespace to prevent SSRF.
 */
export declare function validateMetaGraphPaginationUrl(candidate: string, environment: MetaProviderEnvironment): string;
//# sourceMappingURL=meta-provider.d.ts.map