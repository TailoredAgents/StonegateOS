# Data Dictionary (Generated Columns)

Generated from `apps/api/src/db/schema.ts`. Fingerprint: `aeafc8ba62bd2241`.

Parsed tables: 228

This is a structural inventory, not a relationship or data-retention specification. Use `DATA_DICTIONARY.md` for curated domain guidance and verify both against schema and migrations before operational changes.

## appointment_attachments

Schema export: `appointmentAttachments`

Columns (6):

- `id`
- `appointmentId`
- `filename`
- `url`
- `contentType`
- `createdAt`

## appointment_commissions

Schema export: `appointmentCommissions`

Columns (9):

- `id`
- `appointmentId`
- `memberId`
- `role`
- `baseCents`
- `amountCents`
- `meta`
- `createdAt`
- `updatedAt`

## appointment_crew_members

Schema export: `appointmentCrewMembers`

Columns (9):

- `id`
- `appointmentId`
- `memberId`
- `splitBps`
- `fixedJobRateBps`
- `poolRateBps`
- `hourlyRateCents`
- `workedMinutes`
- `createdAt`

## appointment_eta_events

Schema export: `appointmentEtaEvents`

Columns (9):

- `id`
- `appointmentId`
- `teamMemberId`
- `crewLabel`
- `eventType`
- `source`
- `note`
- `meta`
- `createdAt`

## appointment_holds

Schema export: `appointmentHolds`

Columns (26):

- `id`
- `instantQuoteId`
- `fullQuoteId`
- `quoteVersionId`
- `leadId`
- `contactId`
- `propertyId`
- `partnerAccountId`
- `partnerBookingDraftId`
- `requestedByMembershipId`
- `startAt`
- `durationMinutes`
- `travelBufferMinutes`
- `capacityPoolKey`
- `capacityUnits`
- `arrivalWindowStartAt`
- `arrivalWindowEndAt`
- `policyRevision`
- `serviceProfileRevision`
- `resourceAssignmentSnapshot`
- `idempotencyKeyHash`
- `status`
- `expiresAt`
- `consumedAt`
- `createdAt`
- `updatedAt`

## appointment_media

Schema export: `appointmentMedia`

Columns (12):

- `id`
- `appointmentId`
- `mediaAssetId`
- `purpose`
- `caption`
- `sortOrder`
- `isCover`
- `attachedByMemberId`
- `attachmentSource`
- `deletedAt`
- `createdAt`
- `updatedAt`

## appointment_notes

Schema export: `appointmentNotes`

Columns (4):

- `id`
- `appointmentId`
- `body`
- `createdAt`

## appointment_tasks

Schema export: `appointmentTasks`

Columns (6):

- `id`
- `appointmentId`
- `title`
- `status`
- `createdAt`
- `updatedAt`

## appointments

Schema export: `appointments`

Columns (37):

- `id`
- `quoteVersionId`
- `quoteResponseId`
- `salesOpportunityId`
- `contactId`
- `propertyId`
- `leadId`
- `type`
- `startAt`
- `schedulingTimezone`
- `durationMinutes`
- `status`
- `quotedTotalCents`
- `quotedTotalMaxCents`
- `quoteConfigurationHash`
- `quoteContentHash`
- `finalTotalCents`
- `quotedScopeText`
- `bookingDetails`
- `cardTipCents`
- `completedAt`
- `calendarEventId`
- `crew`
- `owner`
- `soldByMemberId`
- `marketingMemberId`
- `rescheduleToken`
- `travelBufferMinutes`
- `partnerAccountId`
- `capacityPoolKey`
- `capacityUnits`
- `promisedArrivalStartAt`
- `promisedArrivalEndAt`
- `schedulePolicyRevision`
- `resourceAssignmentSnapshot`
- `createdAt`
- `updatedAt`

## audit_logs

Schema export: `auditLogs`

Columns (18):

- `id`
- `actorType`
- `actorId`
- `actorLabel`
- `actorRole`
- `sessionId`
- `authMethod`
- `correlationId`
- `requiredPermissions`
- `outcome`
- `surface`
- `providerOperationId`
- `idempotencyKeyHash`
- `action`
- `entityType`
- `entityId`
- `meta`
- `createdAt`

## automation_settings

Schema export: `automationSettings`

Columns (4):

- `channel`
- `mode`
- `updatedBy`
- `updatedAt`

## blog_posts

Schema export: `blogPosts`

Columns (20):

- `id`
- `slug`
- `title`
- `excerpt`
- `contentMarkdown`
- `metaTitle`
- `metaDescription`
- `topicKey`
- `editorialStatus`
- `version`
- `generatedAt`
- `reviewRequestedAt`
- `reviewedAt`
- `reviewedBy`
- `publishedBy`
- `generationKeyHash`
- `lastError`
- `publishedAt`
- `createdAt`
- `updatedAt`

## calendar_sync_state

Schema export: `calendarSyncState`

Columns (10):

- `calendarId`
- `syncToken`
- `channelId`
- `resourceId`
- `channelExpiresAt`
- `lastSyncedAt`
- `externalBusyCoverageSyncedAt`
- `lastNotificationAt`
- `createdAt`
- `updatedAt`

## call_coaching

Schema export: `callCoaching`

Columns (12):

- `id`
- `callRecordId`
- `memberId`
- `rubric`
- `version`
- `model`
- `scoreOverall`
- `scoreBreakdown`
- `wins`
- `improvements`
- `createdAt`
- `updatedAt`

## call_records

Schema export: `callRecords`

Columns (25):

- `id`
- `callSid`
- `parentCallSid`
- `direction`
- `mode`
- `from`
- `to`
- `contactId`
- `assignedTo`
- `callStatus`
- `callDurationSec`
- `recordingSid`
- `recordingUrl`
- `recordingDurationSec`
- `recordingCreatedAt`
- `transcript`
- `extracted`
- `summary`
- `coaching`
- `noteTaskId`
- `processedAt`
- `deleteAfter`
- `deletedAt`
- `createdAt`
- `updatedAt`

## commission_crew_pool_override_days

Schema export: `commissionCrewPoolOverrideDays`

Columns (8):

- `id`
- `localDate`
- `timezone`
- `crewPoolRateBps`
- `note`
- `createdBy`
- `createdAt`
- `updatedAt`

## commission_crew_split_rules

Schema export: `commissionCrewSplitRules`

Columns (8):

- `id`
- `settingsKey`
- `ruleKey`
- `memberId`
- `splitBps`
- `enabled`
- `createdAt`
- `updatedAt`

## commission_management_rate_recipients

Schema export: `commissionManagementRateRecipients`

Columns (4):

- `id`
- `versionId`
- `memberId`
- `rateBps`

## commission_management_rate_versions

Schema export: `commissionManagementRateVersions`

Columns (7):

- `id`
- `settingsKey`
- `effectiveFrom`
- `totalRateBps`
- `reason`
- `createdBy`
- `createdAt`

## commission_management_splits

Schema export: `commissionManagementSplits`

Columns (7):

- `id`
- `settingsKey`
- `memberId`
- `splitBps`
- `enabled`
- `createdAt`
- `updatedAt`

## commission_settings

Schema export: `commissionSettings`

Columns (12):

- `key`
- `timezone`
- `payoutWeekday`
- `payoutHour`
- `payoutMinute`
- `salesRateBps`
- `marketingRateBps`
- `crewPoolRateBps`
- `marketingMemberId`
- `updatedBy`
- `createdAt`
- `updatedAt`

## contact_merge_recovery_entries

Schema export: `contactMergeRecoveryEntries`

Columns (9):

- `id`
- `ledgerId`
- `ordinal`
- `entityType`
- `entityId`
- `changeKind`
- `before`
- `after`
- `createdAt`

## contact_merge_recovery_ledgers

Schema export: `contactMergeRecoveryLedgers`

Columns (21):

- `id`
- `sourceContactId`
- `targetContactId`
- `suggestionId`
- `previewHash`
- `ruleVersion`
- `sourceVersion`
- `targetVersion`
- `actorMemberId`
- `actorRole`
- `actorLabel`
- `sessionId`
- `authMethod`
- `operationId`
- `correlationId`
- `idempotencyKeyHash`
- `status`
- `contactBefore`
- `consolidationPlan`
- `dependencySummary`
- `createdAt`

## contact_properties

Schema export: `contactProperties`

Columns (6):

- `id`
- `contactId`
- `propertyId`
- `relationship`
- `createdAt`
- `updatedAt`

## contacts

Schema export: `contacts`

Columns (30):

- `id`
- `firstName`
- `lastName`
- `company`
- `email`
- `phone`
- `phoneE164`
- `salespersonMemberId`
- `partnerAccountId`
- `partnerStatus`
- `partnerType`
- `partnerOwnerMemberId`
- `partnerSince`
- `partnerLastTouchAt`
- `partnerNextTouchAt`
- `partnerReferralCount`
- `partnerLastReferralAt`
- `doNotContact`
- `doNotContactAt`
- `doNotContactBy`
- `doNotContactReason`
- `preferredContactMethod`
- `source`
- `deletedAt`
- `deletedBy`
- `purgeEligibleAt`
- `mergedIntoContactId`
- `mergeRecoveryLedgerId`
- `createdAt`
- `updatedAt`

## conversation_messages

Schema export: `conversationMessages`

Columns (20):

- `id`
- `threadId`
- `participantId`
- `direction`
- `channel`
- `subject`
- `body`
- `mediaUrls`
- `toAddress`
- `fromAddress`
- `deliveryStatus`
- `provider`
- `providerMessageId`
- `sentAt`
- `receivedAt`
- `metadata`
- `portalVisible`
- `authorType`
- `idempotencyKeyHash`
- `createdAt`

## conversation_participants

Schema export: `conversationParticipants`

Columns (9):

- `id`
- `threadId`
- `participantType`
- `contactId`
- `teamMemberId`
- `partnerMembershipId`
- `externalAddress`
- `displayName`
- `createdAt`

## conversation_threads

Schema export: `conversationThreads`

Columns (24):

- `id`
- `salesOpportunityId`
- `leadId`
- `contactId`
- `propertyId`
- `partnerAccountId`
- `partnerBookingId`
- `staffScope`
- `portalVisible`
- `status`
- `state`
- `channel`
- `subject`
- `lastMessagePreview`
- `lastMessageAt`
- `assignedTo`
- `attentionHandledAt`
- `attentionHandledBy`
- `closedReason`
- `closedAt`
- `closedBy`
- `stateUpdatedAt`
- `createdAt`
- `updatedAt`

## crew_location_pings

Schema export: `crewLocationPings`

Columns (12):

- `id`
- `trackingDeviceId`
- `provider`
- `providerPositionId`
- `lat`
- `lng`
- `accuracyMeters`
- `speedKph`
- `fixAt`
- `receivedAt`
- `freshness`
- `raw`

## crew_route_states

Schema export: `crewRouteStates`

Columns (13):

- `id`
- `teamMemberId`
- `crewLabel`
- `serviceDate`
- `currentAppointmentId`
- `nextAppointmentId`
- `status`
- `dumpStatus`
- `locationFreshness`
- `lastLocationPingId`
- `statusNote`
- `createdAt`
- `updatedAt`

## crew_tracking_devices

Schema export: `crewTrackingDevices`

Columns (9):

- `id`
- `teamMemberId`
- `crewLabel`
- `provider`
- `providerDeviceId`
- `displayName`
- `active`
- `createdAt`
- `updatedAt`

## crm_pipeline

Schema export: `crmPipeline`

Columns (5):

