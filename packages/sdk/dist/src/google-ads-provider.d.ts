export type GoogleAdsProviderEnvironment = Readonly<Record<string, string | undefined>>;
export type GoogleAdsApiEndpoint = {
    kind: "accessible_customers";
    apiVersion: string;
} | {
    kind: "search_stream";
    apiVersion: string;
    customerId: string;
} | {
    kind: "mutate_customer_negative_criteria";
    apiVersion: string;
    customerId: string;
};
export declare const DEFAULT_GOOGLE_ADS_API_BASE_URL = "https://googleads.googleapis.com";
export declare const DEFAULT_GOOGLE_ADS_TOKEN_URL = "https://oauth2.googleapis.com/token";
export type GoogleAdsProviderEndpoints = {
    apiBaseUrl: URL;
    tokenUrl: URL;
};
export declare function isLoopbackGoogleAdsHostname(hostname: string): boolean;
export declare function getGoogleAdsProviderEndpoints(environment: GoogleAdsProviderEnvironment): GoogleAdsProviderEndpoints;
export declare function resolveGoogleAdsApiEndpoint(endpoint: GoogleAdsApiEndpoint, environment: GoogleAdsProviderEnvironment): string;
export declare function resolveGoogleAdsTokenEndpoint(environment: GoogleAdsProviderEnvironment): string;
//# sourceMappingURL=google-ads-provider.d.ts.map