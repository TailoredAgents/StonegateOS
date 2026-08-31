-- Quote V2 booking confirmation must retain the scheduling timezone that was
-- authoritative when the customer booked. Policy defaults are mutable and
-- cannot safely reconstruct historical local times or DST offsets.

ALTER TABLE "appointments"
  ADD COLUMN "scheduling_timezone" varchar(64);

-- Do not invent timezone evidence for existing rows. NOT VALID preserves
-- honest legacy records while enforcing a nonblank snapshot on every new
-- appointment bound to exact Quote V2 acceptance evidence.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_quote_scheduling_timezone_check"
  CHECK (
    "quote_response_id" IS NULL
    OR (
      "scheduling_timezone" IS NOT NULL
      AND char_length(btrim("scheduling_timezone")) BETWEEN 1 AND 64
    )
  ) NOT VALID;

-- Both sides of the acceptance/appointment relationship are unique. The
-- appointments.quote_response_id key was introduced with appointment
-- evidence; this key prevents two immutable responses from aliasing one job.
CREATE UNIQUE INDEX "quote_responses_appointment_key"
  ON "quote_responses" ("appointment_id")
  WHERE "appointment_id" IS NOT NULL;
