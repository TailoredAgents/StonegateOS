import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import {
  getDb,
  closeDbForTests,
  partnerAccounts,
  partnerAccountLocations,
  partnerAccountMemberships,
  partnerAccountServiceAgreements,
  partnerServiceCatalog,
  partnerServiceAddOns,
  partnerServiceAddOnOptions,
  partnerRateCards,
  partnerRateItems,
  partnerRateAddOnItems,
  partnerSchedulingProfiles,
  partnerSchedulingProfileResourceRequirements,
  scheduleResourcePools,
  scheduleResources,
  partnerBookings,
  appointments,
  partnerJobEvidence,
  mediaAssets,
  teamMembers,
  teamRoles,
  contacts,
} from "../src/db";
import { encryptPartnerLocationSecret } from "../src/lib/partner-location-secrets";
import { hashPassword } from "../src/lib/team-auth";

// This fixture only supplies an account-specific service agreement and resources.
// The browser creates the account, address, draft, uploaded photo and submitted job.
async function main() {
  const endpoint = new URL(process.env["DATABASE_URL"] ?? "http://invalid");
  if (
    process.env["NODE_ENV"] !== "test" ||
    !["127.0.0.1", "localhost"].includes(endpoint.hostname) ||
    endpoint.pathname !== "/portal_access_browser"
  )
    throw Error(
      "Only the disposable local portal_access_browser database is allowed",
    );
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    const value: unknown = chunk;
    if (typeof value === "string" || value instanceof Uint8Array)
      chunks.push(Buffer.from(value));
    else throw Error("Invalid local fixture input");
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
    action:
      | "configure"
      | "snapshot"
      | "location-secret"
      | "restricted-staff"
      | "release-profile";
    accountId: string;
    jobId?: string;
    locationId?: string;
    profileId?: string;
  };
  const db = getDb();
  try {
    const [account] = await db
      .select()
      .from(partnerAccounts)
      .where(eq(partnerAccounts.id, input.accountId));
    if (!account?.name.startsWith("Local CRM handoff "))
      throw Error("Explicit synthetic CRM handoff account required");
    if (input.action === "release-profile" && input.profileId) {
      const [profile] = await db
        .select({
          id: partnerSchedulingProfiles.id,
          poolKey: partnerSchedulingProfiles.capacityPoolKey,
        })
        .from(partnerSchedulingProfiles)
        .innerJoin(
          scheduleResourcePools,
          eq(
            partnerSchedulingProfiles.capacityPoolKey,
            scheduleResourcePools.key,
          ),
        )
        .where(
          and(
            eq(partnerSchedulingProfiles.id, input.profileId),
            eq(
              scheduleResourcePools.label,
              `Local handoff resources ${account.id}`,
            ),
          ),
        );
      if (!profile)
        throw Error("Account-bound local scheduling profile required");
      await db
        .update(partnerSchedulingProfiles)
        .set({ active: false })
        .where(eq(partnerSchedulingProfiles.id, profile.id));
      await db
        .update(partnerServiceAddOnOptions)
        .set({ active: false })
        .where(
          and(
            eq(partnerServiceAddOnOptions.serviceKey, "demo-hauloff"),
            eq(
              partnerServiceAddOnOptions.addOnKey,
              `handling_${profile.poolKey.slice("handoff_".length)}`,
            ),
          ),
        );
      process.stdout.write(JSON.stringify({ ok: true }));
    } else if (input.action === "restricted-staff") {
      const id = randomUUID(),
        email = `access-staff-${id}@example.test`;
      const [role] = await db
        .insert(teamRoles)
        .values({
          name: "Local handoff appointment reader",
          slug: `handoff_reader_${id.replaceAll("-", "")}`,
          permissions: ["appointments.read"],
        })
        .returning({ id: teamRoles.id });
      if (!role) throw Error("Local read-only role was not created");
      await db.insert(teamMembers).values({
        id,
        roleId: role.id,
        name: "Local handoff appointment reader",
        email,
        emailNormalized: email,
        emailIdentityStatus: "ready",
        active: true,
        passwordHash: hashPassword(
          "Local staff access browser passphrase 2026!",
        ),
        passwordSetAt: new Date(),
      });
      process.stdout.write(JSON.stringify({ id }));
    } else if (input.action === "configure") {
      const suffix = randomUUID().replaceAll("-", "");
      const serviceKey = "demo-hauloff",
        addOnKey = `handling_${suffix}`,
        poolKey = `handoff_${suffix}`;
      const profileId = randomUUID(),
        rateCardId = randomUUID();
      const contactId = account.portalContactId ?? randomUUID();
      await db.transaction(async (tx) => {
        if (!account.portalContactId) {
          await tx.insert(contacts).values({
            id: contactId,
            firstName: "Local",
            lastName: "Handoff company",
            company: account.name,
            partnerAccountId: account.id,
            partnerStatus: "partner",
            source: "partner_crm_handoff_local_test",
          });
          await tx
            .update(partnerAccounts)
            .set({ portalContactId: contactId })
            .where(eq(partnerAccounts.id, account.id));
        }
        await tx
          .update(partnerAccountMemberships)
          .set({ persona: "commercial_client" })
          .where(eq(partnerAccountMemberships.partnerAccountId, account.id));
        await tx
          .insert(partnerServiceCatalog)
          .values({
            key: serviceKey,
            label: "Demo + haul-off",
            description: "Local handoff coverage only.",
            active: true,
            instantBookable: false,
          })
          .onConflictDoNothing();
        await tx.insert(partnerServiceAddOns).values({
          key: addOnKey,
          label: "Extra handling",
          description: "Additional handling per item.",
          unitLabel: "item",
        });
        await tx.insert(partnerServiceAddOnOptions).values({
          serviceKey,
          addOnKey,
          minimumQuantity: 1,
          maximumQuantity: 5,
          requiresReview: true,
        });
        await tx.insert(partnerAccountServiceAgreements).values({
          partnerAccountId: account.id,
          active: true,
          agreementLabel: "Local facility agreement",
          currency: "USD",
          effectiveFrom: new Date(Date.now() - 86_400_000),
          inclusions: ["Facility collection"],
          exclusions: ["Undeclared materials"],
          serviceEntitlements: [
            {
              serviceKey,
              pricingState: "contracted",
              inclusions: [],
              exclusions: [],
              quoteRule: null,
            },
          ],
          revision: 1,
        });
        await tx.insert(partnerRateCards).values({
          id: rateCardId,
          orgContactId: contactId,
          partnerAccountId: account.id,
          active: true,
          currency: "USD",
          version: 1,
        });
        await tx.insert(partnerRateItems).values([
          {
            rateCardId,
            serviceKey,
            tierKey: "small",
            label: "Standard collection",
            amountCents: 25000,
          },
          {
            rateCardId,
            serviceKey,
            tierKey: "large",
            label: "Large collection",
            amountCents: 45000,
          },
        ]);
        await tx
          .insert(partnerRateAddOnItems)
          .values({ rateCardId, serviceKey, addOnKey, unitAmountCents: 3500 });
        await tx.insert(scheduleResourcePools).values({
          key: poolKey,
          label: `Local handoff resources ${account.id}`,
          capacityUnits: 1,
        });
        await tx.insert(partnerSchedulingProfiles).values({
          id: profileId,
          serviceKey,
          version: 1_000_000 + Number.parseInt(suffix.slice(0, 7), 16),
          durationMinutes: 60,
          travelBufferMinutes: 0,
          capacityPoolKey: poolKey,
          capacityUnits: 1,
          instantConfirmationEnabled: false,
          effectiveFrom: new Date(Date.now() - 86_400_000),
        });
        // The schema installs compatibility requirements when a profile is
        // created; update only this new fixture profile with explicit ones.
        for (const kind of ["crew", "truck"] as const) {
          await tx.insert(scheduleResources).values({
            capacityPoolKey: poolKey,
            kind,
            label: `Local handoff ${kind}`,
            capacityUnits: 1,
            source: "staff",
          });
          await tx
            .insert(partnerSchedulingProfileResourceRequirements)
            .values({
              schedulingProfileId: profileId,
              resourceKind: kind,
              quantity: 1,
              capacityUnits: 1,
              requiredSkillKeys: [],
              source: "staff",
            })
            .onConflictDoUpdate({
              target: [
                partnerSchedulingProfileResourceRequirements.schedulingProfileId,
                partnerSchedulingProfileResourceRequirements.resourceKind,
              ],
              set: {
                quantity: 1,
                capacityUnits: 1,
                requiredSkillKeys: [],
                source: "staff",
              },
            });
        }
      });
      const [service] = await db
        .select({ label: partnerServiceCatalog.label })
        .from(partnerServiceCatalog)
        .where(eq(partnerServiceCatalog.key, serviceKey));
      process.stdout.write(
        JSON.stringify({
          serviceKey,
          serviceLabel: service!.label,
          addOnKey,
          profileId,
        }),
      );
    } else if (input.action === "location-secret" && input.locationId) {
      process.env["PARTNER_LOCATION_SECRET_KEY_BASE64"] = Buffer.alloc(
        32,
        1,
      ).toString("base64");
      const encrypted = encryptPartnerLocationSecret(
        "local-private-handoff-door-code-915",
      );
      const rows = await db
        .update(partnerAccountLocations)
        .set({
          accessSecretCiphertext: encrypted.ciphertext,
          accessSecretKeyVersion: encrypted.keyVersion,
        })
        .where(
          and(
            eq(partnerAccountLocations.id, input.locationId),
            eq(partnerAccountLocations.partnerAccountId, account.id),
          ),
        )
        .returning({ id: partnerAccountLocations.id });
      if (rows.length !== 1)
        throw Error("Explicit scoped local location required");
      process.stdout.write(JSON.stringify({ ok: true }));
    } else if (input.action === "snapshot" && input.jobId) {
      const [job] = await db
        .select()
        .from(partnerBookings)
        .where(
          and(
            eq(partnerBookings.id, input.jobId),
            eq(partnerBookings.partnerAccountId, account.id),
          ),
        );
      if (!job?.appointmentId) throw Error("Scoped local job not found");
      const [appointment] = await db
        .select()
        .from(appointments)
        .where(eq(appointments.id, job.appointmentId));
      const evidence = await db
        .select({
          id: partnerJobEvidence.id,
          category: partnerJobEvidence.category,
          caption: partnerJobEvidence.caption,
          status: mediaAssets.status,
        })
        .from(partnerJobEvidence)
        .innerJoin(
          mediaAssets,
          and(
            eq(partnerJobEvidence.mediaAssetId, mediaAssets.id),
            eq(mediaAssets.partnerAccountId, account.id),
          ),
        )
        .where(
          and(
            eq(partnerJobEvidence.partnerBookingId, job.id),
            eq(partnerJobEvidence.partnerAccountId, account.id),
          ),
        );
      process.stdout.write(JSON.stringify({ job, appointment, evidence }));
    } else throw Error("Unknown local fixture action");
  } finally {
    await closeDbForTests();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
