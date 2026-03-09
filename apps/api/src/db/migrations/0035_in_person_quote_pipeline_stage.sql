DO $$ BEGIN
  ALTER TYPE "public"."crm_pipeline_stage" ADD VALUE IF NOT EXISTS 'in_person_quote' AFTER 'contacted';
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

