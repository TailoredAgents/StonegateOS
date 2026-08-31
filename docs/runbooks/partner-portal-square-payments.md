# Partner portal Square payments

## Supported launch paths

- Required deposits and explicitly configured 100% prepayment obligations use
  the Square Web Payments SDK card form in the authenticated portal.
- Issued invoice balances use Square-hosted invoice/payment pages. They do not
  pass through the embedded card endpoint.
- ACH is disabled and is not shown in the portal.

The browser receives only Square's application ID, location ID, SDK URL, and a
one-use card token. The token is sent immediately to the API, fingerprinted for
portal idempotency, and never written to payment-attempt metadata, financial
records, audit logs, analytics, or API responses. Stonegate verifies the Square
order, payment, appointment, account invoice, amount, USD currency, location,
and card tender before applying the payment.

## Required production configuration

Configure these API secrets/variables as a matching set from the same Square
application, merchant account, environment, and location:

- `SQUARE_APPLICATION_ID`
- `SQUARE_ACCESS_TOKEN`
- `SQUARE_LOCATION_ID`
- `SQUARE_ENVIRONMENT=production`
- the existing verified Square webhook signature configuration
- `PARTNER_PORTAL_HOSTED_PAYMENTS_ENABLED=true` only after hosted-invoice
  reconciliation passes its canary
- `PARTNER_PORTAL_EMBEDDED_PAYMENTS_ENABLED=true` only after canary validation

Hosted invoice links and embedded card collection have independent rollout
switches. This lets Stonegate keep Square-hosted invoice payment available while
pausing SDK/token-based checkout, or stop hosted link creation without
discarding an in-flight embedded payment record. The global financial-mutation
kill switch overrides both.

The public portal and API must be HTTPS. Never place the access token in the
site environment or a `NEXT_PUBLIC_*` variable. A sandbox application ID must
not be paired with a production access token/location, or vice versa.

The billing page CSP permits only Square's official production and sandbox SDK,
frame, PCI-connect, and documented font/telemetry origins. The client also
accepts only these exact SDK script URLs:

- `https://web.squarecdn.com/v1/square.js`
- `https://sandbox.web.squarecdn.com/v1/square.js`

Before enabling a partner canary, verify a completed card, decline, browser
refresh, duplicate submit, provider timeout, webhook replay, and invoice
allocation in the selected Square environment. A provider-indeterminate result
must remain pending/review and must never be represented as paid.

## Why ACH remains gated

The current credentials prove card API access only. They do not prove that the
merchant is US-based and enabled for Square ACH, and the portal does not yet
have the dedicated, query-free ACH authorization return URI and transaction ID
lifecycle required by `payments.ach({ redirectURI, transactionId })`. Square's
ACH authorization, pending settlement (normally two to three business days),
webhook reconciliation, return recovery, and account-level opt-in must be
implemented and canary-tested before `methods.ach` can be true. Card credentials
alone are not sufficient evidence to enable it.

## Current Square references

- [Web Payments SDK overview](https://developer.squareup.com/docs/web-payments/overview)
- [Take a card payment](https://developer.squareup.com/docs/web-payments/take-card-payment)
- [Web Payments SDK content security policy](https://developer.squareup.com/docs/web-payments/content-security-policy)
- [Deploy the Web Payments SDK](https://developer.squareup.com/docs/web-payments/quickstart/deploy-app)
- [CreatePayment](https://developer.squareup.com/reference/square/payments-api/CreatePayment)
- [Idempotency](https://developer.squareup.com/docs/build-basics/common-api-patterns/idempotency)
- [ACH Web Payments SDK flow](https://developer.squareup.com/docs/web-payments/add-ach)
