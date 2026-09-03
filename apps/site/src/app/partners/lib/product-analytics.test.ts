import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  normalizePartnerFunnelPersona,
  partnerFunnelKey,
  PARTNER_FUNNEL_PERSONAS,
  PARTNER_FUNNEL_STAGES,
} from "./product-analytics";

void test("funnel stages and personas remain stable, bounded dimensions", () => {
  assert.deepEqual(PARTNER_FUNNEL_PERSONAS, [
    "contractor",
    "real_estate_agent",
    "property_manager",
    "commercial_client",
    "other",
    "unknown",
  ]);
  assert.ok(PARTNER_FUNNEL_STAGES.includes("availability_slot_full"));
  assert.ok(PARTNER_FUNNEL_STAGES.includes("booking_abandoned"));
  assert.ok(PARTNER_FUNNEL_STAGES.includes("upload_interrupted"));
  assert.ok(PARTNER_FUNNEL_STAGES.includes("access_request_started"));
  assert.ok(PARTNER_FUNNEL_STAGES.includes("verification_request_accepted"));
});

void test("unknown or attacker-controlled persona input collapses safely", () => {
  assert.equal(normalizePartnerFunnelPersona(" Contractor "), "contractor");
  assert.equal(normalizePartnerFunnelPersona("person@example.com"), "unknown");
  assert.equal(
    partnerFunnelKey("booking_started", "property_manager"),
    "booking_started:property_manager",
  );
});

void test("access requests use stable action and accepted funnel events", () => {
  const source = fs.readFileSync(
    path.join(
      process.cwd(),
      "src/app/partners/components/PartnerAccessRequestForm.tsx",
    ),
    "utf8",
  );
  assert.match(source, /data-partner-analytics="access_email_submit"/u);
  assert.match(source, /stage: "access_request_started"/u);
  assert.match(source, /stage: "verification_request_accepted"/u);
  assert.match(source, /surface: "access"/u);
  assert.ok(
    source.indexOf('stage: "verification_request_accepted"') >
      source.indexOf("if (!result?.ok)"),
  );
});

void test("partner Core Web Vitals use the framework collector and omit client ratings", () => {
  const source = fs.readFileSync(
    path.join(
      process.cwd(),
      "src/app/partners/components/PartnerProductAnalyticsClient.tsx",
    ),
    "utf8",
  );

  assert.match(source, /useReportWebVitals/u);
  assert.match(source, /metric\.name !== "LCP"/u);
  assert.match(source, /metric\.name !== "INP"/u);
  assert.match(source, /metric\.name !== "CLS"/u);
  assert.match(source, /trackWebEvent\([\s\S]*flushWebAnalytics\(\)/u);
  assert.doesNotMatch(source, /PerformanceObserver|rating:/u);
});

void test("Leaflet styles load only inside the areas route family", () => {
  const appRoot = path.join(process.cwd(), "src/app");
  const globalStyles = fs.readFileSync(
    path.join(appRoot, "globals.css"),
    "utf8",
  );
  const areasLayout = fs.readFileSync(
    path.join(appRoot, "(site)/areas/layout.tsx"),
    "utf8",
  );
  const areasPage = fs.readFileSync(
    path.join(appRoot, "(site)/areas/page.tsx"),
    "utf8",
  );
  const mapWrapper = fs.readFileSync(
    path.join(process.cwd(), "src/components/ServiceAreaMapNoSSR.tsx"),
    "utf8",
  );
  const map = fs.readFileSync(
    path.join(process.cwd(), "src/components/ServiceAreaMap.tsx"),
    "utf8",
  );

  assert.doesNotMatch(globalStyles, /leaflet\/dist\/leaflet\.css/u);
  assert.match(areasLayout, /import "leaflet\/dist\/leaflet\.css";/u);
  assert.match(areasPage, /ServiceAreaMapNoSSR/u);
  assert.match(mapWrapper, /import\("\.\/ServiceAreaMap"\)/u);
  assert.match(map, /from "react-leaflet"/u);
});
