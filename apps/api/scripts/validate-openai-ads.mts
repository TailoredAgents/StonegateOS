import "dotenv/config";
import { randomUUID } from "node:crypto";
import { sendOpenAiAdsConversion } from "../src/lib/openai-ads";

// This utility always validates without saving a conversion. Never add a
// production-send mode or print the credentials/provider request body here.
const source =
  process.env["NEXT_PUBLIC_SITE_URL"] ?? "https://stonegatejunkremoval.com";
const sourceUrl = new URL(source).origin;
const result = await sendOpenAiAdsConversion(
  {
    id: `validation:${randomUUID()}`,
    type: "appointment_scheduled",
    timestamp_ms: Date.now(),
    action_source: "web",
    source_url: sourceUrl,
    data: { type: "customer_action" },
  },
  { validateOnly: true },
);

if (result.ok) {
  process.stdout.write(
    "OpenAI accepted the validation event. No conversion was saved.\n",
  );
} else {
  process.stderr.write(`OpenAI conversion validation failed: ${result.code}\n`);
  process.exitCode = 1;
}
