import Link from "next/link";
import { redirect } from "next/navigation";
import { requireCurrentTeamPrincipal } from "@/lib/team-principal";
import { callAdminApiAs } from "../../lib/api";
import { IntegrationControl } from "./Controls";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "Agent connections | Stonegate",
  robots: { index: false, follow: false },
};
type Integration = {
  id: string;
  name: string;
  tools: string[];
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
};
type Operation = {
  id: string;
  name: string;
  tool: string;
  payload: unknown;
  payload_hash: string;
  status: string;
  expires_at: string;
  result: unknown;
};
export default async function IntegrationPage() {
  const principal = await requireCurrentTeamPrincipal();
  if (principal.roleSlug !== "owner") redirect("/team");
  const response = await callAdminApiAs(
    principal,
    "/api/admin/agent-integrations",
  );
  if (!response.ok)
    return (
      <main className="mx-auto max-w-4xl p-8">
        <Link href="/team">← Team workspace</Link>
        <h1 className="mt-6 text-2xl font-semibold">
          Agent connections are unavailable
        </h1>
        <p className="mt-3">
          Check the API and database migration before creating or approving
          access.
        </p>
      </main>
    );
  const data = (await response.json()) as {
    integrations: Integration[];
    operations: Operation[];
    activity: {
      tool: string;
      outcome: string;
      name: string;
      created_at: string;
    }[];
  };
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-8 text-slate-900">
      <div className="mx-auto max-w-5xl space-y-8">
        <Link href="/team" className="text-sm font-medium text-slate-600">
          ← Team workspace
        </Link>
        <header>
          <h1 className="text-3xl font-semibold tracking-tight">
            Agent connections
          </h1>
          <p className="mt-3 max-w-3xl text-slate-600">
            Connect your agent to customer history and sales operations. Review
            proposed actions here. Approving access does not launch a campaign.
          </p>
        </header>
        <section className="rounded-2xl border border-slate-200 bg-white p-6">
          <h2 className="mb-4 text-lg font-semibold">Connect an agent</h2>
          <p className="mb-5 text-sm text-slate-600">
            Full customer-operations access with recorded activity. External
            sends and sensitive changes require an approved action. Tokens
            expire after 30 days and can be revoked immediately.
          </p>
          <IntegrationControl action="create" />
        </section>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Connections</h2>
          {data.integrations.length === 0 && <p>No connections yet.</p>}
          {data.integrations.map((i) => (
            <article
              key={i.id}
              className="rounded-2xl border border-slate-200 bg-white p-5"
            >
              <h3 className="font-semibold">{i.name}</h3>
              <p className="my-2 text-sm text-slate-600">
                {i.revoked_at
                  ? "Revoked"
                  : new Date(i.expires_at) < new Date()
                    ? "Expired"
                    : "Active"}{" "}
                · {i.tools.length} capabilities · expires{" "}
                {new Date(i.expires_at).toLocaleDateString("en-US", {
                  timeZone: "America/New_York",
                })}
              </p>
              {!i.revoked_at && (
                <IntegrationControl action="revoke" id={i.id} />
              )}
            </article>
          ))}
        </section>
        <section className="space-y-3">
          <h2 className="text-xl font-semibold">Action review and receipts</h2>
          <p className="text-sm text-slate-600">
            Review the exact destination, content and changes below. Approval
            expires with the action. Revoke a connection to prevent further
            claims; already submitted provider work cannot be recalled.
          </p>
          {data.operations.length === 0 && <p>No proposed actions.</p>}
          {data.operations.map((o) => (
            <article
              key={o.id}
              className="rounded-2xl border border-slate-200 bg-white p-5"
            >
              <h3 className="font-semibold">
                {o.name} · {o.tool}
              </h3>
              <p className="my-2 text-sm">
                {o.status} · expires{" "}
                {new Date(o.expires_at).toLocaleString("en-US", {
                  timeZone: "America/New_York",
                })}{" "}
                Eastern
              </p>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-slate-100 p-4 text-xs">
                {JSON.stringify(o.payload, null, 2)}
              </pre>
              {o.status === "pending" &&
                new Date(o.expires_at) > new Date() && (
                  <div className="mt-4 flex flex-wrap gap-3">
                    <IntegrationControl
                      action="approve"
                      id={o.id}
                      payloadHash={o.payload_hash}
                    />
                    <IntegrationControl
                      action="reject"
                      id={o.id}
                      payloadHash={o.payload_hash}
                    />
                  </div>
                )}
              {o.result != null && (
                <details className="mt-3">
                  <summary>Result</summary>
                  <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                    {JSON.stringify(o.result, null, 2)}
                  </pre>
                </details>
              )}
            </article>
          ))}
        </section>
        <section>
          <h2 className="mb-3 text-xl font-semibold">Recent activity</h2>
          <div className="overflow-auto rounded-2xl border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th className="p-3">Connection</th>
                  <th className="p-3">Tool</th>
                  <th className="p-3">Result</th>
                </tr>
              </thead>
              <tbody>
                {data.activity.map((e, n) => (
                  <tr key={n} className="border-t border-slate-100">
                    <td className="p-3">{e.name}</td>
                    <td className="p-3">{e.tool}</td>
                    <td className="p-3">{e.outcome}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}