- `contactId`
- `stage`
- `notes`
- `createdAt`
- `updatedAt`

## crm_tasks

Schema export: `crmTasks`

Columns (19):

- `id`
- `salesOpportunityId`
- `contactId`
- `partnerAccountId`
- `title`
- `dueAt`
- `assignedTo`
- `status`
- `notes`
- `outboundProjectionVersion`
- `outboundIsOutbound`
- `outboundCampaign`
- `outboundAttempt`
- `outboundLastDisposition`
- `outboundCompany`
- `outboundNoteSnippet`
- `outboundStartedAt`
- `createdAt`
- `updatedAt`

## daily_ad_spend

Schema export: `dailyAdSpend`

Columns (10):

- `id`
- `platform`
- `businessDate`
- `amountCents`
- `currentExpenseId`
- `enteredBy`
- `confirmedAt`
- `version`
- `createdAt`
- `updatedAt`

## discord_action_intents

Schema export: `discordActionIntents`

Columns (18):

- `id`
- `status`
- `discordGuildId`
- `discordChannelId`
- `discordIntentMessageId`
- `requestedByDiscordUserId`
- `requestText`
- `agentReply`
- `actions`
- `createdAt`
- `expiresAt`
- `approvedAt`
- `executedAt`
- `canceledAt`
- `executedByDiscordUserId`
- `error`
- `result`
- `updatedAt`

## discord_agent_memory

Schema export: `discordAgentMemory`

Columns (13):

- `id`
- `discordGuildId`
- `discordChannelId`
- `scope`
- `memoryType`
- `title`
- `content`
- `tags`
- `pinned`
- `archived`
- `createdByDiscordUserId`
- `createdAt`
- `updatedAt`

## discord_report_subscriptions

Schema export: `discordReportSubscriptions`

Columns (11):

- `id`
- `discordGuildId`
- `discordChannelId`
- `reportType`
- `timezone`
- `timeOfDay`
- `enabled`
- `lastSentAt`
- `createdByDiscordUserId`
- `createdAt`
- `updatedAt`

## eta_message_drafts

Schema export: `etaMessageDrafts`

Columns (18):

- `id`
- `appointmentId`
- `contactId`
- `threadId`
- `channel`
- `status`
- `reason`
- `body`
- `etaStartAt`
- `etaEndAt`
- `confidence`
- `locationFreshness`
- `createdBy`
- `sentBy`
- `sentAt`
- `dismissedAt`
- `createdAt`
- `updatedAt`

## expense_allocations

Schema export: `expenseAllocations`

Columns (5):

- `id`
- `expenseId`
- `categoryId`
- `amountCents`
- `createdAt`

## expense_categories

Schema export: `expenseCategories`

Columns (7):

- `id`
- `name`
- `sortOrder`
- `isActive`
- `isLegacy`
- `createdAt`
- `updatedAt`

## expense_category_aliases

Schema export: `expenseCategoryAliases`

Columns (5):

- `id`
- `categoryId`
- `alias`
- `normalizedAlias`
- `createdAt`

## expense_dump_details

Schema export: `expenseDumpDetails`

Columns (13):

- `expenseId`
- `weightStatus`
- `facilityName`
- `ticketNumber`
- `material`
- `grossWeightPounds`
- `tareWeightPounds`
- `netWeightPounds`
- `billedWeightMilliTons`
- `unitRateCentsPerTon`
- `confirmedBy`
- `confirmedAt`
- `createdAt`

## expense_fixed_cost_series

Schema export: `expenseFixedCostSeries`

Columns (3):

- `id`
- `createdBy`
- `createdAt`

## expense_fixed_cost_versions

Schema export: `expenseFixedCostVersions`

Columns (10):

- `id`
- `seriesId`
- `version`
- `name`
- `categoryId`
- `monthlyAmountCents`
- `effectiveStartDate`
- `state`
- `createdBy`
- `createdAt`

## expense_receipt_captures

Schema export: `expenseReceiptCaptures`

Columns (32):

- `id`
- `submittedBy`
- `status`
- `storageProvider`
- `originalObjectKey`
- `normalizedObjectKey`
- `filename`
- `declaredContentType`
- `verifiedContentType`
- `byteLength`
- `sha256`
- `uploadExpiresAt`
- `uploadedAt`
- `analysisQueuedAt`
- `analysisStartedAt`
- `analysisCompletedAt`
- `analysisAttemptCount`
- `analysisNextAttemptAt`
- `analysisModel`
- `extraction`
- `analysisWarnings`
- `failureCode`
- `failureMessage`
- `exactDuplicateOfCaptureId`
- `duplicateOverrideReason`
- `duplicateOverrideBy`
- `duplicateOverrideAt`
- `confirmedAt`
- `discardedAt`
- `version`
- `createdAt`
- `updatedAt`

## expense_reimbursement_claims

Schema export: `expenseReimbursementClaims`

Columns (15):

- `id`
- `expenseId`
- `memberId`
- `amountCents`
- `status`
- `reviewedBy`
- `reviewedAt`
- `reviewReason`
- `payoutRunId`
- `payoutAdjustmentId`
- `attachedAt`
- `paidAt`
- `version`
- `createdAt`
- `updatedAt`

## expense_vendor_category_rules

Schema export: `expenseVendorCategoryRules`

Columns (10):

- `id`
- `normalizedVendor`
- `categoryId`
- `confirmationCount`
- `disagreementCount`
- `ownerLocked`
- `lockedBy`
- `lockedAt`
- `createdAt`
- `updatedAt`

## expenses

Schema export: `expenses`

Columns (43):

- `id`
- `amount`
- `currency`
- `category`
- `categoryId`
- `categoryNeedsReview`
- `vendor`
- `memo`
- `method`
- `source`
- `submittedBy`
- `payerType`
- `paidByMemberId`
- `reviewStatus`
- `reviewedBy`
- `reviewedAt`
- `reviewReason`
- `receiptCaptureId`
- `appointmentId`
- `paidAt`
- `coverageStartAt`
- `coverageEndAt`
- `coveredByFixedCostSeriesId`
- `receiptFilename`
- `receiptUrl`
- `receiptContentType`
- `bankTransactionId`
- `payoutRunId`
- `lifecycleStatus`
- `version`
- `postedAt`
- `postedBy`
- `voidedAt`
- `voidedBy`
- `voidReason`
- `correctedAt`
- `correctedBy`
- `correctionReason`
- `reversalOfExpenseId`
- `correctionOfExpenseId`
- `correctedByExpenseId`
- `createdAt`
- `updatedAt`

## external_message_dispatches

Schema export: `externalMessageDispatches`

Columns (21):

- `id`
- `outboxEventId`
- `messageId`
- `contactId`
- `channel`
- `attemptNumber`
- `state`
- `version`
- `providerRequestKey`
- `provider`
- `providerOperationId`
- `providerOperationIds`
- `providerIdempotencySupported`
- `dispatchedAt`
- `uncertaintyAt`
- `completedAt`
- `reconciliationRequiredAt`
- `failureDetail`
- `retryable`
- `createdAt`
- `updatedAt`

## facebook_sales_autopilot_actions

Schema export: `facebookSalesAutopilotActions`

Columns (17):

- `id`
- `sessionId`
- `contactId`
- `leadId`
- `threadId`
- `messageId`
- `proposedAction`
- `executedAction`
- `autonomyMode`
- `stage`
- `confidence`
- `decisionReason`
- `humanReviewReason`
- `inputSnapshot`
- `resultJson`
- `error`
- `createdAt`

## facebook_sales_autopilot_sessions

Schema export: `facebookSalesAutopilotSessions`

Columns (18):

- `id`
- `contactId`
- `leadId`
- `threadId`
- `channel`
- `stage`
- `autonomyMode`
- `lastDecision`
- `lastDecisionReason`
- `lastHumanReviewReason`
- `lastEvaluatedMessageId`
- `lastMeaningfulInboundAt`
- `quoteLowCents`
- `quoteHighCents`
- `offeredSlotsJson`
- `metadata`
- `createdAt`
- `updatedAt`

## google_ads_analyst_recommendation_events

Schema export: `googleAdsAnalystRecommendationEvents`

Columns (10):

- `id`
- `recommendationId`
- `reportId`
- `kind`
- `fromStatus`
- `toStatus`
- `note`
- `actorMemberId`
- `actorSource`
- `createdAt`

## google_ads_analyst_recommendations

Schema export: `googleAdsAnalystRecommendations`

Columns (10):

- `id`
- `reportId`
- `kind`
- `status`
- `payload`
- `decidedBy`
- `decidedAt`
- `appliedAt`
- `createdAt`
- `updatedAt`

## google_ads_analyst_reports

Schema export: `googleAdsAnalystReports`

Columns (9):

- `id`
- `rangeDays`
- `since`
- `until`
- `callWeight`
- `bookingWeight`
- `report`
- `createdBy`
- `createdAt`

## google_ads_campaign_conversions_daily

Schema export: `googleAdsCampaignConversionsDaily`

Columns (10):

- `id`
- `customerId`
- `dateStart`
- `campaignId`
- `conversionActionId`
- `conversionActionName`
- `conversions`
- `conversionValue`
- `raw`
- `fetchedAt`

## google_ads_conversion_actions

Schema export: `googleAdsConversionActions`

Columns (10):

- `id`
- `customerId`
- `resourceName`
- `actionId`
- `name`
- `category`
- `type`
- `status`
- `raw`
- `fetchedAt`

## google_ads_insights_daily

Schema export: `googleAdsInsightsDaily`

Columns (12):

- `id`
- `customerId`
- `dateStart`
- `campaignId`
- `campaignName`
- `impressions`
- `clicks`
- `cost`
- `conversions`
- `conversionValue`
- `raw`
- `fetchedAt`

## google_ads_recommendation_operations

Schema export: `googleAdsRecommendationOperations`

Columns (26):

- `id`
- `recommendationId`
- `parentOperationId`
- `correlationId`
- `idempotencyKeyHash`
- `expectedVersion`
- `actorMemberId`
- `actorLabel`
- `state`
- `version`
- `provider`
- `providerRequestKey`
- `providerOperationId`
- `terminalAuditEventId`
- `providerIdempotencySupported`
- `term`
- `matchType`
- `requestedAt`
- `dispatchedAt`
- `completedAt`
- `reconciliationRequiredAt`
- `providerStatus`
- `failureCode`
- `failureDetail`
- `createdAt`
- `updatedAt`

## google_ads_search_terms_daily

Schema export: `googleAdsSearchTermsDaily`

Columns (13):

- `id`
- `customerId`
- `dateStart`
- `campaignId`
- `adGroupId`
- `searchTerm`
- `impressions`
- `clicks`
- `cost`
- `conversions`
- `conversionValue`
- `raw`
- `fetchedAt`

## inbox_media_uploads

Schema export: `inboxMediaUploads`

Columns (8):

- `id`
- `token`
- `filename`
- `contentType`
- `bytes`
- `byteLength`
- `createdAt`
- `expiresAt`

## instant_quote_media

Schema export: `instantQuoteMedia`

Columns (5):

- `id`
- `instantQuoteId`
- `mediaAssetId`
- `sortOrder`
- `createdAt`

## instant_quote_relationship_backfill_ambiguities

Schema export: `instantQuoteRelationshipBackfillAmbiguities`

Columns (5):

- `instantQuoteId`
- `leadCount`
- `contactIds`
- `propertyIds`
- `detectedAt`

## instant_quotes

Schema export: `instantQuotes`

Columns (14):

