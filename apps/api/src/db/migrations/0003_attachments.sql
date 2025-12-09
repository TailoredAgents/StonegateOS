CREATE TABLE "appointment_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "appointment_id" uuid NOT NULL,
  "filename" text NOT NULL,
  "url" text NOT NULL,
  "content_type" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "appointment_attachments_appointment_idx" ON "appointment_attachments" ("appointment_id");
--> statement-breakpoint
ALTER TABLE "appointment_attachments" ADD CONSTRAINT "appointment_attachments_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE cascade ON UPDATE no action;
