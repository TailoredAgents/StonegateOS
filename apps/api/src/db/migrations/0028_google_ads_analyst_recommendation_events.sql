create table if not exists "google_ads_analyst_recommendation_events" (
  "id" uuid primary key default gen_random_uuid(),
  "recommendation_id" uuid not null references "google_ads_analyst_recommendations" ("id") on delete cascade,
  "report_id" uuid not null references "google_ads_analyst_reports" ("id") on delete cascade,
  "kind" text not null,
  "from_status" text,
  "to_status" text not null,
  "note" text,
  "actor_member_id" uuid references "team_members" ("id") on delete set null,
  "actor_source" text not null default 'ui',
  "created_at" timestamptz not null default now()
);

create index if not exists "google_ads_analyst_rec_events_report_idx"
  on "google_ads_analyst_recommendation_events" ("report_id", "created_at");

create index if not exists "google_ads_analyst_rec_events_rec_idx"
  on "google_ads_analyst_recommendation_events" ("recommendation_id", "created_at");

create index if not exists "google_ads_analyst_rec_events_actor_idx"
  on "google_ads_analyst_recommendation_events" ("actor_member_id", "created_at");
