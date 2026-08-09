import { ApiClient } from "./api-client";

const client = new ApiClient();

export async function drainOutbox(limit = 10) {
  return client.post<{ processed: number; skipped: number; errors: number }>(
    "/api/admin/outbox/dispatch",
    { limit },
    {
      headers: {
        "x-actor-type": "worker",
        "x-actor-label": "outbox-dispatcher",
      },
    },
  );
}
