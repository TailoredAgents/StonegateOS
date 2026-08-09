import type { MutationReceipt, MutationResult } from "./team-contracts";
export declare const AGENT_ACTION_TYPES: readonly ["create_contact", "create_quote", "create_task", "add_contact_note", "create_reminder", "book_appointment", "cancel_appointment", "reschedule_appointment", "send_text", "google_ads_recommendations_bulk_update", "google_ads_recommendations_bulk_apply"];
export type AgentActionType = (typeof AGENT_ACTION_TYPES)[number];
export declare const AGENT_ACTION_PERMISSIONS: {
    readonly create_contact: readonly ["contacts.write", "properties.write", "pipeline.write"];
    readonly create_quote: readonly ["quotes.write", "contacts.read", "properties.read"];
    readonly create_task: readonly ["appointments.update"];
    readonly add_contact_note: readonly ["contacts.write"];
    readonly create_reminder: readonly ["contacts.write"];
    readonly book_appointment: readonly ["bookings.manage"];
    readonly cancel_appointment: readonly ["appointments.update", "messages.send"];
    readonly reschedule_appointment: readonly ["appointments.update"];
    readonly send_text: readonly ["messages.write", "messages.send"];
    readonly google_ads_recommendations_bulk_update: readonly ["marketing.write"];
    readonly google_ads_recommendations_bulk_apply: readonly ["marketing.apply"];
};
export declare const AGENT_VERSIONED_ACTIONS: readonly ["cancel_appointment", "reschedule_appointment"];
export type AgentActionPayload = Record<string, unknown>;
export type AgentActionPayloadParseResult = {
    ok: true;
    payload: AgentActionPayload;
} | {
    ok: false;
    message: string;
    fieldErrors: Record<string, string>;
};
export type AgentActionApprovalProof = {
    approvalId: string;
    approvalToken: string;
    expiresAt: string;
};
export type AgentActionResultDescriptor = {
    result: Record<string, unknown>;
    entityType: string;
    entityId: string;
    version: string;
    providerOperationId?: string;
};
export type AgentOperationalReceipt = MutationReceipt & Required<Pick<MutationReceipt, "auditEventId" | "entityType" | "entityId" | "version">> & {
    version: string;
};
export type AgentOperationalMutationSuccess = {
    ok: true;
    data: Record<string, unknown>;
    receipt: AgentOperationalReceipt;
    descriptor: AgentActionResultDescriptor;
};
export type AgentOperationalMutationFailure = Extract<MutationResult<never>, {
    ok: false;
}>;
export type AgentOperationalMutationResult = AgentOperationalMutationSuccess | AgentOperationalMutationFailure;
export declare function isAgentActionType(value: unknown): value is AgentActionType;
export declare function isAgentVersionedAction(actionType: AgentActionType): boolean;
export declare function isAgentActionId(value: unknown): value is string;
export declare function isAgentIdempotencyKey(value: unknown): value is string;
export declare function isExactAgentRecordVersion(value: unknown): value is string;
export declare function parseAgentActionApprovalProof(value: unknown): AgentActionApprovalProof | null;
export declare function parseAgentActionPayload(actionType: AgentActionType, value: unknown): AgentActionPayloadParseResult;
export declare function canonicalAgentActionJson(value: unknown): string;
export declare function describeAgentOperationalResult(actionType: AgentActionType, value: unknown): AgentActionResultDescriptor | null;
export declare function parseAgentOperationalMutationResult(actionType: AgentActionType, value: unknown, expected: {
    actorId: string;
    targetEntityId?: string | null;
    expectedVersion?: string | null;
}): AgentOperationalMutationResult | null;
//# sourceMappingURL=agent-action-contracts.d.ts.map