- `id`
- `contactId`
- `propertyId`
- `createdAt`
- `source`
- `contactName`
- `contactPhone`
- `timeframe`
- `zip`
- `jobTypes`
- `perceivedSize`
- `notes`
- `photoUrls`
- `aiResult`

## lead_automation_state

Schema export: `leadAutomationStates`

Columns (13):

- `id`
- `leadId`
- `channel`
- `paused`
- `dnc`
- `humanTakeover`
- `followupState`
- `followupStep`
- `nextFollowupAt`
- `pausedAt`
- `pausedBy`
- `createdAt`
- `updatedAt`

## leads

Schema export: `leads`

Columns (26):

- `id`
- `salesOpportunityId`
- `contactId`
- `propertyId`
- `servicesRequested`
- `notes`
- `surfaceArea`
- `status`
- `source`
- `utmSource`
- `utmMedium`
- `utmCampaign`
- `utmTerm`
- `utmContent`
- `gclid`
- `fbclid`
- `referrer`
- `formPayload`
- `intakeOperationKeyHash`
- `intakeRequestHash`
- `intakeResponse`
- `instantQuoteId`
- `quoteEstimate`
- `quoteId`
- `createdAt`
- `updatedAt`

## media_assets

Schema export: `mediaAssets`

Columns (27):

- `id`
- `partnerAccountId`
- `storageProvider`
- `storageBucket`
- `originalObjectKey`
- `displayObjectKey`
- `thumbnailObjectKey`
- `source`
- `sourceKey`
- `status`
- `originalFilename`
- `contentType`
- `byteSize`
- `width`
- `height`
- `sha256`
- `uploadedByMemberId`
- `contactId`
- `sourceMessageId`
- `sourceMediaIndex`
- `sourceMetadata`
- `stagingExpiresAt`
- `readyAt`
- `processingError`
- `deletedAt`
- `createdAt`
- `updatedAt`

## media_job_analyses

Schema export: `mediaJobAnalyses`

Columns (24):

- `id`
- `contactId`
- `leadId`
- `instantQuoteId`
- `sourceChannel`
- `mediaCount`
- `videoCount`
- `visibleVolumeBucket`
- `visibleVolumeRange`
- `mergedVolumeBucket`
- `mergedVolumeRange`
- `visibleMattressCount`
- `visiblePaintCanCount`
- `visibleTireCount`
- `sceneGroupsJson`
- `statedScopeJson`
- `riskFlags`
- `missingViews`
- `confidence`
- `summary`
- `rawModelOutputJson`
- `source`
- `createdAt`
- `updatedAt`

## merge_suggestions

Schema export: `mergeSuggestions`

Columns (11):

- `id`
- `sourceContactId`
- `targetContactId`
- `status`
- `reason`
- `confidence`
- `meta`
- `reviewedBy`
- `reviewedAt`
- `createdAt`
- `updatedAt`

## message_delivery_events

Schema export: `messageDeliveryEvents`

Columns (6):

- `id`
- `messageId`
- `status`
- `detail`
- `provider`
- `occurredAt`

## meta_ads_insights_daily

Schema export: `metaAdsInsightsDaily`

Columns (19):

- `id`
- `accountId`
- `level`
- `entityId`
- `dateStart`
- `dateStop`
- `currency`
- `campaignId`
- `campaignName`
- `adsetId`
- `adsetName`
- `adId`
- `adName`
- `impressions`
- `clicks`
- `reach`
- `spend`
- `raw`
- `fetchedAt`

## mobile_expense_queue_health

Schema export: `mobileExpenseQueueHealth`

Columns (10):

- `id`
- `teamMemberId`
- `clientDeviceId`
- `queuedCount`
- `failedCount`
- `oldestQueuedAt`
- `clientReportedAt`
- `lastReportedAt`
- `createdAt`
- `updatedAt`

## mobile_offline_media_queue_health

Schema export: `mobileOfflineMediaQueueHealth`

Columns (10):

- `id`
- `teamMemberId`
- `clientDeviceId`
- `queuedCount`
- `failedCount`
- `oldestQueuedAt`
- `clientReportedAt`
- `lastReportedAt`
- `createdAt`
- `updatedAt`

## outbox_events

Schema export: `outboxEvents`

Columns (12):

- `id`
- `type`
- `payload`
- `attempts`
- `nextAttemptAt`
- `lastError`
- `createdAt`
- `processedAt`
- `quarantinedAt`
- `quarantinedBy`
- `quarantineReason`
- `quarantinedContactId`

## partner_access_applications

Schema export: `partnerAccessApplications`

Columns (33):

- `id`
- `identityHash`
- `email`
- `normalizedEmail`
- `name`
- `phone`
- `phoneE164`
- `companyName`
- `website`
- `partnerType`
- `serviceAreas`
- `requestedNeeds`
- `flowVersion`
- `emailVerificationChallengeId`
- `applicantSessionId`
- `companyResolutionChoice`
- `companyCandidateId`
- `requestedPartnerAccountId`
- `status`
- `applicantPartnerUserId`
- `bootstrapPartnerAccountId`
- `approvedPartnerAccountId`
- `reviewedByMemberId`
- `emailVerifiedAt`
- `termsAcceptedAt`
- `privacyAcceptedAt`
- `reviewNote`
- `applicantResponse`
- `reviewedAt`
- `submittedAt`
- `version`
- `createdAt`
- `updatedAt`

## partner_account_cancellation_policies

Schema export: `partnerAccountCancellationPolicies`

Columns (9):

- `partnerAccountId`
- `minimumNoticeMinutes`
- `directCancellationEnabled`
- `lateCancellationDisposition`
- `automaticFeeMinor`
- `revision`
- `lastChangedByTeamMemberId`
- `createdAt`
- `updatedAt`

## partner_account_cost_centers

Schema export: `partnerAccountCostCenters`

Columns (7):

- `id`
- `partnerAccountId`
- `code`
- `name`
- `active`
- `createdAt`
- `updatedAt`

## partner_account_domains

Schema export: `partnerAccountDomains`

Columns (12):

- `id`
- `partnerAccountId`
- `normalizedDomain`
- `status`
- `verificationMethod`
- `verificationEvidence`
- `verifiedByTeamMemberId`
- `verifiedAt`
- `revokedByTeamMemberId`
- `revokedAt`
- `createdAt`
- `updatedAt`

## partner_account_invitations

Schema export: `partnerAccountInvitations`

Columns (35):

- `id`
- `partnerAccountId`
- `email`
- `normalizedEmail`
- `inviteeName`
- `roleTemplateId`
- `roleTemplateVersion`
- `roleKey`
- `accessLevel`
- `persona`
- `status`
- `tokenHash`
- `generation`
- `version`
- `expiresAt`
- `invitedByMembershipId`
- `invitedByTeamMemberId`
- `acceptedByPartnerUserId`
- `acceptedMembershipId`
- `resumeMembershipId`
- `activatedAt`
- `revokedByMembershipId`
- `deliveryStatus`
- `deliveryOutboxEventId`
- `deliveryAttemptId`
- `deliveryProvider`
- `deliveryProviderMessageId`
- `deliveryDetail`
- `dispatchStartedAt`
- `sentAt`
- `acceptedAt`
- `revokedAt`
- `expiredAt`
- `createdAt`
- `updatedAt`

## partner_account_locations

Schema export: `partnerAccountLocations`

Columns (38):

- `id`
- `partnerAccountId`
- `propertyId`
- `siteName`
- `externalPropertyId`
- `addressLine1`
- `addressLine2`
- `city`
- `state`
- `postalCode`
- `timezone`
- `locale`
- `latitude`
- `longitude`
- `geocodeStatus`
- `serviceAreaStatus`
- `addressVerificationStatus`
- `addressVerificationProvider`
- `addressVerificationConfidence`
- `addressVerificationFeatureId`
- `addressVerificationSuggestion`
- `addressVerifiedAt`
- `accessInstructions`
- `parkingInstructions`
- `loadingInstructions`
- `accessSecretCiphertext`
- `accessSecretKeyVersion`
- `onSiteContact`
- `parentLocationId`
- `mergedIntoLocationId`
- `mergedAt`
- `mergedByMembershipId`
- `mergeReason`
- `active`
- `version`
- `createdByMembershipId`
- `createdAt`
- `updatedAt`

## partner_account_memberships

Schema export: `partnerAccountMemberships`

Columns (25):

- `id`
- `partnerAccountId`
- `partnerUserId`
- `roleTemplateId`
- `roleKey`
- `status`
- `capabilityGrants`
- `capabilityDenies`
- `persona`
- `accessLevel`
- `accessScope`
- `preferences`
- `isDefault`
- `invitedByPartnerUserId`
- `invitedAt`
- `acceptedAt`
- `suspendedAt`
- `removedAt`
- `migrationReviewStatus`
- `migrationLegacyRoleKey`
- `migrationReviewedByTeamMemberId`
- `migrationReviewedAt`
- `migrationReviewNote`
- `createdAt`
- `updatedAt`

## partner_account_merge_cases

Schema export: `partnerAccountMergeCases`

Columns (18):

- `id`
- `sourcePartnerAccountId`
- `targetPartnerAccountId`
- `state`
- `reason`
- `conflictSummary`
- `preflightHash`
- `sourceLifecycleRevision`
- `targetLifecycleRevision`
- `requestedByTeamMemberId`
- `completedByTeamMemberId`
- `completedAt`
- `cancelledByTeamMemberId`
- `cancelledAt`
- `resolutionNote`
- `version`
- `createdAt`
- `updatedAt`

## partner_account_scheduling_policies

Schema export: `partnerAccountSchedulingPolicies`

Columns (9):

- `partnerAccountId`
- `minimumNoticeMinutes`
- `minimumCalendarLeadDays`
- `maximumBookingHorizonDays`
- `instantConfirmationEnabled`
- `revision`
- `lastChangedByTeamMemberId`
- `createdAt`
- `updatedAt`

## partner_account_service_agreements

Schema export: `partnerAccountServiceAgreements`

Columns (15):

- `partnerAccountId`
- `active`
- `agreementLabel`
- `currency`
- `effectiveFrom`
- `effectiveTo`
- `inclusions`
- `exclusions`
- `quoteRules`
- `serviceEntitlements`
- `agreementDocumentId`
- `revision`
- `updatedByTeamMemberId`
- `createdAt`
- `updatedAt`

## partner_accounts

Schema export: `partnerAccounts`

Columns (61):

- `id`
- `name`
- `normalizedName`
- `domain`
- `website`
- `segment`
- `subsegment`
- `status`
- `source`
- `sourceCampaign`
- `sourceListName`
- `externalCompanyId`
- `externalLocationId`
- `importedStatus`
- `outreachPriority`
- `importedNextAction`
- `importedEmailStatus`
- `city`
- `state`
- `ownerMemberId`
- `portalFit`
- `fitScore`
- `lastTouchAt`
- `nextTouchAt`
- `lastDisposition`
- `notes`
- `aiAccountBrief`
- `portalContactId`
- `portalAccessEnabled`
- `portalSetupStatus`
- `portalRateRevision`
- `portalRateDraft`
- `portalRatesVisible`
- `portalWorkflowConfig`
- `portalWorkflowRevision`
- `portalLifecycleStatus`
- `portalLifecycleRevision`
- `portalLifecycleChangedAt`
- `portalLifecycleChangedByTeamMemberId`
- `portalLifecycleReason`
- `portalLifecyclePriorAccessEnabled`
- `mergedIntoPartnerAccountId`
- `profileRevision`
- `serviceContactName`
- `serviceContactEmail`
- `serviceContactPhoneE164`
- `billingContactName`
- `billingContactEmail`
- `billingContactPhoneE164`
- `billingAddressLine1`
- `billingAddressLine2`
- `billingAddressCity`
- `billingAddressState`
- `billingAddressPostalCode`
- `billingAddressCountry`
- `defaultPoNumber`
- `costCenterGuidance`
- `defaultPartnerLocationId`
- `locationDirectoryVersion`
- `createdAt`
- `updatedAt`

