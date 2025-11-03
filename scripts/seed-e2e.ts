import "dotenv/config";
import Module from "node:module";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

type DbModule = typeof import("../apps/api/src/db");
type PricingModule = typeof import("../packages/pricing/src/engine/calculate");
type PricingDefaultsModule = typeof import("../packages/pricing/src/config/defaults");

function registerAliases() {
  const mod = Module as unknown as { _resolveFilename: Module["_resolveFilename"] };
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
}> {
  registerAliases();
  const [db, pricing, pricingDefaults] = await Promise.all([
    import("../apps/api/src/db"),
    import("../packages/pricing/src/engine/calculate"),
    import("../packages/pricing/src/config/defaults")
  ]);
  return { db, pricing, pricingDefaults };
}

async function truncateTables(db: DbModule) {
  const database = db.getDb();
  const { appointmentNotes, appointments, leads, quotes, outboxEvents, payments, properties, contacts } = db;

  await database.delete(appointmentNotes);
  await database.delete(appointments);
  await database.delete(leads);
  await database.delete(quotes);
  await database.delete(outboxEvents);
  await database.delete(payments);
  await database.delete(properties);
  await database.delete(contacts);
}

async function seedBaseline(db: DbModule, pricing: PricingModule, defaults: PricingDefaultsModule) {
  const database = db.getDb();
  const {
    contacts,
    properties,
    leads,
    quotes,
    appointments,
    outboxEvents
  } = db;

  const preferred = [
    "furniture",
    "single-item",
    "appliances",
    "yard-waste",
    "construction-debris",
    "hot-tub"
  ];
  const primaryService =
    defaults.defaultPricingContext.services.find((s) => preferred.includes(s.service))?.service ??
    "furniture";
  const zoneId = defaults.defaultPricingContext.zone.id;

  const runId = process.env["E2E_RUN_ID"] ?? `seed-${Date.now().toString(36)}`;
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
      source: leadSource
    })
    .returning({
      id: contacts.id
    });

  if (!contact) {
    throw new Error("Failed to insert baseline contact");
  }

  const [property] = await database
    .insert(properties)
    .values({
      contactId: contact.id,
      addressLine1: "123 E2E Lane",
      city: "Atlanta",
      state: "GA",
      postalCode: "30301",
      gated: false
    })
    .returning({
      id: properties.id
    });

  if (!property) {
    throw new Error("Failed to insert baseline property");
  }

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
        timeWindow: "morning"
      }
    })
    .returning({
      id: leads.id
    });

  if (!lead) {
    throw new Error("Failed to insert baseline lead");
  }

  const breakdown = pricing.calculateQuoteBreakdown({
    zoneId,
    selectedServices: [primaryService],
    applyBundles: true
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
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    })
    .returning({
      id: quotes.id
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
      rescheduleToken: randomUUID().replace(/-/g, "")
    })
    .returning({
      id: appointments.id
    });

  await database.insert(outboxEvents).values({
    type: "seed.initialized",
    payload: {
      contactId: contact.id,
      propertyId: property.id,
      leadId: lead.id,
      quoteId: quote?.id ?? null,
      appointmentId: appointment?.id ?? null
    }
  });

  return {
    contactId: contact.id,
    propertyId: property.id,
    leadId: lead.id,
    quoteId: quote?.id ?? null,
    appointmentId: appointment?.id ?? null
  };
}

async function main() {
  const start = Date.now();
  const modules = await loadModules();

  await truncateTables(modules.db);
  const summary = await seedBaseline(modules.db, modules.pricing, modules.pricingDefaults);

  console.log(
    JSON.stringify(
      {
        ...summary,
        durationMs: Date.now() - start
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
