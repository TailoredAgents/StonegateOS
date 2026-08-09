export type TwilioProviderEnvironment = Readonly<Record<string, string | undefined>>;
export type TwilioRecordingFormat = "mp3" | "wav";
export type TwilioApiEndpoint = {
    kind: "messages";
    accountSid: string;
} | {
    kind: "calls";
    accountSid: string;
} | {
    kind: "recordings.list";
    accountSid: string;
    callSid: string;
} | {
    kind: "recordings.download";
    accountSid: string;
    recordingSid: string;
    format: TwilioRecordingFormat;
} | {
    kind: "recordings.delete";
    accountSid: string;
    recordingSid: string;
};
export declare const DEFAULT_TWILIO_API_BASE_URL = "https://api.twilio.com";
export declare function isLoopbackTwilioHostname(hostname: string): boolean;
/**
 * Resolve the only allowed Twilio REST base. Provider credentials are always
 * request headers and may never be embedded in this URL.
 */
export declare function getTwilioApiBaseUrl(environment: TwilioProviderEnvironment): URL;
export declare function isTwilioAccountSid(value: unknown): value is string;
export declare function isTwilioCallSid(value: unknown): value is string;
export declare function isTwilioMessageSid(value: unknown): value is string;
export declare function isTwilioRecordingSid(value: unknown): value is string;
export declare function requireTwilioAccountSid(value: string): string;
export declare function requireTwilioCallSid(value: string): string;
export declare function requireTwilioMessageSid(value: string): string;
export declare function requireTwilioRecordingSid(value: string): string;
export declare function resolveTwilioApiEndpoint(endpoint: TwilioApiEndpoint, environment: TwilioProviderEnvironment): string;
//# sourceMappingURL=twilio-provider.d.ts.map