## partner_allocation_reconciliations

Schema export: `partnerAllocationReconciliations`

Columns (11):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `paymentId`
- `actorId`
- `reason`
- `evidenceReference`
- `beforeSnapshot`
- `afterSnapshot`
- `correlationId`
- `createdAt`

## partner_applicant_sessions

Schema export: `partnerApplicantSessions`

Columns (14):

- `id`
- `verificationChallengeId`
- `normalizedEmail`
- `sessionHash`
- `applicationId`
- `draftPayload`
- `draftVersion`
- `ip`
- `userAgent`
- `expiresAt`
- `revokedAt`
- `createdAt`
- `lastSeenAt`
- `updatedAt`

## partner_approval_decisions

Schema export: `partnerApprovalDecisions`

Columns (8):

- `id`
- `approvalRequestId`
- `partnerAccountId`
- `decidedByMembershipId`
- `decision`
- `reason`
- `decisionSnapshot`
- `createdAt`

## partner_approval_requests

Schema export: `partnerApprovalRequests`

Columns (15):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `bookingDraftId`
- `requestedByMembershipId`
- `state`
- `ruleSnapshot`
- `requestSnapshot`
- `requiredDecisionCount`
- `approvalHoldId`
- `expiresAt`
- `resolvedAt`
- `revision`
- `createdAt`
- `updatedAt`

## partner_approval_rules

Schema export: `partnerApprovalRules`

Columns (14):

- `id`
- `partnerAccountId`
- `name`
- `conditions`
- `requiredApproverRoleKeys`
- `requiredApproverCapabilities`
- `requiredDecisionCount`
- `active`
- `version`
- `createdByMembershipId`
- `createdByTeamMemberId`
- `updatedByTeamMemberId`
- `createdAt`
- `updatedAt`

## partner_auth_challenges

Schema export: `partnerAuthChallenges`

Columns (31):

- `id`
- `purpose`
- `status`
- `normalizedEmail`
- `tokenHash`
- `generation`
- `partnerUserId`
- `partnerAccountId`
- `partnerMembershipId`
- `applicationId`
- `invitationId`
- `invitationGeneration`
- `securityVersionSnapshot`
- `requestedIp`
- `requestedUserAgent`
- `consumedIp`
- `consumedUserAgent`
- `expiresAt`
- `consumedAt`
- `revokedAt`
- `expiredAt`
- `deliveryStatus`
- `deliveryOutboxEventId`
- `deliveryAttemptId`
- `deliveryProvider`
- `deliveryProviderMessageId`
- `deliveryDetail`
- `dispatchStartedAt`
- `sentAt`
- `createdAt`
- `updatedAt`

## partner_auth_transactions

Schema export: `partnerAuthTransactions`

Columns (16):

- `id`
- `partnerUserId`
- `partnerAccountId`
- `partnerMembershipId`
- `tokenHash`
- `purpose`
- `sourceAuthChallengeId`
- `securityVersion`
- `rememberMe`
- `requestedIp`
- `requestedUserAgent`
- `attemptCount`
- `expiresAt`
- `consumedAt`
- `completedSessionId`
- `createdAt`

## partner_billing_dispute_requests

Schema export: `partnerBillingDisputeRequests`

Columns (20):

- `id`
- `partnerAccountId`
- `partnerInvoiceId`
- `partnerBookingId`
- `requestedByMembershipId`
- `conversationThreadId`
- `threadScope`
- `category`
- `reason`
- `requestSnapshot`
- `operationKeyHash`
- `requestHash`
- `state`
- `revision`
- `resolvedByTeamMemberId`
- `resolutionReason`
- `resolutionSnapshot`
- `resolvedAt`
- `createdAt`
- `updatedAt`

## partner_billing_document_operations

Schema export: `partnerBillingDocumentOperations`

Columns (13):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `partnerInvoiceId`
- `sourceKey`
- `documentType`
- `version`
- `snapshot`
- `snapshotHash`
- `status`
- `documentId`
- `createdAt`
- `completedAt`

## partner_billing_refund_requests

Schema export: `partnerBillingRefundRequests`

Columns (11):

- `id`
- `partnerAccountId`
- `partnerInvoiceId`
- `paymentId`
- `amountCents`
- `reason`
- `status`
- `providerRefundId`
- `requestedBy`
- `createdAt`
- `updatedAt`

## partner_booking_drafts

Schema export: `partnerBookingDrafts`

Columns (28):

- `id`
- `modelVersion`
- `serviceLines`
- `partnerAccountId`
- `createdByMembershipId`
- `rescheduleFromPartnerBookingId`
- `additionalServiceFromPartnerBookingId`
- `locationId`
- `serviceKey`
- `tierKey`
- `selectedAddOns`
- `state`
- `scope`
- `description`
- `crewInstructions`
- `accessDetails`
- `onSiteContact`
- `proofRequirements`
- `commercial`
- `preferredWindows`
- `scheduleAssistancePreference`
- `reviewReasons`
- `validation`
- `revision`
- `expiresAt`
- `submittedAt`
- `createdAt`
- `updatedAt`

## partner_booking_service_lines

Schema export: `partnerBookingServiceLines`

Columns (17):

- `id`
- `partnerBookingId`
- `partnerAccountId`
- `position`
- `serviceLabel`
- `status`
- `completedAt`
- `serviceKey`
- `description`
- `scope`
- `selectedAddOns`
- `proofRequirements`
- `rateSnapshot`
- `quotedAmountCents`
- `priceDescription`
- `pricingSnapshot`
- `createdAt`

## partner_booking_visit_lines

Schema export: `partnerBookingVisitLines`

Columns (4):

- `partnerAccountId`
- `partnerBookingId`
- `visitId`
- `serviceLineId`

## partner_booking_visits

Schema export: `partnerBookingVisits`

Columns (10):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `appointmentId`
- `status`
- `minimumAmountCents`
- `rateSnapshot`
- `version`
- `createdAt`
- `updatedAt`

## partner_bookings

Schema export: `partnerBookings`

Columns (42):

- `id`
- `orgContactId`
- `partnerAccountId`
- `bookingDraftId`
- `additionalServiceFromPartnerBookingId`
- `requestedByMembershipId`
- `partnerUserId`
- `propertyId`
- `appointmentId`
- `modelVersion`
- `quotedTotalCents`
- `finalTotalCents`
- `pricingVersion`
- `pricedAt`
- `pricedByTeamMemberId`
- `serviceKey`
- `tierKey`
- `amountCents`
- `currency`
- `publicStatus`
- `confirmationMode`
- `arrivalWindowStartAt`
- `arrivalWindowEndAt`
- `scopeSnapshot`
- `rateSnapshot`
- `addOnsSnapshot`
- `proofRequirementsSnapshot`
- `poNumber`
- `costCenter`
- `projectReference`
- `billingContactSnapshot`
- `requestedReviewReasons`
- `createOperationKeyHash`
- `createRequestHash`
- `cancelOperationKeyHash`
- `cancelRequestHash`
- `rescheduleOperationKeyHash`
- `rescheduleRequestHash`
- `version`
- `canceledAt`
- `updatedAt`
- `createdAt`

## partner_bulk_import_rows

Schema export: `partnerBulkImportRows`

Columns (13):

- `id`
- `partnerAccountId`
- `partnerBulkImportId`
- `rowNumber`
- `normalizedData`
- `rawData`
- `processingStartedAt`
- `processingAttempts`
- `errors`
- `state`
- `partnerBookingId`
- `bookingDraftId`
- `createdAt`

## partner_bulk_imports

Schema export: `partnerBulkImports`

Columns (16):

- `id`
- `partnerAccountId`
- `createdByMembershipId`
- `sourceFilename`
- `sourceSha256`
- `state`
- `dryRun`
- `rowCount`
- `validCount`
- `errorCount`
- `correctionDocumentId`
- `createOperationKeyHash`
- `createRequestHash`
- `createdAt`
- `completedAt`
- `updatedAt`

## partner_cancellation_request_reconciliation_cases

Schema export: `partnerCancellationRequestReconciliationCases`

Columns (9):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `legacyOperationKeyHash`
- `legacyRequestHash`
- `reasonCode`
- `evidenceSnapshot`
- `state`
- `createdAt`

## partner_cancellation_requests

Schema export: `partnerCancellationRequests`

Columns (15):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `requestedByMembershipId`
- `state`
- `reason`
- `requestSnapshot`
- `operationKeyHash`
- `requestHash`
- `revision`
- `resolvedByTeamMemberId`
- `resolutionReason`
- `resolvedAt`
- `createdAt`
- `updatedAt`

## partner_capability_definitions

Schema export: `partnerCapabilityDefinitions`

Columns (9):

- `key`
- `label`
- `description`
- `category`
- `risk`
- `assignable`
- `active`
- `createdAt`
- `updatedAt`

## partner_company_join_requests

Schema export: `partnerCompanyJoinRequests`

Columns (15):

- `id`
- `partnerUserId`
- `partnerAccountId`
- `requestedRoleKey`
- `message`
- `status`
- `reviewedByPartnerUserId`
- `reviewedByMemberId`
- `resolvedMembershipId`
- `reviewNote`
- `reviewedAt`
- `requestedAt`
- `version`
- `createdAt`
- `updatedAt`

## partner_document_access_logs

Schema export: `partnerDocumentAccessLogs`

Columns (10):

- `id`
- `partnerAccountId`
- `partnerDocumentId`
- `actorType`
- `actorMembershipId`
- `actorTeamMemberId`
- `shareLinkId`
- `action`
- `correlationId`
- `createdAt`

## partner_documents

Schema export: `partnerDocuments`

Columns (14):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `documentType`
- `version`
- `filename`
- `contentType`
- `byteSize`
- `storageBucket`
- `storageObjectKey`
- `sha256`
- `metadata`
- `generatedAt`
- `createdAt`

## partner_draft_media

Schema export: `partnerDraftMedia`

Columns (11):

- `id`
- `partnerAccountId`
- `bookingDraftId`
- `mediaAssetId`
- `category`
- `caption`
- `sortOrder`
- `uploadedByMembershipId`
- `deletedAt`
- `purgeEligibleAt`
- `createdAt`

## partner_evidence_requirements

Schema export: `partnerEvidenceRequirements`

Columns (11):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `category`
- `minimumCount`
- `required`
- `source`
- `overrideReason`
- `overriddenByTeamMemberId`
- `createdAt`
- `updatedAt`

## partner_invitation_cost_center_scopes

Schema export: `partnerInvitationCostCenterScopes`

Columns (4):

- `invitationId`
- `partnerAccountId`
- `costCenterId`
- `createdAt`

## partner_invitation_location_scopes

Schema export: `partnerInvitationLocationScopes`

Columns (4):

- `invitationId`
- `partnerAccountId`
- `locationId`
- `createdAt`

## partner_invite_operations

Schema export: `partnerInviteOperations`

Columns (39):

