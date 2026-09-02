const base = require("./jest.config.cjs");

/**
 * Opt-in Partner Portal PostgreSQL evidence lane. These suites require a
 * disposable, fully migrated DATABASE_URL and are intentionally absent from
 * the ordinary Partner unit lane.
 */
module.exports = {
  ...base,
  testMatch: [
    "<rootDir>/src/__tests__/calendar-external-busy.integration.test.ts",
    "<rootDir>/src/__tests__/partner-account-cancellation-policy-postgres.integration.test.ts",
    "<rootDir>/src/__tests__/partner-account-lifecycle-postgres.integration.test.ts",
    "<rootDir>/src/__tests__/partner-approval-rule-administration-postgres.integration.test.ts",
    "<rootDir>/src/__tests__/partner-billing-dispute-requests-postgres.integration.test.ts",
    "<rootDir>/src/__tests__/partner-account-scheduling-policy-postgres.integration.test.ts",
    "<rootDir>/src/__tests__/partner-activation-mfa-postgres.integration.test.ts",
    "<rootDir>/src/__tests__/partner-cancellation-request-lifecycle-postgres.integration.test.ts",
    "<rootDir>/src/__tests__/partner-job-change-request-lifecycle-postgres.integration.test.ts",
    "<rootDir>/src/__tests__/partner-location-portfolio-controls-postgres.integration.test.ts",
    "<rootDir>/src/__tests__/partner-location-and-account-merge-postgres.integration.test.ts",
    "<rootDir>/src/__tests__/partner-portal-v2-media-integrity-postgres.integration.test.ts",
    "<rootDir>/src/__tests__/partner-portal-operations-query-budget-postgres.integration.test.ts",
    "<rootDir>/src/__tests__/partner-portal-v2-scheduling-concurrency.integration.test.ts",
    "<rootDir>/src/__tests__/partner-recurring-series-lifecycle-concurrency.postgres.integration.test.ts",
    "<rootDir>/src/__tests__/partner-quote-account-binding-postgres.integration.test.ts",
    "<rootDir>/src/__tests__/partner-quote-approval-postgres.integration.test.ts",
    "<rootDir>/src/__tests__/partner-quote-terminal-contention-postgres.integration.test.ts",
    "<rootDir>/src/__tests__/staff-notification-operations-postgres.integration.test.ts",
  ],
};
