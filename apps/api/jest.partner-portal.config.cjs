const base = require("./jest.config.cjs");

/**
 * Release-focused Partner Portal test lane. Keep infrastructure contracts that
 * protect portal scheduling, delivery, and database transport here even when
 * their filenames are not partner-prefixed.
 */
module.exports = {
  ...base,
  testMatch: [
    "<rootDir>/src/__tests__/partner-account-*.test.ts",
    "<rootDir>/src/__tests__/partner-company-*.test.ts",
    "<rootDir>/src/__tests__/partner-booking-notification-integrity.test.ts",
    "<rootDir>/src/__tests__/partner-embedded-*.test.ts",
    "<rootDir>/src/__tests__/partner-hosted-checkout-provider.test.ts",
    "<rootDir>/src/__tests__/partner-mfa.test.ts",
    "<rootDir>/src/__tests__/partner-password-*.test.ts",
    "<rootDir>/src/__tests__/partner-portal-*.test.ts",
    "<rootDir>/src/__tests__/partner-proof-*.test.ts",
    "<rootDir>/src/__tests__/partner-public-auth-security.test.ts",
    "<rootDir>/src/__tests__/partner-repeat-*.test.ts",
    "<rootDir>/src/__tests__/partner-staff-*.test.ts",
    "<rootDir>/src/__tests__/calendar-external-busy*.test.ts",
    "<rootDir>/src/__tests__/outbox-dispatch-policy.test.ts",
    "<rootDir>/src/__tests__/database-ssl.test.ts",
  ],
};
