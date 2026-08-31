import type { ActionPolicy, ActionRisk, TeamPermission } from "@myst-os/sdk";

/**
 * CI-enforced policy metadata for the authenticated Site Team server actions.
 *
 * This registry is metadata-only while the shared mutation wrapper is rolled
 * out route by route. An entry here does not prove that the corresponding
 * action enforces the policy at runtime. Runtime adoption needs separate
 * implementation and verification before that remediation item can close.
 *
 * Login and authentication actions are intentionally excluded. They live
 * under `team/login` and are governed by the authentication-specific threat
 * model, throttling, token-consumption, and session-revocation contracts.
 */
export const TEAM_SERVER_ACTION_MANIFEST_RUNTIME_STATUS =
  "metadata_only" as const;

export const TEAM_SERVER_ACTION_MANIFEST_SCOPE = [
  "team/actions.ts",
  "team/actions/*.ts",
] as const;

export const TEAM_SERVER_ACTION_MANIFEST_EXCLUSIONS = [
  "team/login/actions.ts",
  "team/auth/route.ts",
] as const;

type MutationRisk = Exclude<ActionRisk, "read">;
type TeamActionAuditName = `team_action.${string}`;

function humanAction(
  requiredPermissions: TeamPermission[],
  risk: MutationRisk,
  requiresIdempotency: boolean,
  auditAction: TeamActionAuditName,
): ActionPolicy {
  return {
    principalTypes: ["human"],
    requiredPermissions,
    risk,
    requiresIdempotency,
    auditAction,
  };
}

/**
 * One explicit entry for every exported mutation in the files named by
 * `TEAM_SERVER_ACTION_MANIFEST_SCOPE`. Keep entries in source order so a
 * reviewer can compare the registry with the action implementation easily.
 */
