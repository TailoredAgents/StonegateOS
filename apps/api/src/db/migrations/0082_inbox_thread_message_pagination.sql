-- Supports bounded, stable keyset pagination for one Inbox conversation.
CREATE INDEX IF NOT EXISTS "conversation_messages_thread_created_id_idx"
  ON "conversation_messages" ("thread_id", "created_at", "id");
