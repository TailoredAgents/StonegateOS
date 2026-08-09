import "dotenv/config";
import Module from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

type DbModule = typeof import("../apps/api/src/db");
type PropertyWriteModule = typeof import("../apps/api/src/lib/property-write");
type PricingModule = typeof import("../packages/pricing/src/engine/calculate");
type PricingDefaultsModule =
  typeof import("../packages/pricing/src/config/defaults");

function registerAliases() {
  const mod = Module as unknown as {
    _resolveFilename: Module["_resolveFilename"];
  };
  const originalResolve = mod._resolveFilename.bind(Module);
  mod._resolveFilename = function (request: string, parent, isMain, options) {
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

async function loadModules(): Promise<{
  db: DbModule;
  pricing: PricingModule;
  pricingDefaults: PricingDefaultsModule;
  propertyWrite: PropertyWriteModule;
}> {
  registerAliases();
  const [db, pricing, pricingDefaults, propertyWrite] = await Promise.all([
    import("../apps/api/src/db"),
    import("../packages/pricing/src/engine/calculate"),
    import("../packages/pricing/src/config/defaults"),
    import("../apps/api/src/lib/property-write"),
  ]);
  return { db, pricing, pricingDefaults, propertyWrite };
}

type SeedSummary = {
  contactId: string;
  propertyId: string;
  leadId: string;
  quoteId: string | null;
  appointmentId: string | null;
};

function readSeedSummary(payload: unknown): SeedSummary | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const value = payload as Record<string, unknown>;
  const contactId =
    typeof value["contactId"] === "string" ? value["contactId"] : null;
  const propertyId =
    typeof value["propertyId"] === "string" ? value["propertyId"] : null;
  const leadId = typeof value["leadId"] === "string" ? value["leadId"] : null;
  if (!contactId || !propertyId || !leadId) return null;

  return {
    contactId,
    propertyId,
    leadId,
    quoteId: typeof value["quoteId"] === "string" ? value["quoteId"] : null,
    appointmentId:
      typeof value["appointmentId"] === "string"
        ? value["appointmentId"]
        : null,
  };
}

async function findReusableBaseline(
  db: DbModule,
  runId: string,
): Promise<SeedSummary | null> {
  const database = db.getDb();
  const { contacts, outboxEvents } = db;
  const contactEmail = `e2e+contact-${runId}@mystos.test`;

  const activeContacts = await database
    .select({ id: contacts.id, email: contacts.email })
    .from(contacts)
    .where(isNull(contacts.deletedAt))
    .limit(2);
  if (activeContacts.length === 0) return null;

  const existingContact = activeContacts.find(
    (contact) => contact.email === contactEmail,
  );
  if (!existingContact || activeContacts.length !== 1) {
    throw new Error(
      "The E2E database contains active records outside the current deterministic baseline. Run the full e2e:prepare reset so the isolated PostgreSQL volume is recreated; fixture setup must never bypass contact recovery or append-only evidence controls.",
    );
  }

  const [marker] = await database
    .select({ payload: outboxEvents.payload })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.type, "seed.initialized"),
        sql`${outboxEvents.payload}->>'contactId' = ${existingContact.id}`,
        sql`${outboxEvents.payload}->>'runId' = ${runId}`,
      ),
    )
    .orderBy(desc(outboxEvents.createdAt))
    .limit(1);
  const summary = readSeedSummary(marker?.payload);
  if (!summary || summary.contactId !== existingContact.id) {
    throw new Error(
      "The active E2E contact is missing its matching deterministic seed receipt. Run the full e2e:prepare reset; setup will not guess at or overwrite an unverified fixture.",
    );
  }
  return summary;
}

