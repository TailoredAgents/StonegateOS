import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

void test("Partner quote detail renders only sanitized structured proposal fields", () => {
  const page = source("../(portal)/billing/quotes/[partnerQuoteId]/page.tsx");
  const commercial = source("./portal-commercial.ts");

  assert.match(page, /isPartnerQuoteDetail/u);
  assert.match(page, /whitespace-pre-wrap break-words/u);
  assert.match(page, /proposalDocument/u);
  assert.match(page, /Download proposal PDF/u);
  assert.doesNotMatch(page, /dangerouslySetInnerHTML/u);
  assert.match(commercial, /isQuoteDocument/u);
  assert.match(commercial, /lineIds\.has\(id\)/u);
  assert.match(commercial, /groupIds\.has\(id\)/u);
});

void test("Partner quote response is accessible, revision-safe, and explicit", () => {
  const decision = source("../components/PartnerQuoteDecisionForm.tsx");

  assert.match(decision, /aria-busy=\{busy\}/u);
  assert.match(decision, /tabIndex=\{-1\}/u);
  assert.match(decision, /min-h-11/u);
  assert.match(decision, /"If-Match": etag/u);
  assert.match(decision, /createPortalOperationKey\("quote-decision"\)/u);
  assert.match(decision, /authorityAffirmed: true as const/u);
  assert.match(decision, /consentAffirmed: true as const/u);
  assert.match(decision, /I am authorized to accept this proposal/u);
  assert.match(decision, /No quote decision was changed/u);
  assert.doesNotMatch(
    decision,
    /MFA|mfa\/step-up|authenticator|recovery code/iu,
  );
  assert.match(decision, /certificateState === "ready"/u);
  assert.match(decision, /acceptance certificate is still being prepared/u);
  assert.match(decision, /motion-reduce:animate-none/u);
});

void test("Billing and Staff surfaces deep-link through opaque Partner quote context", () => {
  const billing = source("../(portal)/billing/page.tsx");
  const administration = source(
    "../../team/components/PartnerAdministrationSection.tsx",
  );
  const builder = source("../../team/components/QuoteV2BuilderSection.tsx");
  const composer = source("../../team/components/QuoteV2ComposerClient.tsx");

  assert.match(billing, /\/partners\/billing\/quotes\//u);
  assert.match(billing, /Review and respond/u);
  assert.match(administration, /partnerTargetType/u);
  assert.match(administration, /partnerTargetId/u);
  assert.match(builder, /verifyPartnerQuoteContext/u);
  assert.match(composer, /partnerContext/u);
  assert.match(composer, /Partner account quote binding/u);
});
