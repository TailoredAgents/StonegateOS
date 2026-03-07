# Data Dictionary (Generated Columns)

Generated: 2026-03-07 13:39:23 (Eastern Standard Time)

Source: `StonegateOS/apps/api/src/db/schema.ts`.

Parsed tables: 64

## appointment_attachments

Columns (6):

- `id`
- `appointmentId`
- `filename`
- `url`
- `contentType`
- `createdAt`

## appointment_commissions

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

Columns (5):

- `id`
- `appointmentId`
- `memberId`
- `splitBps`
- `createdAt`

## appointment_holds

Columns (13):

- `id`
- `instantQuoteId`
- `leadId`
- `contactId`
- `propertyId`
- `startAt`
- `durationMinutes`
- `travelBufferMinutes`
- `status`
- `expiresAt`
- `consumedAt`
- `createdAt`
- `updatedAt`

## appointment_notes

Columns (4):

- `id`
- `appointmentId`
- `body`
- `createdAt`

## appointment_tasks

Columns (6):

- `id`
- `appointmentId`
- `title`
- `status`
- `createdAt`
- `updatedAt`

## appointments

Columns (20):

- `id`
- `contactId`
- `propertyId`
- `leadId`
- `type`
- `startAt`
- `durationMinutes`
- `status`
- `quotedTotalCents`
- `finalTotalCents`
- `completedAt`
- `calendarEventId`
- `crew`
- `owner`
- `soldByMemberId`
- `marketingMemberId`
- `rescheduleToken`
- `travelBufferMinutes`
- `createdAt`
- `updatedAt`

## audit_logs

Columns (10):

- `id`
- `actorType`
- `actorId`
- `actorLabel`
- `actorRole`
- `action`
- `entityType`
- `entityId`
- `meta`
- `createdAt`

## automation_settings

Columns (4):

- `channel`
- `mode`
- `updatedBy`
- `updatedAt`

## blog_posts

Columns (11):

- `id`
- `slug`
- `title`
- `excerpt`
- `contentMarkdown`
- `metaTitle`
- `metaDescription`
- `topicKey`
- `publishedAt`
- `createdAt`
- `updatedAt`

## calendar_sync_state

Columns (9):

- `calendarId`
- `syncToken`
- `channelId`
- `resourceId`
- `channelExpiresAt`
- `lastSyncedAt`
- `lastNotificationAt`
- `createdAt`
- `updatedAt`

## call_coaching

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

## commission_settings

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

## contacts

Columns (20):

- `id`
- `firstName`
- `lastName`
- `company`
- `email`
- `phone`
- `phoneE164`
- `salespersonMemberId`
- `partnerStatus`
- `partnerType`
- `partnerOwnerMemberId`
- `partnerSince`
- `partnerLastTouchAt`
- `partnerNextTouchAt`
- `partnerReferralCount`
- `partnerLastReferralAt`
- `preferredContactMethod`
- `source`
- `createdAt`
- `updatedAt`

## conversation_messages

Columns (17):

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
- `createdAt`

## conversation_participants

Columns (8):

- `id`
- `threadId`
- `participantType`
- `contactId`
- `teamMemberId`
- `externalAddress`
- `displayName`
- `createdAt`

## conversation_threads

Columns (14):

- `id`
- `leadId`
- `contactId`
- `propertyId`
- `status`
- `state`
- `channel`
- `subject`
- `lastMessagePreview`
- `lastMessageAt`
- `assignedTo`
- `stateUpdatedAt`
- `createdAt`
- `updatedAt`

## crm_pipeline

Columns (5):

- `contactId`
- `stage`
- `notes`
- `createdAt`
- `updatedAt`

## crm_tasks

Columns (9):

- `id`
- `contactId`
- `title`
- `dueAt`
- `assignedTo`
- `status`
- `notes`
- `createdAt`
- `updatedAt`

## discord_action_intents

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

## expenses

Columns (17):

- `id`
- `amount`
- `currency`
- `category`
- `vendor`
- `memo`
- `method`
- `source`
- `paidAt`
- `coverageStartAt`
- `coverageEndAt`
- `receiptFilename`
- `receiptUrl`
- `receiptContentType`
- `bankTransactionId`
- `createdAt`
- `updatedAt`

## google_ads_analyst_recommendation_events

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

## google_ads_search_terms_daily

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

Columns (8):

