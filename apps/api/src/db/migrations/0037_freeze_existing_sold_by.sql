UPDATE "appointments" AS "a"
SET "sold_by_member_id" = "c"."salesperson_member_id"
FROM "contacts" AS "c"
WHERE "a"."contact_id" = "c"."id"
  AND "a"."sold_by_member_id" IS NULL
  AND "c"."salesperson_member_id" IS NOT NULL;
