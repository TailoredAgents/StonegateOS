-- Quote responses remain immutable evidence. Booking is the one controlled
-- exception: it may attach a response to its exact appointment once, after
-- the appointment already points back to the same response and version.

CREATE OR REPLACE FUNCTION "quote_v2_guard_response_mutation"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD."response_type" = 'accepted'
    AND OLD."appointment_id" IS NULL
    AND NEW."appointment_id" IS NOT NULL
    AND (to_jsonb(NEW) - 'appointment_id')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'appointment_id')
    AND EXISTS (
      SELECT 1
      FROM "appointments" AS appointment
      INNER JOIN "quotes" AS quote
        ON quote."id" = OLD."quote_id"
      WHERE appointment."id" = NEW."appointment_id"
        AND appointment."quote_response_id" = OLD."id"
        AND appointment."quote_version_id" = OLD."quote_version_id"
        AND appointment."contact_id" = quote."contact_id"
        AND appointment."property_id" IS NOT DISTINCT FROM quote."property_id"
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION '% is immutable evidence; append a correction instead', TG_TABLE_NAME;
END;
$$;

DROP TRIGGER "quote_responses_immutable" ON "quote_responses";
CREATE TRIGGER "quote_responses_immutable"
  BEFORE UPDATE OR DELETE ON "quote_responses"
  FOR EACH ROW EXECUTE FUNCTION "quote_v2_guard_response_mutation"();