- `id`
- `orgContactId`
- `partnerUserId`
- `operationKind`
- `initiatorType`
- `semanticHash`
- `requestedChannels`
- `correlationId`
- `idempotencyKeyHash`
- `actorMemberId`
- `actorRole`
- `actorLabel`
- `sessionId`
- `authMethod`
- `state`
- `version`
- `providerRequestKey`
- `providerOperationIds`
- `providerEvidence`
- `requestedAuditEventId`
- `dispatchAuditEventId`
- `terminalAuditEventId`
- `failureCode`
- `failureDetail`
- `retryable`
- `quarantinedAt`
- `quarantinedBy`
- `quarantineReason`
- `requestedAt`
- `dispatchedAt`
- `completedAt`
- `reconciliationRequiredAt`
- `resolution`
- `resolutionEvidence`
- `resolvedAt`
- `resolvedBy`
- `resolutionAuditEventId`
- `createdAt`
- `updatedAt`

## partner_invoice_credits

Schema export: `partnerInvoiceCredits`

Columns (8):

- `id`
- `partnerAccountId`
- `partnerInvoiceId`
- `amountCents`
- `reason`
- `kind`
- `createdBy`
- `createdAt`

## partner_invoice_lines

Schema export: `partnerInvoiceLines`

Columns (11):

- `id`
- `partnerInvoiceId`
- `lineNumber`
- `kind`
- `description`
- `quantity`
- `unitAmountCents`
- `lineTotalCents`
- `taxCode`
- `metadata`
- `createdAt`

## partner_invoices

Schema export: `partnerInvoices`

Columns (30):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `invoiceNumber`
- `status`
- `currency`
- `subtotalCents`
- `taxCents`
- `discountCents`
- `depositCents`
- `totalCents`
- `paidCents`
- `creditedCents`
- `balanceCents`
- `poNumber`
- `costCenter`
- `billingContact`
- `terms`
- `dueDate`
- `issuedAt`
- `paidAt`
- `voidedAt`
- `provider`
- `providerInvoiceId`
- `providerOrderId`
- `hostedPaymentUrl`
- `documentId`
- `version`
- `createdAt`
- `updatedAt`

## partner_job_change_orders

Schema export: `partnerJobChangeOrders`

Columns (17):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `partnerJobChangeRequestId`
- `partnerQuoteId`
- `quoteId`
- `quoteVersionId`
- `state`
- `offerSnapshot`
- `baseBookingRevision`
- `revision`
- `offeredByTeamMemberId`
- `quoteResponseId`
- `resolutionSnapshot`
- `resolvedAt`
- `createdAt`
- `updatedAt`

## partner_job_change_requests

Schema export: `partnerJobChangeRequests`

Columns (18):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `requestedByMembershipId`
- `state`
- `reason`
- `proposedChanges`
- `requestSnapshot`
- `baseBookingRevision`
- `operationKeyHash`
- `requestHash`
- `revision`
- `resolvedByTeamMemberId`
- `resolutionReason`
- `resolutionSnapshot`
- `resolvedAt`
- `createdAt`
- `updatedAt`

## partner_job_comments

Schema export: `partnerJobComments`

Columns (11):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `authorMembershipId`
- `authorTeamMemberId`
- `body`
- `portalVisible`
- `revision`
- `deletedAt`
- `createdAt`
- `updatedAt`

## partner_job_events

Schema export: `partnerJobEvents`

Columns (12):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `eventType`
- `publicLabel`
- `publicDetail`
- `effectiveAt`
- `actorType`
- `actorMembershipId`
- `actorTeamMemberId`
- `metadata`
- `createdAt`

## partner_job_evidence

Schema export: `partnerJobEvidence`

Columns (12):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `mediaAssetId`
- `category`
- `caption`
- `sortOrder`
- `uploadedByMembershipId`
- `uploadedByTeamMemberId`
- `deletedAt`
- `purgeEligibleAt`
- `createdAt`

## partner_location_address_reviews

Schema export: `partnerLocationAddressReviews`

Columns (16):

- `id`
- `partnerAccountId`
- `locationId`
- `requestedByMembershipId`
- `state`
- `reasonCode`
- `enteredAddress`
- `providerSuggestion`
- `providerConfidence`
- `duplicateCandidates`
- `reviewedByTeamMemberId`
- `resolutionNote`
- `resolvedAt`
- `version`
- `createdAt`
- `updatedAt`

## partner_location_favorites

Schema export: `partnerLocationFavorites`

Columns (4):

- `partnerAccountId`
- `membershipId`
- `locationId`
- `createdAt`

## partner_location_imports

Schema export: `partnerLocationImports`

Columns (21):

- `id`
- `partnerAccountId`
- `requestedByMembershipId`
- `committedByMembershipId`
- `dryRunIdempotencyKeyHash`
- `commitIdempotencyKeyHash`
- `requestHash`
- `commitRequestHash`
- `state`
- `directoryVersion`
- `rowCount`
- `validRowCount`
- `invalidRowCount`
- `normalizedRows`
- `rowResults`
- `expiresAt`
- `purgeAfter`
- `committedAt`
- `revision`
- `createdAt`
- `updatedAt`

## partner_login_tokens

Schema export: `partnerLoginTokens`

Columns (8):

- `id`
- `partnerUserId`
- `tokenHash`
- `requestedIp`
- `userAgent`
- `expiresAt`
- `usedAt`
- `createdAt`

## partner_media_mutation_operations

Schema export: `partnerMediaMutationOperations`

Columns (17):

- `id`
- `partnerAccountId`
- `actorMembershipId`
- `action`
- `idempotencyKeyHash`
- `requestHash`
- `parentKind`
- `parentId`
- `associationId`
- `status`
- `claimToken`
- `claimExpiresAt`
- `attemptCount`
- `lastErrorCode`
- `completedAt`
- `createdAt`
- `updatedAt`

## partner_membership_cost_center_scopes

Schema export: `partnerMembershipCostCenterScopes`

Columns (4):

- `membershipId`
- `partnerAccountId`
- `costCenterId`
- `createdAt`

## partner_membership_location_scopes

Schema export: `partnerMembershipLocationScopes`

Columns (4):

- `membershipId`
- `partnerAccountId`
- `locationId`
- `createdAt`

## partner_mfa_enrollment_challenges

Schema export: `partnerMfaEnrollmentChallenges`

Columns (9):

- `id`
- `partnerUserId`
- `authTransactionId`
- `secretCiphertext`
- `secretKeyVersion`
- `attemptCount`
- `expiresAt`
- `consumedAt`
- `createdAt`

## partner_mfa_methods

Schema export: `partnerMfaMethods`

Columns (15):

- `id`
- `partnerUserId`
- `methodType`
- `label`
- `credentialIdHash`
- `credentialReference`
- `totpSecretCiphertext`
- `totpSecretKeyVersion`
- `lastTotpCounter`
- `enabled`
- `enrolledAt`
- `lastUsedAt`
- `disabledAt`
- `createdAt`
- `updatedAt`

## partner_mfa_recovery_codes

Schema export: `partnerMfaRecoveryCodes`

Columns (6):

- `id`
- `methodId`
- `codeHash`
- `keyVersion`
- `usedAt`
- `createdAt`

## partner_notification_deliveries

Schema export: `partnerNotificationDeliveries`

Columns (30):

- `id`
- `partnerAccountId`
- `membershipId`
- `partnerBookingId`
- `partnerNotificationId`
- `eventType`
- `preferenceEventKey`
- `channel`
- `state`
- `urgency`
- `dedupeKeyHash`
- `title`
- `body`
- `actionPath`
- `endpointId`
- `providerRequestKey`
- `outboxEventId`
- `scheduledFor`
- `attemptCount`
- `dispatchAttemptId`
- `dispatchStartedAt`
- `provider`
- `providerMessageId`
- `providerIdempotencySupported`
- `deliveryCertainty`
- `detail`
- `correlationId`
- `acceptedAt`
- `createdAt`
- `updatedAt`

## partner_notification_endpoint_challenges

Schema export: `partnerNotificationEndpointChallenges`

Columns (23):

- `id`
- `endpointId`
- `partnerUserId`
- `partnerAccountId`
- `membershipId`
- `codeHash`
- `generation`
- `status`
- `attemptCount`
- `deliveryStatus`
- `deliveryOutboxEventId`
- `deliveryAttemptId`
- `deliveryProvider`
- `deliveryProviderMessageId`
- `deliveryDetail`
- `dispatchStartedAt`
- `sentAt`
- `expiresAt`
- `consumedAt`
- `revokedAt`
- `expiredAt`
- `createdAt`
- `updatedAt`

## partner_notification_endpoints

Schema export: `partnerNotificationEndpoints`

Columns (12):

- `id`
- `partnerUserId`
- `channel`
- `normalizedDestination`
- `status`
- `verifiedAt`
- `consentAt`
- `consentSource`
- `consentVersion`
- `revokedAt`
- `createdAt`
- `updatedAt`

## partner_notification_preferences

Schema export: `partnerNotificationPreferences`

Columns (17):

- `id`
- `partnerAccountId`
- `membershipId`
- `eventKey`
- `inAppEnabled`
- `emailEnabled`
- `smsEnabled`
- `smsVerifiedOptInAt`
- `smsVerifiedPhoneE164`
- `smsVerifiedEndpointId`
- `smsOptInSource`
- `smsConsentVersion`
- `quietHoursStart`
- `quietHoursEnd`
- `timezone`
- `createdAt`
- `updatedAt`

## partner_notifications

Schema export: `partnerNotifications`

Columns (10):

- `id`
- `partnerAccountId`
- `membershipId`
- `partnerBookingId`
- `eventKey`
- `title`
- `body`
- `actionPath`
- `readAt`
- `createdAt`

## partner_owner_alert_groups

Schema export: `partnerOwnerAlertGroups`

Columns (11):

- `stage`
- `id`
- `partnerAccountId`
- `bulkImportId`
- `ownerTeamMemberId`
- `settingsRevision`
- `memberCount`
- `openedAt`
- `initialAcceptedAt`
- `reminderDueAt`
- `createdAt`

## partner_owner_alert_members

Schema export: `partnerOwnerAlertMembers`

Columns (6):

- `stage`
- `groupId`
- `partnerAccountId`
- `partnerBookingId`
- `ownerTeamMemberId`
- `openedAt`

## partner_owner_alert_settings

Schema export: `partnerOwnerAlertSettings`

Columns (7):

- `id`
- `enabled`
- `ownerTeamMemberId`
- `phoneSnapshot`
- `enabledSince`
- `revision`
- `updatedAt`

## partner_owner_request_opens

Schema export: `partnerOwnerRequestOpens`

Columns (5):

- `stage`
- `partnerAccountId`
- `partnerBookingId`
- `ownerTeamMemberId`
- `openedAt`

## partner_payment_allocations

Schema export: `partnerPaymentAllocations`

Columns (9):

- `id`
- `partnerAccountId`
- `partnerInvoiceId`
- `paymentId`
- `amountCents`
- `state`
- `allocatedAt`
- `reversedAt`
- `createdAt`

## partner_proof_packages

Schema export: `partnerProofPackages`

Columns (10):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `version`
- `manifest`
- `manifestSha256`
- `pdfDocumentId`
- `zipDocumentId`
- `generatedAt`
- `createdAt`

## partner_proof_share_links

Schema export: `partnerProofShareLinks`

Columns (11):

- `id`
- `partnerAccountId`
- `proofPackageId`
- `tokenHash`
- `expiresAt`
- `revokedAt`
- `revokedByMembershipId`
- `lastAccessedAt`
- `accessCount`
- `createdByMembershipId`
- `createdAt`

## partner_quotes

Schema export: `partnerQuotes`

Columns (26):