export const TEAM_SERVER_ACTION_POLICIES = {
  updateApptStatus: humanAction(
    [
      "appointments.update",
      "payments.collect",
      "payments.manage",
      "commissions.manage",
      "messages.send",
    ],
    "financial",
    true,
    "team_action.updateApptStatus",
  ),
  updateAppointmentEtaStatusAction: humanAction(
    ["appointments.update"],
    "normal",
    true,
    "team_action.updateAppointmentEtaStatusAction",
  ),
  sendEtaDraftAction: humanAction(
    ["messages.send"],
    "external",
    true,
    "team_action.sendEtaDraftAction",
  ),
  dismissEtaDraftAction: humanAction(
    ["messages.write"],
    "normal",
    true,
    "team_action.dismissEtaDraftAction",
  ),
  addApptNote: humanAction(
    ["appointments.update"],
    "normal",
    true,
    "team_action.addApptNote",
  ),
  sendQuoteAction: humanAction(
    ["quotes.send"],
    "external",
    true,
    "team_action.sendQuoteAction",
  ),
  createInboxQuoteAction: humanAction(
    ["quotes.write", "quotes.send", "properties.write"],
    "normal",
    true,
    "team_action.createInboxQuoteAction",
  ),
  quoteDecisionAction: humanAction(
    ["quotes.update"],
    "normal",
    true,
    "team_action.quoteDecisionAction",
  ),
  deleteQuoteAction: humanAction(
    ["quotes.delete"],
    "destructive",
    true,
    "team_action.deleteQuoteAction",
  ),
  deleteInstantQuoteAction: humanAction(
    ["quotes.delete"],
    "destructive",
    true,
    "team_action.deleteInstantQuoteAction",
  ),
  attachPaymentAction: humanAction(
    ["payments.reconcile", "payments.manage"],
    "financial",
    true,
    "team_action.attachPaymentAction",
  ),
  detachPaymentAction: humanAction(
    ["payments.reconcile", "payments.manage"],
    "financial",
    true,
    "team_action.detachPaymentAction",
  ),
  paymentReconciliationAction: humanAction(
    ["payments.reconcile", "payments.manage"],
    "financial",
    true,
    "team_action.paymentReconciliationAction",
  ),
  rescheduleAppointmentAction: humanAction(
    ["appointments.update"],
    "external",
    true,
    "team_action.rescheduleAppointmentAction",
  ),
  createQuoteAction: humanAction(
    ["quotes.write"],
    "external",
    true,
    "team_action.createQuoteAction",
  ),
  createContactAction: humanAction(
    ["contacts.write"],
    "normal",
    true,
    "team_action.createContactAction",
  ),
  bookAppointmentAction: humanAction(
    ["bookings.manage", "contacts.write"],
    "external",
    true,
    "team_action.bookAppointmentAction",
  ),
  bookInboxAppointmentAction: humanAction(
    ["bookings.manage"],
    "external",
    true,
    "team_action.bookInboxAppointmentAction",
  ),
  rescheduleInboxAppointmentAction: humanAction(
    ["appointments.update"],
    "external",
    true,
    "team_action.rescheduleInboxAppointmentAction",
  ),
  updateAppointmentBookingDetailsAction: humanAction(
    ["appointments.update", "payments.collect"],
    "financial",
    true,
    "team_action.updateAppointmentBookingDetailsAction",
  ),
  convertAppointmentToJobAction: humanAction(
    [
      "appointments.update",
      "appointments.override_conflicts",
      "payments.collect",
      "payments.manage",
      "commissions.manage",
    ],
    "financial",
    true,
    "team_action.convertAppointmentToJobAction",
  ),
  updateAppointmentSoldByAction: humanAction(
    ["appointments.update", "commissions.manage"],
    "financial",
    true,
    "team_action.updateAppointmentSoldByAction",
  ),
  scheduleQuoteFollowupAction: humanAction(
    ["appointments.update"],
    "external",
    true,
    "team_action.scheduleQuoteFollowupAction",
  ),
  createCanvassLeadAction: humanAction(
    ["contacts.write"],
    "normal",
    true,
    "team_action.createCanvassLeadAction",
  ),
  createCanvassFollowupAction: humanAction(
    ["contacts.write"],
    "external",
    true,
    "team_action.createCanvassFollowupAction",
  ),
  startContactCallAction: humanAction(
    ["calls.place"],
    "external",
    true,
    "team_action.startContactCallAction",
  ),
  reconcileManualCallAction: humanAction(
    ["calls.reconcile"],
    "normal",
    true,
    "team_action.reconcileManualCallAction",
  ),
  reconcileSalesEscalationCallAction: humanAction(
    ["calls.reconcile"],
    "normal",
    true,
    "team_action.reconcileSalesEscalationCallAction",
  ),
  openContactThreadAction: humanAction(
    ["messages.write"],
    "normal",
    true,
    "team_action.openContactThreadAction",
  ),
  sendDraftMessageAction: humanAction(
    ["messages.send"],
    "external",
    true,
    "team_action.sendDraftMessageAction",
  ),
  updateContactAction: humanAction(
    ["contacts.write"],
    "normal",
    false,
    "team_action.updateContactAction",
  ),
  updateContactNameAction: humanAction(
    ["contacts.write"],
    "normal",
    false,
    "team_action.updateContactNameAction",
  ),
  deleteContactAction: humanAction(
    ["contacts.delete"],
    "destructive",
    true,
    "team_action.deleteContactAction",
  ),
  restoreContactAction: humanAction(
    ["contacts.restore"],
    "normal",
    true,
    "team_action.restoreContactAction",
  ),
  addPropertyAction: humanAction(
    ["properties.write"],
    "normal",
    true,
    "team_action.addPropertyAction",
  ),
  updatePropertyAction: humanAction(
    ["properties.write"],
    "normal",
    false,
    "team_action.updatePropertyAction",
  ),
  deletePropertyAction: humanAction(
    ["properties.delete"],
    "destructive",
    true,
    "team_action.deletePropertyAction",
  ),
  updatePipelineStageAction: humanAction(
    ["pipeline.write"],
    "normal",
    true,
    "team_action.updatePipelineStageAction",
  ),
  createContactNoteAction: humanAction(
    ["contacts.write"],
    "normal",
    true,
    "team_action.createContactNoteAction",
  ),
  deleteContactNoteAction: humanAction(
    ["contacts.write"],
    "destructive",
    true,
    "team_action.deleteContactNoteAction",
  ),
  createTaskAction: humanAction(
    ["contacts.write"],
    "normal",
    true,
    "team_action.createTaskAction",
  ),
  updateTaskAction: humanAction(
    ["contacts.write"],
    "normal",
    false,
    "team_action.updateTaskAction",
  ),
  deleteTaskAction: humanAction(
    ["contacts.write"],
    "destructive",
    true,
    "team_action.deleteTaskAction",
  ),
  updatePolicyAction: humanAction(
    ["policy.write"],
    "normal",
    true,
    "team_action.updatePolicyAction",
  ),
  updateBusinessHoursPolicyAction: humanAction(
    ["policy.write"],
    "normal",
    true,
    "team_action.updateBusinessHoursPolicyAction",
  ),
  updateQuietHoursPolicyAction: humanAction(
    ["policy.write"],
    "normal",
    true,
    "team_action.updateQuietHoursPolicyAction",
  ),
  updateServiceAreaPolicyAction: humanAction(
    ["policy.write"],
    "normal",
    true,
    "team_action.updateServiceAreaPolicyAction",
  ),
  updateBookingRulesPolicyAction: humanAction(
    ["policy.write"],
    "normal",
    true,
    "team_action.updateBookingRulesPolicyAction",
  ),
  updateStandardJobPolicyAction: humanAction(
    ["policy.write"],
    "normal",
    true,
    "team_action.updateStandardJobPolicyAction",
  ),
  updateItemPoliciesAction: humanAction(
    ["policy.write"],
    "normal",
    true,
    "team_action.updateItemPoliciesAction",
  ),
  updateCompanyProfilePolicyAction: humanAction(
    ["policy.write"],
    "normal",
    true,
    "team_action.updateCompanyProfilePolicyAction",
  ),
  updateSalesAutopilotSignatureAction: humanAction(
    ["policy.write"],
    "normal",
    true,
    "team_action.updateSalesAutopilotSignatureAction",
  ),
  updateConversationPersonaPolicyAction: humanAction(
    ["policy.write"],
    "normal",
    true,
    "team_action.updateConversationPersonaPolicyAction",
  ),
  updateInboxAlertsPolicyAction: humanAction(
    ["policy.write"],
    "normal",
    true,
    "team_action.updateInboxAlertsPolicyAction",
  ),
  updateTemplatesPolicyAction: humanAction(
    ["policy.write"],
    "normal",
    true,
    "team_action.updateTemplatesPolicyAction",
  ),
  updateReviewRequestPolicyAction: humanAction(
    ["policy.write"],
    "normal",
    true,
    "team_action.updateReviewRequestPolicyAction",
  ),
  updateConfirmationLoopPolicyAction: humanAction(
    ["policy.write"],
    "normal",
    true,
    "team_action.updateConfirmationLoopPolicyAction",
  ),
  updateFollowUpSequencePolicyAction: humanAction(
    ["policy.write"],
    "normal",
    true,
    "team_action.updateFollowUpSequencePolicyAction",
  ),
  updateAutomationModeAction: humanAction(
    ["automation.write"],
    "external",
    true,
    "team_action.updateAutomationModeAction",
  ),
  updateSalesAutopilotPolicyAction: humanAction(
    ["automation.write"],
    "external",
    true,
    "team_action.updateSalesAutopilotPolicyAction",
  ),
  updateLeadAutomationAction: humanAction(
    ["automation.write"],
    "external",
    true,
    "team_action.updateLeadAutomationAction",
  ),
  scanMergeSuggestionsAction: humanAction(
    ["contacts.merge"],
    "normal",
    true,
    "team_action.scanMergeSuggestionsAction",
  ),
  approveMergeSuggestionAction: humanAction(
    ["contacts.merge"],
    "destructive",
    true,
    "team_action.approveMergeSuggestionAction",
  ),
  declineMergeSuggestionAction: humanAction(
    ["contacts.merge"],
    "normal",
    true,
    "team_action.declineMergeSuggestionAction",
  ),
  manualMergeContactsAction: humanAction(
    ["contacts.merge"],
    "destructive",
    true,
    "team_action.manualMergeContactsAction",
  ),
  previewManualMergeAction: humanAction(
    ["contacts.merge"],
    "normal",
    false,
    "team_action.previewManualMergeAction",
  ),
  createRoleAction: humanAction(
    ["access.manage"],
    "normal",
    true,
    "team_action.createRoleAction",
  ),
  createTeamMemberAction: humanAction(
    ["access.manage"],
    "normal",
    true,
    "team_action.createTeamMemberAction",
  ),
  updateTeamMemberAction: humanAction(
    ["access.manage"],
    "destructive",
    true,
    "team_action.updateTeamMemberAction",
  ),
  deleteTeamMemberAction: humanAction(
    ["access.manage"],
    "destructive",
    true,
    "team_action.deleteTeamMemberAction",
  ),
  createThreadAction: humanAction(
    ["messages.write"],
    "normal",
    true,
    "team_action.createThreadAction",
  ),
  updateThreadAction: humanAction(
    ["messages.write"],
    "normal",
    false,
    "team_action.updateThreadAction",
  ),
  sendThreadMessageAction: humanAction(
    ["messages.send", "messages.upload"],
    "external",
    true,
    "team_action.sendThreadMessageAction",
  ),
  retryFailedMessageAction: humanAction(
    ["messages.send"],
    "external",
    true,
    "team_action.retryFailedMessageAction",
  ),
  deleteMessageAction: humanAction(
    ["messages.delete"],
    "destructive",
    true,
    "team_action.deleteMessageAction",
  ),
  suggestThreadReplyAction: humanAction(
    ["messages.write"],
    "external",
    true,
    "team_action.suggestThreadReplyAction",
  ),
  acknowledgeNewLeadAction: humanAction(
    ["messages.read"],
    "normal",
    true,
    "team_action.acknowledgeNewLeadAction",
  ),
  updateDefaultSalesAssigneeAction: humanAction(
    ["access.manage"],
    "normal",
    false,
    "team_action.updateDefaultSalesAssigneeAction",
  ),
  resetSalesHqAction: humanAction(
    ["sales.reset"],
    "destructive",
    true,
    "team_action.resetSalesHqAction",
  ),
  deleteCallCoachingAction: humanAction(
    ["sales.reset"],
    "destructive",
    true,
    "team_action.deleteCallCoachingAction",
  ),
  markSalesTouchAction: humanAction(
    ["sales.write"],
    "normal",
    true,
    "team_action.markSalesTouchAction",
  ),
  setSalesDispositionAction: humanAction(
    ["sales.write"],
    "normal",
    true,
    "team_action.setSalesDispositionAction",
  ),
  runSeoDraftAction: humanAction(
    ["marketing.publish"],
    "external",
    true,
    "team_action.runSeoDraftAction",
  ),
  submitSeoPostForReviewAction: humanAction(
    ["marketing.publish"],
    "normal",
    true,
    "team_action.submitSeoPostForReviewAction",
  ),
  publishSeoPostAction: humanAction(
    ["marketing.publish"],
    "external",
    true,
    "team_action.publishSeoPostAction",
  ),
  runGoogleAdsSyncAction: humanAction(
    ["marketing.write"],
    "external",
    true,
    "team_action.runGoogleAdsSyncAction",
  ),
  runGoogleAdsAnalystAction: humanAction(
    ["marketing.write"],
    "external",
    true,
    "team_action.runGoogleAdsAnalystAction",
  ),
  saveGoogleAdsAnalystSettingsAction: humanAction(
    ["marketing.write"],
    "external",
    true,
    "team_action.saveGoogleAdsAnalystSettingsAction",
  ),
  updateGoogleAdsAnalystRecommendationAction: humanAction(
    ["marketing.write"],
    "normal",
    true,
    "team_action.updateGoogleAdsAnalystRecommendationAction",
  ),
  applyGoogleAdsAnalystRecommendationAction: humanAction(
    ["marketing.apply"],
    "external",
    true,
    "team_action.applyGoogleAdsAnalystRecommendationAction",
  ),
  bulkUpdateGoogleAdsAnalystRecommendationsAction: humanAction(
    ["marketing.write"],
    "normal",
    true,
    "team_action.bulkUpdateGoogleAdsAnalystRecommendationsAction",
  ),
  bulkApplyGoogleAdsAnalystRecommendationsAction: humanAction(
    ["marketing.apply"],
    "external",
    true,
    "team_action.bulkApplyGoogleAdsAnalystRecommendationsAction",
  ),
  importOutboundProspectsAction: humanAction(
    ["outbound.import"],
    "normal",
    true,
    "team_action.importOutboundProspectsAction",
  ),
  setOutboundDispositionAction: humanAction(
    ["outbound.write"],
    "normal",
    true,
    "team_action.setOutboundDispositionAction",
  ),
  draftOutboundFollowupAction: humanAction(
    ["outbound.write"],
    "external",
    true,
    "team_action.draftOutboundFollowupAction",
  ),
  startOutboundCadenceAction: humanAction(
    ["outbound.write"],
    "normal",
    true,
    "team_action.startOutboundCadenceAction",
  ),
  draftOutboundFirstTouchAction: humanAction(
    ["outbound.write"],
    "external",
    true,
    "team_action.draftOutboundFirstTouchAction",
  ),
  bulkOutboundAction: humanAction(
    ["outbound.write"],
    "normal",
    true,
    "team_action.bulkOutboundAction",
  ),
  partnerScheduleCheckinAction: humanAction(
    ["partners.write"],
    "normal",
    true,
    "team_action.partnerScheduleCheckinAction",
  ),
  partnerLogTouchAction: humanAction(
    ["partners.write"],
    "normal",
    true,
    "team_action.partnerLogTouchAction",
  ),
  partnerLogReferralAction: humanAction(
    ["partners.write"],
    "normal",
    true,
    "team_action.partnerLogReferralAction",
  ),
  partnerAccessApplicationDecisionAction: humanAction(
    ["partners.invite"],
    "destructive",
    true,
    "team_action.partnerAccessApplicationDecisionAction",
  ),
  partnerPortalInviteUserAction: humanAction(
    ["partners.invite"],
    "external",
    true,
    "team_action.partnerPortalInviteUserAction",
  ),
  partnerPortalSetUserActiveAction: humanAction(
    ["partners.invite"],
    "destructive",
    true,
    "team_action.partnerPortalSetUserActiveAction",
  ),
  partnerPortalSaveRatesAction: humanAction(
    ["partners.rates"],
    "financial",
    true,
    "team_action.partnerPortalSaveRatesAction",
  ),
  addApptTaskAction: humanAction(
    ["appointments.update"],
    "normal",
    true,
    "team_action.addApptTaskAction",
  ),
  updateApptTaskStatusAction: humanAction(
    ["appointments.update"],
    "normal",
    false,
    "team_action.updateApptTaskStatusAction",
  ),
} as const satisfies Record<string, ActionPolicy>;

export type TeamServerActionName = keyof typeof TEAM_SERVER_ACTION_POLICIES;
