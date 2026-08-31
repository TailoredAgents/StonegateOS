import "dotenv/config";
import { getDb } from "../src/db";
import { runQuoteV2EngagementRetention } from "../src/lib/quote-v2-engagement-retention";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== "--execute") {
    throw new Error(
      "Pass exactly --execute to run Quote V2 engagement retention.",
    );
  }
  const result = await runQuoteV2EngagementRetention(getDb());
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "retention_failed";
  process.stderr.write(`${JSON.stringify({ ok: false, error: message })}\n`);
  process.exitCode = 1;
});
