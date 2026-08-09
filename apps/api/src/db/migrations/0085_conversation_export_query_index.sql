-- Bound the sensitive conversation export's trailing-window scan to eligible
-- rows in the exact stable order used by the API. Whitespace-only messages,
-- drafts, internal notes, and outbound messages without a confirmed send are
-- excluded by the same predicate used at runtime.
CREATE INDEX IF NOT EXISTS "conversation_messages_export_eligible_effective_idx"
  ON "conversation_messages" (
    (coalesce("sent_at", "received_at", "created_at")),
    "created_at",
    "id"
  )
  WHERE "body" !~ E'^[\t\n\v\f\r ]*$'
    AND (
      "direction" = 'inbound'
      OR (
        "direction" = 'outbound'
        AND "delivery_status" IN ('sent', 'delivered')
        AND NOT (coalesce("metadata"->>'draft', 'false') = 'true')
      )
    );
