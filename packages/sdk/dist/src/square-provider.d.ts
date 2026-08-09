export type SquareProviderEnvironment = Readonly<Record<string, string | undefined>>;
export type SquareApiEndpoint = {
    kind: "order";
    orderId: string;
} | {
    kind: "payment";
    paymentId: string;
} | {
    kind: "refund";
    refundId: string;
} | {
    kind: "payments";
} | {
    kind: "refunds";
};
export declare const DEFAULT_SQUARE_PRODUCTION_API_BASE_URL = "https://connect.squareup.com";
export declare const DEFAULT_SQUARE_SANDBOX_API_BASE_URL = "https://connect.squareupsandbox.com";
export declare function isLoopbackSquareHostname(hostname: string): boolean;
export declare function getSquareApiBaseUrl(environment: SquareProviderEnvironment): URL;
export declare function resolveSquareApiEndpoint(endpoint: SquareApiEndpoint, environment: SquareProviderEnvironment): string;
//# sourceMappingURL=square-provider.d.ts.map