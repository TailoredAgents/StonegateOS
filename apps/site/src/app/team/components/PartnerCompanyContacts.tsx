import type { TeamRequestPrincipal } from "@/lib/team-principal";
import { callAdminApiAs } from "../lib/api";
import { partnerCompanyHref } from "../partner-company-navigation";
import { teamButtonClass } from "./team-ui";

/** Registered people explicitly bound to this company; never guessed from CRM names. */
export async function PartnerCompanyContacts({
  principal,
  accountId,
}: {
  principal: TeamRequestPrincipal;
  accountId: string;
}) {
  let people: Array<{
    id: string;
    name: string;
    email: string;
    status: string;
  }> | null = null;
  let hasMore = false;
  try {
    const response = await callAdminApiAs(
      principal,
      `/api/admin/partner-management/v1/memberships?accountId=${accountId}&limit=5`,
      { timeoutMs: 10_000 },
    );
    const payload = response.ok
      ? ((await response.json()) as {
          ok?: boolean;
          items?: Array<Record<string, unknown>>;
          page?: { hasMore?: boolean };
        })
      : null;
    if (
      payload?.ok === true &&
      Array.isArray(payload.items) &&
      payload.items.every(
        (item) =>
          item["partnerAccountId"] === accountId &&
          typeof item["id"] === "string" &&
          typeof item["personName"] === "string" &&
          typeof item["personEmail"] === "string" &&
          typeof item["status"] === "string",
      )
    ) {
      people = payload.items.map((item) => ({
        id: String(item["id"]),
        name: String(item["personName"]),
        email: String(item["personEmail"]),
        status: String(item["status"]),
      }));
      hasMore = payload.page?.hasMore === true;
    }
  } catch {
    /* Leave a retry path instead of reporting an empty company. */
  }
  return (
    <section className="rounded-xl border border-[color:var(--team-border)] bg-[color:var(--team-surface)] p-4">
      <h3 className="font-semibold">Company contacts</h3>
      {people === null ? (
        <p role="alert" className="mt-2 text-sm">
          Company contacts could not be loaded. Open People & invitations to
          retry.
        </p>
      ) : people.length ? (
        <ul className="mt-3 divide-y divide-[color:var(--team-border)]">
          {people.map((person) => (
            <li key={person.id} className="py-3">
              <p className="break-words text-sm font-semibold">{person.name}</p>
              <p className="break-words text-sm text-[color:var(--team-text-muted)]">
                {person.email} · {person.status.replaceAll("_", " ")}
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm">
          No registered people are linked to this company yet.
        </p>
      )}
      <a
        href={partnerCompanyHref(accountId, "people")}
        className={`${teamButtonClass("secondary", "sm")} mt-3`}
      >
        {hasMore ? "View all company people" : "Manage people & invitations"}
      </a>
    </section>
  );
}