- `id`
- `authority`
- `partnerAccountId`
- `quoteId`
- `partnerBookingId`
- `bookingDraftId`
- `partnerAccountLocationId`
- `quoteNumber`
- `version`
- `status`
- `currency`
- `subtotalCents`
- `taxCents`
- `discountCents`
- `totalCents`
- `lines`
- `terms`
- `expiresAt`
- `sentAt`
- `acceptedAt`
- `declinedAt`
- `supersededAt`
- `documentId`
- `createdByTeamMemberId`
- `createdAt`
- `updatedAt`

## partner_rate_add_on_items

Schema export: `partnerRateAddOnItems`

Columns (6):

- `id`
- `rateCardId`
- `serviceKey`
- `addOnKey`
- `unitAmountCents`
- `createdAt`

## partner_rate_card_version_items

Schema export: `partnerRateCardVersionItems`

Columns (8):

- `id`
- `partnerRateCardVersionId`
- `serviceKey`
- `tierKey`
- `label`
- `amountCents`
- `pricingRules`
- `createdAt`

## partner_rate_card_versions

Schema export: `partnerRateCardVersions`

Columns (14):

- `id`
- `partnerAccountId`
- `version`
- `currency`
- `visitMinimumAmount`
- `quoteRequiredServiceKeys`
- `pricingModelVersion`
- `portalVisible`
- `status`
- `effectiveFrom`
- `effectiveTo`
- `supersedesId`
- `createdByTeamMemberId`
- `createdAt`

## partner_rate_cards

Schema export: `partnerRateCards`

Columns (10):

- `id`
- `orgContactId`
- `partnerAccountId`
- `currency`
- `active`
- `version`
- `effectiveFrom`
- `effectiveTo`
- `createdAt`
- `updatedAt`

## partner_rate_items

Schema export: `partnerRateItems`

Columns (8):

- `id`
- `rateCardId`
- `serviceKey`
- `tierKey`
- `label`
- `amountCents`
- `sortOrder`
- `createdAt`

## partner_recurring_occurrences

Schema export: `partnerRecurringOccurrences`

Columns (12):

- `id`
- `partnerAccountId`
- `recurringSeriesId`
- `localDate`
- `state`
- `partnerBookingId`
- `bookingDraftId`
- `evaluation`
- `failureCode`
- `evaluatedAt`
- `createdAt`
- `updatedAt`

## partner_recurring_series

Schema export: `partnerRecurringSeries`

Columns (19):

- `id`
- `partnerAccountId`
- `templateId`
- `locationId`
- `name`
- `recurrenceRule`
- `templateSnapshot`
- `occurrencesExpandedAt`
- `timezone`
- `preferredWindowStart`
- `startsOn`
- `endsOn`
- `state`
- `revision`
- `createdByMembershipId`
- `createOperationKeyHash`
- `createRequestHash`
- `createdAt`
- `updatedAt`

## partner_refund_allocations

Schema export: `partnerRefundAllocations`

Columns (6):

- `id`
- `partnerAccountId`
- `partnerInvoiceId`
- `refundId`
- `jobAmountCents`
- `updatedAt`

## partner_reschedule_requests

Schema export: `partnerRescheduleRequests`

Columns (25):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `bookingDraftId`
- `partnerBookingVisitId`
- `state`
- `requestKind`
- `preferredWindows`
- `withdrawalOperationKeyHash`
- `withdrawalRequestHash`
- `proposedStartAt`
- `requestedArrivalStartAt`
- `requestedArrivalEndAt`
- `previousStartAt`
- `previousArrivalStartAt`
- `previousArrivalEndAt`
- `reviewReasons`
- `operationKeyHash`
- `requestHash`
- `createdByMembershipId`
- `resolvedByTeamMemberId`
- `resolutionReason`
- `resolvedAt`
- `createdAt`
- `updatedAt`

## partner_role_templates

Schema export: `partnerRoleTemplates`

Columns (12):

- `id`
- `partnerAccountId`
- `key`
- `name`
- `description`
- `capabilities`
- `isSystem`
- `active`
- `version`
- `createdByPartnerUserId`
- `createdAt`
- `updatedAt`

## partner_schedule_assistance_requests

Schema export: `partnerScheduleAssistanceRequests`

Columns (16):

- `id`
- `partnerAccountId`
- `partnerBookingId`
- `bookingDraftId`
- `requestedByMembershipId`
- `preference`
- `state`
- `preferredWindowsSnapshot`
- `operationKeyHash`
- `requestHash`
- `revision`
- `resolvedByTeamMemberId`
- `resolutionNote`
- `resolvedAt`
- `createdAt`
- `updatedAt`

## partner_scheduling_profile_resource_requirements

Schema export: `partnerSchedulingProfileResourceRequirements`

Columns (9):

- `id`
- `schedulingProfileId`
- `resourceKind`
- `quantity`
- `capacityUnits`
- `requiredSkillKeys`
- `source`
- `createdAt`
- `updatedAt`

## partner_scheduling_profiles

Schema export: `partnerSchedulingProfiles`

Columns (18):

- `id`
- `serviceKey`
- `version`
- `durationMinutes`
- `travelBufferMinutes`
- `capacityPoolKey`
- `capacityUnits`
- `supportedTerritories`
- `requiredScopeFields`
- `pricingEligibility`
- `proofDefaults`
- `automaticReviewRules`
- `instantConfirmationEnabled`
- `active`
- `effectiveFrom`
- `effectiveTo`
- `createdAt`
- `updatedAt`

## partner_service_add_on_options

Schema export: `partnerServiceAddOnOptions`

Columns (11):

- `id`
- `serviceKey`
- `addOnKey`
- `minimumQuantity`
- `maximumQuantity`
- `instantConfirmationMaxQuantity`
- `requiresReview`
- `active`
- `sortOrder`
- `createdAt`
- `updatedAt`

## partner_service_add_ons

Schema export: `partnerServiceAddOns`

Columns (7):

- `key`
- `label`
- `description`
- `unitLabel`
- `active`
- `createdAt`
- `updatedAt`

## partner_service_catalog

Schema export: `partnerServiceCatalog`

Columns (10):

- `key`
- `label`
- `description`
- `active`
- `instantBookable`
- `requiredScopeFields`
- `defaultProofRequirements`
- `automaticReviewRules`
- `createdAt`
- `updatedAt`

## partner_service_templates

Schema export: `partnerServiceTemplates`

Columns (13):

- `id`
- `partnerAccountId`
- `name`
- `serviceKey`
- `locationId`
- `templateData`
- `active`
- `version`
- `createdByMembershipId`
- `createOperationKeyHash`
- `createRequestHash`
- `createdAt`
- `updatedAt`

## partner_sessions

Schema export: `partnerSessions`

Columns (18):

- `id`
- `partnerUserId`
- `activePartnerAccountId`
- `activeMembershipId`
- `sessionHash`
- `authMethod`
- `assuranceLevel`
- `mfaVerifiedAt`
- `securityVersion`
- `deviceName`
- `accountSelectedAt`
- `rotatedFromSessionId`
- `ip`
- `userAgent`
- `expiresAt`
- `revokedAt`
- `createdAt`
- `lastSeenAt`

## partner_statements

Schema export: `partnerStatements`

Columns (15):

- `id`
- `partnerAccountId`
- `periodStart`
- `periodEnd`
- `currency`
- `revision`
- `openingBalanceCents`
- `invoiceCents`
- `paymentCents`
- `refundCents`
- `creditCents`
- `closingBalanceCents`
- `documentId`
- `generatedAt`
- `createdAt`

## partner_users

Schema export: `partnerUsers`

Columns (18):

- `id`
- `orgContactId`
- `email`
- `normalizedEmail`
- `phone`
- `phoneE164`
- `name`
- `active`
- `identityStatus`
- `emailVerifiedAt`
- `passwordHash`
- `passwordHashVersion`
- `passwordSetAt`
- `mfaRequired`
- `mfaEnrolledAt`
- `securityVersion`
- `createdAt`
- `updatedAt`

## payment_attempts

Schema export: `paymentAttempts`

Columns (27):

- `id`
- `partnerBookingId`
- `partnerAccountId`
- `quoteId`
- `quoteVersionId`
- `quoteResponseId`
- `appointmentHoldId`
- `quotePaymentKind`
- `appointmentId`
- `provider`
- `clientRequestId`
- `status`
- `requestedJobAmountCents`
- `currency`
- `providerOrderId`
- `providerPaymentId`
- `squareLocationId`
- `initiatedByMemberId`
- `returnNonceHash`
- `returnStateExpiresAt`
- `expiresAt`
- `resolvedAt`
- `errorCode`
- `errorMessage`
- `metadata`
- `createdAt`
- `updatedAt`

## payment_provider_events

Schema export: `paymentProviderEvents`

Columns (11):

- `id`
- `provider`
- `providerEventId`
- `eventType`
- `processingStatus`
- `paymentId`
- `paymentAttemptId`
- `payload`
- `receivedAt`
- `processedAt`
- `error`

## payment_refunds

Schema export: `paymentRefunds`

Columns (16):

- `id`
- `paymentId`
- `provider`
- `providerRefundId`
- `amountCents`
- `jobAmountCents`
- `tipCents`
- `currency`
- `canonicalStatus`
- `providerStatus`
- `reason`
- `metadata`
- `providerCreatedAt`
- `refundedAt`
- `createdAt`
- `updatedAt`

## payments

Schema export: `payments`

Columns (37):

- `id`
- `partnerBookingId`
- `partnerAccountId`
- `quoteId`
- `quoteVersionId`
- `quoteResponseId`
- `quotePaymentKind`
- `stripeChargeId`
- `provider`
- `providerPaymentId`
- `providerOrderId`
- `paymentAttemptId`
- `amount`
- `jobAmountCents`
- `tipCents`
- `totalAmountCents`
- `refundedAmountCents`
- `currency`
- `status`
- `canonicalStatus`
- `providerStatus`
- `method`
- `tenderType`
- `entryMethod`
- `cardBrand`
- `last4`
- `receiptUrl`
- `squareLocationId`
- `initiatedByMemberId`
- `legacySource`
- `metadata`
- `appointmentId`
- `createdAt`
- `updatedAt`
- `providerCreatedAt`
- `paidAt`
- `capturedAt`

## payout_run_adjustments

Schema export: `payoutRunAdjustments`

Columns (9):

- `id`
- `payoutRunId`
- `memberId`
- `kind`
- `amountCents`
- `note`
- `expenseId`
- `createdBy`
- `createdAt`

## payout_run_lines

Schema export: `payoutRunLines`

Columns (10):

- `id`
- `payoutRunId`
- `memberId`
- `salesCents`
- `marketingCents`
- `crewCents`
- `adjustmentsCents`
- `totalCents`
- `laborDetails`
- `createdAt`

## payout_runs

Schema export: `payoutRuns`

Columns (14):

- `id`
- `timezone`
- `periodStart`
- `periodEnd`
- `scheduledPayoutAt`
- `periodCanonical`
- `status`
- `createdBy`
- `createdAt`
- `updatedAt`
- `lockedAt`
- `paidAt`
- `reportHtml`
- `reportGeneratedAt`

## plaid_accounts

Schema export: `plaidAccounts`

Columns (13):

- `id`
- `itemId`
- `accountId`
- `name`
- `officialName`
- `mask`
- `type`
- `subtype`
- `isoCurrencyCode`
- `available`
- `current`
- `createdAt`
- `updatedAt`

## plaid_items

Schema export: `plaidItems`

Columns (8):

- `id`
- `itemId`
- `accessToken`
- `institutionId`
- `institutionName`
- `cursor`
- `createdAt`
- `updatedAt`

## plaid_transactions