- `id`
- `token`
- `filename`
- `contentType`
- `bytes`
- `byteLength`
- `createdAt`
- `expiresAt`

## instant_quotes

Columns (12):

- `id`
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

Columns (22):

- `id`
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
- `instantQuoteId`
- `quoteEstimate`
- `quoteId`
- `createdAt`
- `updatedAt`

## merge_suggestions

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

Columns (6):

- `id`
- `messageId`
- `status`
- `detail`
- `provider`
- `occurredAt`

## meta_ads_insights_daily

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

## outbox_events

Columns (8):

- `id`
- `type`
- `payload`
- `attempts`
- `nextAttemptAt`
- `lastError`
- `createdAt`
- `processedAt`

## partner_bookings

Columns (9):

- `id`
- `orgContactId`
- `partnerUserId`
- `propertyId`
- `appointmentId`
- `serviceKey`
- `tierKey`
- `amountCents`
- `createdAt`

## partner_login_tokens

Columns (8):

- `id`
- `partnerUserId`
- `tokenHash`
- `requestedIp`
- `userAgent`
- `expiresAt`
- `usedAt`
- `createdAt`

## partner_rate_cards

Columns (6):

- `id`
- `orgContactId`
- `currency`
- `active`
- `createdAt`
- `updatedAt`

## partner_rate_items

Columns (8):

- `id`
- `rateCardId`
- `serviceKey`
- `tierKey`
- `label`
- `amountCents`
- `sortOrder`
- `createdAt`

## partner_sessions

Columns (9):

- `id`
- `partnerUserId`
- `sessionHash`
- `ip`
- `userAgent`
- `expiresAt`
- `revokedAt`
- `createdAt`
- `lastSeenAt`

## partner_users

Columns (11):

- `id`
- `orgContactId`
- `email`
- `phone`
- `phoneE164`
- `name`
- `active`
- `passwordHash`
- `passwordSetAt`
- `createdAt`
- `updatedAt`

## payments

Columns (14):

- `id`
- `stripeChargeId`
- `amount`
- `currency`
- `status`
- `method`
- `cardBrand`
- `last4`
- `receiptUrl`
- `metadata`
- `appointmentId`
- `createdAt`
- `updatedAt`
- `capturedAt`

## payout_run_adjustments

Columns (7):

- `id`
- `payoutRunId`
- `memberId`
- `amountCents`
- `note`
- `createdBy`
- `createdAt`

## payout_run_lines

Columns (9):

- `id`
- `payoutRunId`
- `memberId`
- `salesCents`
- `marketingCents`
- `crewCents`
- `adjustmentsCents`
- `totalCents`
- `createdAt`

## payout_runs

Columns (11):

- `id`
- `timezone`
- `periodStart`
- `periodEnd`
- `scheduledPayoutAt`
- `status`
- `createdBy`
- `createdAt`
- `updatedAt`
- `lockedAt`
- `paidAt`

## plaid_accounts

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

Columns (5):

- `key`
- `value`
- `updatedBy`
- `createdAt`
- `updatedAt`

## properties

Columns (12):

- `id`
- `contactId`
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

Columns (5):

- `provider`
- `lastSuccessAt`
- `lastFailureAt`
- `lastFailureDetail`
- `updatedAt`

## quotes

Columns (27):

- `id`
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
- `shareToken`
- `sentAt`
- `expiresAt`
- `decisionAt`
- `decisionNotes`
- `createdAt`
- `updatedAt`

## seo_agent_state

Columns (3):

- `key`
- `value`
- `updatedAt`

## team_login_tokens

Columns (7):

- `id`
- `teamMemberId`
- `tokenHash`
- `requestedIp`
- `userAgent`
- `expiresAt`
- `createdAt`

## team_members

Columns (12):

- `id`
- `name`
- `email`
- `roleId`
- `permissionsGrant`
- `permissionsDeny`
- `active`
- `defaultCrewSplitBps`
- `passwordHash`
- `passwordSetAt`
- `createdAt`
- `updatedAt`

## team_roles

Columns (6):

- `id`
- `name`
- `slug`
- `permissions`
- `createdAt`
- `updatedAt`

## team_sessions

Columns (9):

- `id`
- `teamMemberId`
- `sessionHash`
- `ip`
- `userAgent`
- `expiresAt`
- `createdAt`
- `lastSeenAt`
- `revokedAt`

## web_event_counts_daily

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

