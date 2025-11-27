import { getDb, properties } from "@/db";
import { forwardGeocode } from "@/lib/geocode";
import { eq, isNull } from "drizzle-orm";

async function main() {
  const db = getDb();
  const rows = await db
    .select({
      id: properties.id,
      addressLine1: properties.addressLine1,
      city: properties.city,
      state: properties.state,
      postalCode: properties.postalCode
    })
    .from(properties)
    .where(isNull(properties.lat));

  console.log(`Found ${rows.length} properties without lat/lng`);
  let success = 0;
  for (const row of rows) {
    if (!row.addressLine1) continue;
    const geo = await forwardGeocode({
      addressLine1: row.addressLine1,
      city: row.city ?? undefined,
      state: row.state ?? undefined,
      postalCode: row.postalCode ?? undefined
    });
    if (!geo) continue;
    await db
      .update(properties)
      .set({
        lat: geo.lat.toString(),
        lng: geo.lng.toString(),
        updatedAt: new Date()
      })
      .where(eq(properties.id, row.id));
    success += 1;
  }
  console.log(`Geocoded ${success}/${rows.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
