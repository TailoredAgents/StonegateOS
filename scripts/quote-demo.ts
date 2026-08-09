import "dotenv/config";
import Module from "node:module";
import path from "node:path";
import { nanoid } from "nanoid";

type ResolveFilename = Module["_resolveFilename"];

function registerAliases() {
  const mod = Module as unknown as { _resolveFilename: ResolveFilename };
  const originalResolve = mod._resolveFilename.bind(Module);
  mod._resolveFilename = function (request: string, parent: any, isMain: boolean, options: any) {
    if (request.startsWith("@/")) {
      const absolute = path.resolve("apps/api/src", request.slice(2));
      return originalResolve(absolute, parent, isMain, options);
    }
    if (request.startsWith("@myst-os/")) {
      const [pkg, ...rest] = request.replace("@myst-os/", "").split("/");
      const absolute = path.resolve("packages", pkg, "src", ...rest);
      return originalResolve(absolute, parent, isMain, options);
    }
    return originalResolve(request, parent, isMain, options);
  };
}

async function main() {
  registerAliases();

  const { getDb, contacts, quotes, outboxEvents } = await import("../apps/api/src/db");
  const { loadContactPropertiesForContacts } = await import(
    "../apps/api/src/lib/property-write"
  );
  const { calculateQuoteBreakdown } = await import("../packages/pricing/src/engine/calculate");
  const { defaultPricingContext } = await import("../packages/pricing/src/config/defaults");
  const { processOutboxBatch } = await import("../apps/api/src/lib/outbox-processor");

  const db = getDb();

  const [contact] = await db
    .select({
      id: contacts.id,
      firstName: contacts.firstName,
      email: contacts.email,
      phone: contacts.phone,
      phoneE164: contacts.phoneE164
    })
    .from(contacts)
    .limit(1);

  if (!contact) {
    throw new Error("No contacts found. Seed a contact before running the quote demo.");
  }

  const [propertyLink] = await loadContactPropertiesForContacts(
    db,
    [contact.id],
    { limit: 100 },
  );
  const property = propertyLink?.property ?? null;

  if (!property) {
    throw new Error(`No properties found for contact ${contact.id}.`);
  }

  const zone = defaultPricingContext.zone.id;
  const service = defaultPricingContext.services[0]?.service;
  if (!service) {
    throw new Error("No services configured in pricing defaults.");
  }

  const breakdown = calculateQuoteBreakdown({
    zoneId: zone,
    selectedServices: [service],
    applyBundles: true
  });

  const shareToken = nanoid(24);

  let quote: { id: string; shareToken: string | null } | null = null;
  try {
    const [inserted] = await db
      .insert(quotes)
      .values({
        contactId: contact.id,
        propertyId: property.id,
        status: "pending",
        services: [service],
        addOns: null,
        surfaceArea: null,
        zoneId: zone,
        travelFee: breakdown.travelFee,
        discounts: breakdown.discounts,
        addOnsTotal: breakdown.addOnsTotal,
        subtotal: breakdown.subtotal,
        total: breakdown.total,
        depositDue: breakdown.depositDue,
        depositRate: breakdown.depositRate,
        balanceDue: breakdown.balanceDue,
        lineItems: breakdown.lineItems,
        notes: "Generated via scripts/quote-demo.ts",
        shareToken,
        sentAt: null,
        expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000)
      })
      .returning({
        id: quotes.id,
        shareToken: quotes.shareToken
      });
    quote = inserted ?? null;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "42P01") {
      console.error("Quotes table not found. Run `pnpm -w db:migrate` before executing quote-demo.");
      return;
    }
    throw error;
  }

  if (!quote) {
    throw new Error("Failed to insert demo quote.");
  }

  await db.insert(outboxEvents).values({
    type: "quote.sent",
    payload: {
      quoteId: quote.id,
      shareToken
    }
  });

  const stats = await processOutboxBatch({ limit: 5 });

  console.log(
    JSON.stringify(
      {
        quoteId: quote.id,
        shareUrl: `${process.env["NEXT_PUBLIC_SITE_URL"] ?? process.env["SITE_URL"] ?? "http://localhost:3000"}/quote/${shareToken}`,
        outbox: stats
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