Schema export: `plaidTransactions`

Columns (13):

- `id`
- `accountId`
- `transactionId`
- `name`
- `merchantName`
- `amount`
- `isoCurrencyCode`
- `date`
- `pending`
- `category`
- `raw`
- `createdAt`
- `updatedAt`

## policy_settings

Schema export: `policySettings`

Columns (5):

- `key`
- `value`
- `updatedBy`
- `createdAt`
- `updatedAt`

## properties

Schema export: `properties`

Columns (13):

- `id`
- `contactId`
- `addressKey`
- `addressLine1`
- `addressLine2`
- `city`
- `state`
- `postalCode`
- `lat`
- `lng`
- `gated`
- `createdAt`
- `updatedAt`

## provider_health

Schema export: `providerHealth`

Columns (5):

- `provider`
- `lastSuccessAt`
- `lastFailureAt`
- `lastFailureDetail`
- `updatedAt`

## public_quote_mutation_receipts

Schema export: `publicQuoteMutationReceipts`

Columns (9):

- `id`
- `quoteId`
- `action`
- `keyHash`
- `requestHash`
- `responseStatus`
- `responseBody`
- `createdAt`
- `expiresAt`

## quote_activity_events

Schema export: `quoteActivityEvents`

Columns (12):

- `id`
- `quoteId`
- `quoteVersionId`
- `eventType`
- `actorType`
- `actorTeamMemberId`
- `outboxEventId`
- `correlationId`
- `causationId`
- `metadata`
- `occurredAt`
- `createdAt`

## quote_capabilities

Schema export: `quoteCapabilities`

Columns (21):

- `id`
- `quoteId`
- `quoteVersionId`
- `recipientRole`
- `recipientAddressHash`
- `allowedActions`
- `tokenHash`
- `status`
- `readExpiresAt`
- `actionExpiresAt`
- `issuedAt`
- `issuedByTeamMemberId`
- `revokedAt`
- `revokedByTeamMemberId`
- `revocationReason`
- `supersededAt`
- `supersededByCapabilityId`
- `lastUsedAt`
- `useCount`
- `createdAt`
- `updatedAt`

## quote_change_requests

Schema export: `quoteChangeRequests`

Columns (16):

- `id`
- `quoteId`
- `quoteVersionId`
- `expectedRevision`
- `requestKeyHash`
- `status`
- `ownerTaskId`
- `dueAt`
- `reason`
- `message`
- `resolvedByTeamMemberId`
- `resolutionNote`
- `resolutionKind`
- `resultingVersionId`
- `resolvedAt`
- `createdAt`

## quote_migration_checkpoints

Schema export: `quoteMigrationCheckpoints`

Columns (16):

- `id`
- `jobKey`
- `checkpointKey`
- `cursor`
- `status`
- `scannedCount`
- `migratedCount`
- `reviewCount`
- `skippedCount`
- `lastErrorCode`
- `lastErrorDetail`
- `startedAt`
- `lastHeartbeatAt`
- `completedAt`
- `createdAt`
- `updatedAt`

## quote_migration_review_items

Schema export: `quoteMigrationReviewItems`

Columns (11):

- `id`
- `legacyEntityType`
- `legacyEntityId`
- `reasonCode`
- `details`
- `status`
- `resolution`
- `resolvedByTeamMemberId`
- `resolvedAt`
- `createdAt`
- `updatedAt`

## quote_pdf_downloads

Schema export: `quotePdfDownloads`

Columns (6):

- `id`
- `quoteId`
- `quoteVersionId`
- `userAgent`
- `ipAddress`
- `createdAt`

## quote_public_rate_limits

Schema export: `quotePublicRateLimits`

Columns (9):

- `id`
- `scope`
- `scopeKeyHash`
- `windowStart`
- `windowSeconds`
- `requestCount`
- `blockedUntil`
- `createdAt`
- `updatedAt`

## quote_responses

Schema export: `quoteResponses`

Columns (33):

- `id`
- `quoteId`
- `quoteVersionId`
- `responseType`
- `source`
- `teamMemberId`
- `partnerAccountId`
- `partnerMembershipId`
- `partnerUserId`
- `changeRequestId`
- `appointmentId`
- `signerSnapshot`
- `configurationSnapshot`
- `selectedOptionIds`
- `reason`
- `message`
- `consentText`
- `consentVersion`
- `consentAffirmed`
- `configurationHash`
- `consentHash`
- `contentHash`
- `issuedPdfHash`
- `acceptedTotalMinCents`
- `acceptedTotalMaxCents`
- `acceptedDepositCents`
- `acceptedBalanceMinCents`
- `acceptedBalanceMaxCents`
- `idempotencyKeyHash`
- `requestHash`
- `requestMetadata`
- `respondedAt`
- `createdAt`

## quote_send_attempts

Schema export: `quoteSendAttempts`

Columns (19):

- `id`
- `quoteId`
- `quoteVersionId`
- `capabilityId`
- `attemptNumber`
- `idempotencyKeyHash`
- `status`
- `recipientManifest`
- `messageSnapshot`
- `requestedByTeamMemberId`
- `correlationId`
- `requestedAt`
- `startedAt`
- `completedAt`
- `lastErrorCode`
- `lastErrorDetail`
- `metadata`
- `createdAt`
- `updatedAt`

## quote_send_deliveries

Schema export: `quoteSendDeliveries`

Columns (25):

- `id`
- `sendAttemptId`
- `channel`
- `recipientRole`
- `recipientAddressHash`
- `recipientDisplayHint`
- `encryptedProviderPayload`
- `encryptionKeyId`
- `channelAttemptNumber`
- `status`
- `provider`
- `providerMessageId`
- `providerRequestKey`
- `externalMessageDispatchId`
- `conversationThreadId`
- `conversationMessageId`
- `errorCode`
- `errorDetail`
- `queuedAt`
- `dispatchedAt`
- `deliveredAt`
- `failedAt`
- `metadata`
- `createdAt`
- `updatedAt`

## quote_version_adjustments

Schema export: `quoteVersionAdjustments`

Columns (15):

- `id`
- `quoteVersionId`
- `adjustmentKey`
- `kind`
- `label`
- `calculation`
- `basis`
- `eligibleLineItemKeys`
- `amountCents`
- `basisPoints`
- `amountMinCents`
- `amountMaxCents`
- `displayOrder`
- `metadata`
- `createdAt`

## quote_version_attachments

Schema export: `quoteVersionAttachments`

Columns (11):

- `id`
- `quoteVersionId`
- `mediaAssetId`
- `purpose`
- `position`
- `label`
- `description`
- `customerVisible`
- `metadata`
- `attachedByTeamMemberId`
- `createdAt`

## quote_version_documents

Schema export: `quoteVersionDocuments`

Columns (14):

- `id`
- `quoteVersionId`
- `kind`
- `filename`
- `contentType`
- `storageProvider`
- `storageBucket`
- `storageObjectKey`
- `byteSize`
- `sha256`
- `generatedByTeamMemberId`
- `metadata`
- `generatedAt`
- `createdAt`

## quote_version_line_items

Schema export: `quoteVersionLineItems`

Columns (17):

- `id`
- `quoteVersionId`
- `lineKey`
- `catalogKey`
- `name`
- `description`
- `quantity`
- `unit`
- `unitPriceMinCents`
- `unitPriceMaxCents`
- `amountMinCents`
- `amountMaxCents`
- `optionGroupId`
- `selectedByDefault`
- `displayOrder`
- `metadata`
- `createdAt`

## quote_version_option_groups

Schema export: `quoteVersionOptionGroups`

Columns (10):

- `id`
- `quoteVersionId`
- `groupKey`
- `label`
- `mode`
- `minimumSelections`
- `maximumSelections`
- `displayOrder`
- `metadata`
- `createdAt`

## quote_versions

Schema export: `quoteVersions`

Columns (55):

- `id`
- `quoteId`
- `versionNumber`
- `draftRevision`
- `supersedesVersionId`
- `state`
- `provenance`
- `schemaVersion`
- `documentType`
- `audience`
- `schedulingMode`
- `currency`
- `documentSnapshot`
- `partySnapshot`
- `issuerSnapshot`
- `termsSnapshot`
- `canonicalRenderJson`
- `documentSchemaHash`
- `pricingHash`
- `templateHash`
- `contentHash`
- `clientName`
- `clientCompany`
- `clientEmail`
- `clientPhone`
- `projectName`
- `purchaseOrderNumber`
- `referenceNumber`
- `selectedOptionIds`
- `subtotalMinCents`
- `subtotalMaxCents`
- `discountMinCents`
- `discountMaxCents`
- `feeMinCents`
- `feeMaxCents`
- `totalMinCents`
- `totalMaxCents`
- `depositCents`
- `balanceMinCents`
- `balanceMaxCents`
- `scope`
- `assumptions`
- `exclusions`
- `terms`
- `paymentTerms`
- `internalNotes`
- `validFrom`
- `expiresAt`
- `readyAt`
- `issuedAt`
- `firstSentAt`
- `supersededAt`
- `createdByTeamMemberId`
- `createdAt`
- `updatedAt`

## quote_visible_engagement_daily

Schema export: `quoteVisibleEngagementDaily`

Columns (8):

- `id`
- `engagementDate`
- `visibleMsBucket`
- `eventCount`
- `firstOccurredAt`
- `lastOccurredAt`
- `createdAt`
- `updatedAt`

## quote_visible_engagement_events

Schema export: `quoteVisibleEngagementEvents`

Columns (9):

- `id`
- `quoteId`
- `quoteVersionId`
- `capabilityId`
- `idempotencyKeyHash`
- `visibleMsBucket`
- `correlationId`
- `occurredAt`
- `createdAt`

## quotes

Schema export: `quotes`

Columns (43):

- `id`
- `salesOpportunityId`
- `currentVersionId`
- `publishedVersionId`
- `partnerAccountId`
- `engineVersion`
- `aggregateState`
- `aggregateRevision`
- `contactId`
- `propertyId`
- `status`
- `services`
- `addOns`
- `surfaceArea`
- `zoneId`
- `travelFee`
- `discounts`
- `addOnsTotal`
- `subtotal`
- `total`
- `depositDue`
- `depositRate`
- `balanceDue`
- `lineItems`
- `availability`
- `marketing`
- `notes`
- `quoteNumber`
- `jobDurationMinutes`
- `clientScope`
- `revision`
- `shareToken`
- `sentAt`
- `expiresAt`
- `viewedAt`
- `lastViewedAt`
- `viewCount`
- `decisionAt`
- `decisionNotes`
- `refreshRequestedAt`
- `acceptedAppointmentId`
- `createdAt`
- `updatedAt`

## sales_agent_memories

Schema export: `salesAgentMemories`

Columns (17):

- `id`
- `contactId`
- `leadId`
- `summary`
- `customerIntent`
- `jobType`
- `pricingContext`
- `objections`
- `channelPreference`
- `lastPromisedNextStep`
- `lastHumanSummary`
- `bookingReadiness`
- `quoteConfidence`
- `missingFields`
- `factsJson`
- `createdAt`
- `updatedAt`

## sales_agent_next_actions

Schema export: `salesAgentNextActions`

Columns (15):

- `id`
- `contactId`
- `leadId`
- `actionType`
- `channel`
- `status`
- `priority`
- `confidence`
- `summary`
- `reason`
- `facts`
- `dueAt`
- `source`
- `createdAt`
- `updatedAt`

## sales_escalation_call_callback_events

Schema export: `salesEscalationCallCallbackEvents`

Columns (12):

