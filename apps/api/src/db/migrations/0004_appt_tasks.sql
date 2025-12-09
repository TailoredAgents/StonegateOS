CREATE TABLE "appointment_tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "appointment_id" uuid NOT NULL,
  "title" text NOT NULL,
  "status" text DEFAULT 'open' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "appointment_tasks_appt_idx" ON "appointment_tasks" ("appointment_id");
--> statement-breakpoint
CREATE INDEX "appointment_tasks_status_idx" ON "appointment_tasks" ("status");
--> statement-breakpoint
ALTER TABLE "appointment_tasks" ADD CONSTRAINT "appointment_tasks_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "appointments"("id") ON DELETE cascade ON UPDATE no action;
