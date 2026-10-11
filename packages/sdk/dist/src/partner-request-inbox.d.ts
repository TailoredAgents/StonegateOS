export declare const PARTNER_REQUEST_KINDS: readonly ["service", "reschedule", "cancellation", "change", "billing", "address"];
export type PartnerRequestKind = (typeof PARTNER_REQUEST_KINDS)[number];
export declare const PARTNER_REQUEST_STAGES: readonly ["needs_attention", "waiting_on_client", "handled"];
export type PartnerRequestStage = (typeof PARTNER_REQUEST_STAGES)[number];
export type PartnerRequestInboxItem = {
    id: string;
    key: string;
    kind: PartnerRequestKind;
    accountId: string;
    accountName: string;
    jobId: string | null;
    service: string;
    description: string;
    siteName: string;
    address: string;
    requesterName: string;
    preferredWindows: Array<{
        localDate: string;
        timeOfDay: string;
        timezone: string;
    }>;
    receivedAt: string;
    state: string;
    stage: PartnerRequestStage;
    statusLabel: string;
    detailHref: string;
    canAct: boolean;
    canAcknowledge: boolean;
    alertGroupId: string | null;
    isNew: boolean;
};
export type PartnerRequestInboxCounts = {
    needsAttention: number;
    waitingOnClient: number;
    handled: number;
    byKind: Record<PartnerRequestKind, number>;
    byCompany: Record<string, number>;
};
export type PartnerRequestAlertGroupSummary = {
    id: string;
    accountId: string;
    bulkImportId: string | null;
    createdAt: string;
    openedAt: string | null;
    memberCount: number;
    canAcknowledge: boolean;
};
export type PartnerRequestInboxResponse = {
    ok: true;
    requests: PartnerRequestInboxItem[];
    counts: PartnerRequestInboxCounts;
    page: {
        nextCursor: string | null;
    };
    generatedAt: string;
    group: PartnerRequestAlertGroupSummary | null;
};
export type PartnerRequestInboxDetailResponse = {
    ok: true;
    request: PartnerRequestInboxItem;
    record: Record<string, unknown> | null;
};
export declare function isPartnerRequestInboxItem(value: unknown): value is PartnerRequestInboxItem;
export declare function parsePartnerRequestInbox(value: unknown): PartnerRequestInboxResponse | null;
export declare function parsePartnerRequestInboxDetail(value: unknown): PartnerRequestInboxDetailResponse | null;
//# sourceMappingURL=partner-request-inbox.d.ts.map