- `id`
- `operationId`
- `kind`
- `leg`
- `semanticHash`
- `parentCallSid`
- `customerCallSid`
- `status`
- `durationSec`
- `bridged`
- `applyResult`
- `receivedAt`

## sales_escalation_call_operations

Schema export: `salesEscalationCallOperations`

Columns (46):

- `id`
- `outboxEventId`
- `attemptNumber`
- `taskId`
- `taskUpdatedAt`
- `contactId`
- `agentMemberId`
- `agentPhoneE164`
- `customerPhoneE164`
- `mode`
- `state`
- `version`
- `provider`
- `providerRequestKey`
- `providerOperationId`
- `providerCustomerOperationId`
- `providerIdempotencySupported`
- `deliveryCertainty`
- `providerStatus`
- `failureCode`
- `failureDetail`
- `retryable`
- `requestedAuditEventId`
- `dispatchAuditEventId`
- `providerResultAuditEventId`
- `providerAcceptedAuditEventId`
- `terminalAuditEventId`
- `requestedAt`
- `dispatchedAt`
- `providerAcceptedAt`
- `reconciliationRequiredAt`
- `reconciliationResolutionId`
- `reconciliationResolvedAt`
- `agentAnsweredAt`
- `customerDialRequestedAt`
- `customerAnsweredAt`
- `customerCompletedAt`
- `callbackDeadlineAt`
- `terminalOutcome`
- `outcomeReason`
- `taskEffect`
- `taskEffectAt`
- `terminalAt`
- `guardReleasedAt`
- `createdAt`
- `updatedAt`

## sales_escalation_call_reconciliation_sid_claims

Schema export: `salesEscalationCallReconciliationSidClaims`

Columns (5):

- `sid`
- `operationId`
- `leg`
- `firstReconciliationId`
- `createdAt`

## sales_escalation_call_reconciliations

Schema export: `salesEscalationCallReconciliations`

Columns (21):

- `id`
- `operationId`
- `mutationClaimId`
- `reviewerMemberId`
- `reviewerLabel`
- `reviewerRole`
- `reviewerSessionId`
- `reviewerAuthMethod`
- `correlationId`
- `idempotencyKeyHash`
- `expectedOperationVersion`
- `outcome`
- `evidenceType`
- `providerOperationId`
- `providerCustomerOperationId`
- `providerCallStatus`
- `providerCustomerStatus`
- `connectedDurationSec`
- `reason`
- `auditEventId`
- `createdAt`

## sales_opportunities

Schema export: `salesOpportunities`

Columns (15):

- `id`
- `contactId`
- `propertyId`
- `leadId`
- `ownerTeamMemberId`
- `name`
- `status`
- `pipelineStage`
- `currency`
- `estimatedValueCents`
- `revision`
- `closedAt`
- `metadata`
- `createdAt`
- `updatedAt`

## schedule_blocks

Schema export: `scheduleBlocks`

Columns (13):

- `id`
- `kind`
- `source`
- `sourceKey`
- `capacityPoolKey`
- `capacityUnits`
- `startAt`
- `endAt`
- `active`
- `mirroredAppointmentId`
- `metadata`
- `createdAt`
- `updatedAt`

## schedule_date_overrides

Schema export: `scheduleDateOverrides`

Columns (10):

- `id`
- `localDate`
- `timezone`
- `closed`
- `windows`
- `capacityByPool`
- `reason`
- `revision`
- `createdAt`
- `updatedAt`

## schedule_resource_pools

Schema export: `scheduleResourcePools`

Columns (6):

- `key`
- `label`
- `capacityUnits`
- `active`
- `createdAt`
- `updatedAt`

## schedule_resources

Schema export: `scheduleResources`

Columns (11):

- `id`
- `capacityPoolKey`
- `kind`
- `label`
- `capacityUnits`
- `skillKeys`
- `active`
- `source`
- `sourceKey`
- `createdAt`
- `updatedAt`

## seo_agent_state

Schema export: `seoAgentState`

Columns (3):

- `key`
- `value`
- `updatedAt`

## staff_notification_operations

Schema export: `staffNotificationOperations`

Columns (24):

- `id`
- `appointmentId`
- `subjectType`
- `subjectId`
- `contactId`
- `recipientTeamMemberId`
- `kind`
- `channel`
- `recipientAddress`
- `body`
- `state`
- `providerRequestKey`
- `provider`
- `providerOperationId`
- `deliveryCertainty`
- `failureCode`
- `retryable`
- `attemptCount`
- `dispatchedAt`
- `uncertaintyAt`
- `succeededAt`
- `failedAt`
- `createdAt`
- `updatedAt`

## team_access_continuity_state

Schema export: `teamAccessContinuityState`

Columns (4):

- `singleton`
- `protectionEnabled`
- `activatedAt`
- `updatedAt`

## team_auth_rate_limits

Schema export: `teamAuthRateLimits`

Columns (7):

- `id`
- `bucket`
- `keyHash`
- `count`
- `windowStartedAt`
- `resetAt`
- `updatedAt`

## team_call_operation_callback_events

Schema export: `teamCallOperationCallbackEvents`

Columns (12):

- `id`
- `callOperationId`
- `kind`
- `leg`
- `semanticHash`
- `parentCallSid`
- `customerCallSid`
- `status`
- `durationSec`
- `bridged`
- `applyResult`
- `receivedAt`

## team_call_operation_reconciliations

Schema export: `teamCallOperationReconciliations`

Columns (18):

- `id`
- `callOperationId`
- `mutationClaimId`
- `reviewerMemberId`
- `reviewerLabel`
- `reviewerRole`
- `reviewerSessionId`
- `reviewerAuthMethod`
- `correlationId`
- `idempotencyKeyHash`
- `expectedOperationVersion`
- `outcome`
- `evidenceType`
- `providerOperationId`
- `providerStatus`
- `reason`
- `auditEventId`
- `createdAt`

## team_call_operation_task_intents

Schema export: `teamCallOperationTaskIntents`

Columns (10):

- `id`
- `callOperationId`
- `taskId`
- `kind`
- `expectedContactId`
- `expectedAssignedTo`
- `expectedUpdatedAt`
- `effect`
- `effectAt`
- `createdAt`

## team_call_operations

Schema export: `teamCallOperations`

Columns (49):

- `id`
- `mutationClaimId`
- `contactId`
- `agentMemberId`
- `taskId`
- `actorMemberId`
- `actorLabel`
- `actorRole`
- `sessionId`
- `authMethod`
- `correlationId`
- `idempotencyKeyHash`
- `requestHash`
- `state`
- `version`
- `provider`
- `providerRequestKey`
- `providerOperationId`
- `providerCustomerOperationId`
- `providerIdempotencySupported`
- `attemptAuditEventId`
- `providerAcceptedAuditEventId`
- `terminalAuditEventId`
- `terminalOutcome`
- `outcomeReason`
- `completedExplicitTaskId`
- `completedFollowupTaskId`
- `completedSpeedToLeadCount`
- `legacyCompletedExplicitTaskId`
- `legacyCompletedFollowupTaskId`
- `legacyCompletedSpeedToLeadCount`
- `requestedAt`
- `dispatchedAt`
- `providerAcceptedAt`
- `agentAnsweredAt`
- `customerAnsweredAt`
- `agentCompletedAt`
- `customerCompletedAt`
- `callbackDeadlineAt`
- `guardReleasedAt`
- `completedAt`
- `reconciliationRequiredAt`
- `reconciliationResolutionId`
- `reconciliationResolvedAt`
- `providerStatus`
- `failureCode`
- `failureDetail`
- `createdAt`
- `updatedAt`

## team_inbox_new_lead_acknowledgements

Schema export: `teamInboxNewLeadAcknowledgements`

Columns (8):

- `id`
- `teamMemberId`
- `contactId`
- `acknowledgedAt`
- `expiresAt`
- `version`
- `createdAt`
- `updatedAt`

## team_login_tokens

Schema export: `teamLoginTokens`

Columns (7):

- `id`
- `teamMemberId`
- `tokenHash`
- `requestedIp`
- `userAgent`
- `expiresAt`
- `createdAt`

## team_members

Schema export: `teamMembers`

Columns (18):

- `id`
- `name`
- `email`
- `emailNormalized`
- `emailIdentityStatus`
- `phoneE164`
- `roleId`
- `permissionsGrant`
- `permissionsDeny`
- `active`
- `defaultCrewSplitBps`
- `fixedCrewJobRateBps`
- `passwordHash`
- `passwordSetAt`
- `mfaRequired`
- `mfaEnrolledAt`
- `createdAt`
- `updatedAt`

## team_mfa_enrollment_challenges

Schema export: `teamMfaEnrollmentChallenges`

Columns (8):

- `id`
- `teamMemberId`
- `secretCiphertext`
- `secretKeyVersion`
- `attemptCount`
- `expiresAt`
- `consumedAt`
- `createdAt`

## team_mfa_methods

Schema export: `teamMfaMethods`

Columns (13):

- `id`
- `teamMemberId`
- `methodType`
- `label`
- `totpSecretCiphertext`
- `totpSecretKeyVersion`
- `lastTotpCounter`
- `enabled`
- `enrolledAt`
- `lastUsedAt`
- `disabledAt`
- `createdAt`
- `updatedAt`

## team_mfa_recovery_codes

Schema export: `teamMfaRecoveryCodes`

Columns (6):

- `id`
- `methodId`
- `codeHash`
- `keyVersion`
- `usedAt`
- `createdAt`

## team_mutation_idempotency

Schema export: `teamMutationIdempotency`

Columns (19):

- `id`
- `principalHash`
- `action`
- `keyHash`
- `scopeHash`
- `requestHash`
- `status`
- `operationId`
- `correlationId`
- `attemptCount`
- `claimedAt`
- `claimExpiresAt`
- `completedAt`
- `expiresAt`
- `responseStatus`
- `responseBody`
- `lastErrorCode`
- `createdAt`
- `updatedAt`

## team_pipeline_filter_presets

Schema export: `teamPipelineFilterPresets`

Columns (11):

- `id`
- `teamMemberId`
- `name`
- `nameNormalized`
- `searchQuery`
- `stage`
- `excludeOutbound`
- `view`
- `version`
- `createdAt`
- `updatedAt`

## team_roles

Schema export: `teamRoles`

Columns (6):

- `id`
- `name`
- `slug`
- `permissions`
- `createdAt`
- `updatedAt`

## team_sessions

Schema export: `teamSessions`

Columns (12):

- `id`
- `teamMemberId`
- `sessionHash`
- `authMethod`
- `assuranceLevel`
- `mfaVerifiedAt`
- `ip`
- `userAgent`
- `expiresAt`
- `createdAt`
- `lastSeenAt`
- `revokedAt`

## web_event_counts_daily

Schema export: `webEventCountsDaily`

Columns (14):

- `id`
- `dateStart`
- `event`
- `path`
- `key`
- `device`
- `inAreaBucket`
- `utmSource`
- `utmMedium`
- `utmCampaign`
- `utmTerm`
- `utmContent`
- `count`
- `updatedAt`

## web_events

Schema export: `webEvents`

Columns (16):

- `id`
- `sessionId`
- `visitId`
- `event`
- `path`
- `key`
- `referrerDomain`
- `utmSource`
- `utmMedium`
- `utmCampaign`
- `utmTerm`
- `utmContent`
- `device`
- `inAreaBucket`
- `meta`
- `createdAt`

## web_vitals

Schema export: `webVitals`

Columns (9):

- `id`
- `sessionId`
- `visitId`
- `path`
- `metric`
- `value`
- `rating`
- `device`
- `createdAt`