async function seedBaseline(
  db: DbModule,
  pricing: PricingModule,
  defaults: PricingDefaultsModule,
  propertyWrite: PropertyWriteModule,
  runId: string,
) {
  const database = db.getDb();
  const { contacts, leads, quotes, appointments, outboxEvents } = db;

  const preferred = [
    "furniture",
    "single-item",
    "appliances",
    "yard-waste",
    "construction-debris",
    "hot-tub",
  ];
  const primaryService =
    defaults.defaultPricingContext.services.find((s) =>
      preferred.includes(s.service),
    )?.service ?? "furniture";
  const zoneId = defaults.defaultPricingContext.zone.id;

  const contactEmail = `e2e+contact-${runId}@mystos.test`;
  const leadSource = `e2e-${runId}`;

  const [contact] = await database
    .insert(contacts)
    .values({
      firstName: "E2E",
      lastName: "Contact",
      email: contactEmail,
      phone: "404-555-0100",
      phoneE164: "+14045550100",
      preferredContactMethod: "email",
      source: leadSource,
    })
    .returning({
      id: contacts.id,
    });

  if (!contact) {
    throw new Error("Failed to insert baseline contact");
  }

  const { property } = await propertyWrite.resolveOrCreateContactProperty(
    database,
    {
      contactId: contact.id,
      addressLine1: "123 E2E Lane",
      city: "Atlanta",
      state: "GA",
      postalCode: "30301",
      gated: false,
    },
  );

  const [lead] = await database
    .insert(leads)
    .values({
      contactId: contact.id,
      propertyId: property.id,
      servicesRequested: [primaryService],
      status: "new",
      source: leadSource,
      notes: `Seeded for automated tests (${runId})`,
      formPayload: {
        preferredDate: new Date().toISOString(),
        timeWindow: "morning",
      },
    })
    .returning({
      id: leads.id,
    });

  if (!lead) {
    throw new Error("Failed to insert baseline lead");
  }

  const breakdown = pricing.calculateQuoteBreakdown({
    zoneId,
    selectedServices: [primaryService],
    applyBundles: true,
  });

  const shareToken = randomUUID().replace(/-/g, "").slice(0, 24);

  const [quote] = await database
    .insert(quotes)
    .values({
      contactId: contact.id,
      propertyId: property.id,
      services: [primaryService],
      addOns: null,
      zoneId,
      travelFee: breakdown.travelFee,
      discounts: breakdown.discounts,
      addOnsTotal: breakdown.addOnsTotal,
      subtotal: breakdown.subtotal,
      total: breakdown.total,
      depositDue: breakdown.depositDue,
      depositRate: breakdown.depositRate,
      balanceDue: breakdown.balanceDue,
      lineItems: breakdown.lineItems,
      notes: "Seeded demo quote",
      status: "pending",
      shareToken,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    })
    .returning({
      id: quotes.id,
    });

  if (quote) {
    await database
      .update(leads)
      .set({ quoteId: quote.id })
      .where(eq(leads.id, lead.id));
  }

  const [appointment] = await database
    .insert(appointments)
    .values({
      contactId: contact.id,
      propertyId: property.id,
      leadId: lead.id,
      startAt: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
      durationMinutes: 90,
      status: "requested",
      rescheduleToken: randomUUID().replace(/-/g, ""),
    })
    .returning({
      id: appointments.id,
    });

  await database.insert(outboxEvents).values({
    type: "seed.initialized",
    payload: {
      contactId: contact.id,
      propertyId: property.id,
      leadId: lead.id,
      quoteId: quote?.id ?? null,
      appointmentId: appointment?.id ?? null,
      runId,
    },
  });

  return {
    contactId: contact.id,
    propertyId: property.id,
    leadId: lead.id,
    quoteId: quote?.id ?? null,
    appointmentId: appointment?.id ?? null,
  };
}

async function main() {
  const start = Date.now();
  const modules = await loadModules();
  const runId = process.env["E2E_RUN_ID"] ?? `seed-${Date.now().toString(36)}`;

  const reusable = await findReusableBaseline(modules.db, runId);
  const summary =
    reusable ??
    (await seedBaseline(
      modules.db,
      modules.pricing,
      modules.pricingDefaults,
      modules.propertyWrite,
      runId,
    ));

  console.log(
    JSON.stringify(
      {
        ...summary,
        reused: Boolean(reusable),
        durationMs: Date.now() - start,
      },
      null,
      2,
    ),
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
