ALTER TABLE "call_records" ADD COLUMN "note_task_id" uuid;
DO $$ BEGIN
 ALTER TABLE "call_records" ADD CONSTRAINT "call_records_note_task_id_crm_tasks_id_fk" FOREIGN KEY ("note_task_id") REFERENCES "public"."crm_tasks"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
