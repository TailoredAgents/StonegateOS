import "dotenv/config";
import Module from "node:module";
import path from "node:path";
import { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";

type ResolvedModules = {
  POST: typeof import("../apps/api/app/api/web/lead-intake/route") extends { POST: infer T } ? T : never;
  getDb: typeof import("../apps/api/src/db") extends { getDb: infer T } ? T : never;
  contacts: typeof import("../apps/api/src/db/schema") extends { contacts: infer T } ? T : never;
  properties: typeof import("../apps/api/src/db/schema") extends { properties: infer T } ? T : never;
  leads: typeof import("../apps/api/src/db/schema") extends { leads: infer T } ? T : never;
  outboxEvents: typeof import("../apps/api/src/db/schema") extends { outboxEvents: infer T } ? T : never;
};

function registerAliases() {
  const originalResolve = (Module as unknown as { _resolveFilename: Module['_resolveFilename'] })._resolveFilename;
  (Module as unknown as { _resolveFilename: Module['_resolveFilename'] })._resolveFilename = function (
    request: string,
    parent: any,
    isMain: boolean,
    options: any
  ) {
    if (request.startsWith("@/")) {
      const absolute = path.resolve("apps/api/src", request.slice(2));
      return originalResolve.call(this, absolute, parent, isMain, options);
    }
    if (request.startsWith("@myst-os/")) {
      const [pkg, ...rest] = request.replace("@myst-os/", "").split("/");
      const absolute = path.resolve("packages", pkg, "src", ...rest);
      return originalResolve.call(this, absolute, parent, isMain, options);
    }
    return originalResolve.call(this, request, parent, isMain, options);
  };
}

async function loadModules(): Promise<ResolvedModules> {
  registerAliases();
  const routeModule = await import("../apps/api/app/api/web/lead-intake/route");
  const dbModule = await import("../apps/api/src/db");
  const schemaModule = await import("../apps/api/src/db/schema");
  return {
    POST: routeModule.POST,
    getDb: dbModule.getDb,
    contacts: schemaModule.contacts,
    properties: schemaModule.properties,
    leads: schemaModule.leads,
    outboxEvents: schemaModule.outboxEvents
  };
}

async function main() {
  const { POST, getDb, contacts, properties, leads, outboxEvents } = await loadModules();

  const payload = {
    service: "furniture",
    name: "CLI Test",
    phone: "404-555-0123",
    email: "cli-test@example.com",
    addressLine1: "123 Main Street",
    city: "Woodstock",
    state: "GA",
    postalCode: "30188",
    notes: "Automated integration test",
    consent: true,
    utm: {
      source: "cli",
      medium: "automation",
      campaign: "publish-and-capture"
    },
    gclid: "test-gclid",
    fbclid: "test-fbclid",
    hp_company: ""
  };

  const request = new NextRequest("http://localhost:3001/api/web/lead-intake", {
    method: "POST",
    headers: new Headers({
      "content-type": "application/json",
      "x-forwarded-for": "203.0.113.10",
      referer: "http://localhost:3000/"
    }),
    body: JSON.stringify(payload)
  });

  const response = await POST(request);
  const body = await response.json();
  console.log("response", response.status, body);

  const db = getDb();

  const [contact] = await db
    .select()
    .from(contacts)
    .where(eq(contacts.email, payload.email))
    .limit(1);

  if (!contact) {
    throw new Error("Contact not found after submission");
  }

  const [property] = await db
    .select()
    .from(properties)
    .where(
      and(
        eq(properties.contactId, contact.id),
        eq(properties.addressLine1, payload.addressLine1),
        eq(properties.postalCode, payload.postalCode)
      )
    )
    .limit(1);

  const [lead] = await db
    .select()
    .from(leads)
    .where(eq(leads.contactId, contact.id))
    .orderBy(desc(leads.createdAt))
    .limit(1);

  const [outbox] = await db
    .select()
    .from(outboxEvents)
    .where(eq(outboxEvents.type, "lead.created"))
    .orderBy(desc(outboxEvents.createdAt))
    .limit(1);

  console.log("contact", {
    id: contact.id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phoneE164: contact.phoneE164
  });
  console.log("property", property);
  console.log("lead", lead);
  console.log("outbox", outbox);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
