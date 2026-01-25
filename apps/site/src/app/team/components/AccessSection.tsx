import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { CopyButton } from "@/components/CopyButton";
import { callAdminApi } from "../lib/api";

type Role = {
  id: string;
  name: string;
  slug: string;
  permissions: string[];
};

type TeamMember = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  defaultCrewSplitBps: number | null;
  permissionsGrant: string[];
  permissionsDeny: string[];
  active: boolean;
  role: {
    id: string;
    name: string | null;
    slug: string | null;
  } | null;
};

export async function AccessSection(): Promise<React.ReactElement> {
  let roles: Role[] = [];
  let members: TeamMember[] = [];
  let loadError: string | null = null;
  let defaultAssigneeMemberId: string | null = null;

  try {
    const [rolesRes, membersRes, settingsRes] = await Promise.all([
      callAdminApi("/api/admin/roles"),
      callAdminApi("/api/admin/team/members"),
      callAdminApi("/api/admin/sales/settings")
    ]);

    if (!rolesRes.ok) {
      loadError = `Failed to load roles (HTTP ${rolesRes.status})`;
    } else {
      const rolesPayload = (await rolesRes.json()) as { roles?: Role[] };
      roles = rolesPayload.roles ?? [];
    }

    if (!membersRes.ok) {
      loadError = loadError ?? `Failed to load team members (HTTP ${membersRes.status})`;
    } else {
      const membersPayload = (await membersRes.json()) as { members?: TeamMember[] };
      members = (membersPayload.members ?? []).map((member) => ({
        ...member,
        permissionsGrant: Array.isArray(member.permissionsGrant) ? member.permissionsGrant : [],
        permissionsDeny: Array.isArray(member.permissionsDeny) ? member.permissionsDeny : []
      }));
    }

    if (settingsRes.ok) {
      const settingsPayload = (await settingsRes.json()) as { defaultAssigneeMemberId?: string | null };
      defaultAssigneeMemberId =
        typeof settingsPayload.defaultAssigneeMemberId === "string" && settingsPayload.defaultAssigneeMemberId.trim().length > 0
          ? settingsPayload.defaultAssigneeMemberId.trim()
          : null;
    }
  } catch (error) {
    loadError = `Failed to load access control: ${(error as Error).message}`;
  }

  const permissionOptions = Array.from(new Set(roles.flatMap((role) => role.permissions ?? []))).sort((a, b) =>
    a.localeCompare(b)
  );

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <h2 className="text-xl font-semibold text-slate-900">Access Control</h2>
        <p className="mt-1 text-sm text-slate-600">
          Assign roles, permissions, and active access for the team.
        </p>
        {loadError ? <p className="mt-2 text-sm text-amber-700">{loadError}</p> : null}
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <h3 className="text-base font-semibold text-slate-900">Lead routing</h3>
          <p className="text-xs text-slate-500">Choose who new leads are assigned to by default.</p>
          <form action="/api/team/access/sales-settings" method="post" className="mt-4 flex flex-wrap items-center gap-3">
            <select
              name="defaultAssigneeMemberId"
              defaultValue={defaultAssigneeMemberId ?? ""}
              className="min-w-[240px] rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
            >
              <option value="">Auto (first active team member)</option>
              {members
                .filter((member) => member.active)
                .map((member) => (
                  <option key={member.id} value={member.id}>
                    {member.name}
                  </option>
                ))}
            </select>
            <SubmitButton
              className="rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
              pendingLabel="Saving..."
            >
              Save default
            </SubmitButton>
          </form>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <h3 className="text-base font-semibold text-slate-900">Roles</h3>
          <p className="text-xs text-slate-500">Define what each role can do in the console.</p>
          <div className="mt-4 space-y-3">
            {roles.map((role) => (
              <div key={role.id} className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-xs text-slate-600">
                <div className="flex items-center justify-between">
                  <span className="font-semibold text-slate-900">{role.name}</span>
                  <span className="text-[10px] uppercase tracking-wide text-slate-400">{role.slug}</span>
                </div>
                <div className="mt-2 text-[11px] text-slate-500">
                  {role.permissions.length ? role.permissions.join(", ") : "No permissions set"}
                </div>
              </div>
            ))}
          </div>
          <form action="/api/team/access/roles" method="post" className="mt-5 space-y-3 text-xs text-slate-600">
            <label className="flex flex-col gap-1">
              <span>Role name</span>
              <input
                name="name"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span>Slug</span>
              <input
                name="slug"
                placeholder="office"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span>Permissions (comma separated)</span>
              <input
                name="permissions"
                placeholder="messages.send, policy.write"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
            <SubmitButton
              className="inline-flex items-center rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
              pendingLabel="Saving..."
            >
              Add role
            </SubmitButton>
          </form>
        </div>

        <div className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur">
          <h3 className="text-base font-semibold text-slate-900">Team members</h3>
          <p className="text-xs text-slate-500">Assign a role and mark active access.</p>
          <div className="mt-4 space-y-3">
            {members.map((member) => (
              <div
                key={member.id}
                className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-xs text-slate-600"
              >
                <form action={`/api/team/access/members/${member.id}`} method="post" className="space-y-3">
                  <input type="hidden" name="memberId" value={member.id} />
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-[220px] flex-1">
                      <div className="grid gap-2 sm:grid-cols-2">
                        <label className="flex flex-col gap-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Name</span>
                          <input
                            name="name"
                            defaultValue={member.name}
                            required
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                          />
                        </label>
                        <label className="flex flex-col gap-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">Email</span>
                          <input
                            name="email"
                            type="email"
                            defaultValue={member.email ?? ""}
                            placeholder="devon@stonegatejunkremoval.com"
                            className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
                          />
                        </label>
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                        <span className="font-medium text-slate-600">ID:</span>
                        <code className="rounded bg-white/70 px-2 py-0.5">{member.id}</code>
                        <CopyButton value={member.id} label="Copy" />
                      </div>
                    </div>
                    <label className="flex items-center gap-2 text-[11px]">
                      <input
                        type="checkbox"
                        name="active"
                        defaultChecked={member.active}
                        className="mt-1 h-4 w-4 rounded border-slate-300"
                      />
                      Active
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      name="roleId"
                      defaultValue={member.role?.id ?? ""}
                      className="rounded-full border border-slate-200 px-3 py-2 text-xs text-slate-700"
                    >
                      <option value="">No role</option>
                      {roles.map((role) => (
                        <option key={role.id} value={role.id}>
                          {role.name}
                        </option>
                      ))}
                    </select>
                    <input
                      name="phone"
                      defaultValue={member.phone ?? ""}
                      placeholder="SMS phone (US), e.g. 6785551234"
                      className="min-w-[240px] flex-1 rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
                    />
                    <input
                      name="defaultCrewSplitPercent"
                      defaultValue={member.defaultCrewSplitBps !== null ? String(member.defaultCrewSplitBps / 100) : ""}
                      placeholder="Crew split % (e.g. 50)"
                      inputMode="decimal"
                      className="w-[170px] rounded-full border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700"
                    />
                    <SubmitButton
                      className="rounded-full border border-slate-200 px-3 py-2 text-xs text-slate-600 transition hover:border-primary-300 hover:text-primary-700"
                      pendingLabel="Saving..."
                    >
                      Update
                    </SubmitButton>
                  </div>

                  {permissionOptions.length ? (
                    <details className="rounded-2xl border border-slate-200 bg-white/70 px-4 py-3">
                      <summary className="cursor-pointer text-[11px] font-semibold text-slate-700">
                        Individual permission overrides
                      </summary>
                      <p className="mt-2 text-[11px] text-slate-500">
                        Role permissions are the baseline. Grants add permissions, denies remove them (deny wins).
                      </p>

                      <input type="hidden" name="permissionsGrant_present" value="1" />
                      <input type="hidden" name="permissionsDeny_present" value="1" />

                      <div className="mt-3 grid gap-4 sm:grid-cols-2">
                        <div>
                          <h4 className="text-[11px] font-semibold text-slate-700">Grant</h4>
                          <div className="mt-2 grid gap-1">
                            {permissionOptions.map((permission) => (
                              <label
                                key={`grant-${member.id}-${permission}`}
                                className="flex items-center gap-2 text-xs text-slate-700"
                              >
                                <input
                                  type="checkbox"
                                  name="permissionsGrant"
                                  value={permission}
                                  defaultChecked={member.permissionsGrant.includes(permission)}
                                  className="h-4 w-4 rounded border-slate-300"
                                />
                                <span className="font-mono text-[11px]">{permission}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                        <div>
                          <h4 className="text-[11px] font-semibold text-slate-700">Deny</h4>
                          <div className="mt-2 grid gap-1">
                            {permissionOptions.map((permission) => (
                              <label
                                key={`deny-${member.id}-${permission}`}
                                className="flex items-center gap-2 text-xs text-slate-700"
                              >
                                <input
                                  type="checkbox"
                                  name="permissionsDeny"
                                  value={permission}
                                  defaultChecked={member.permissionsDeny.includes(permission)}
                                  className="h-4 w-4 rounded border-slate-300"
                                />
                                <span className="font-mono text-[11px]">{permission}</span>
                              </label>
                            ))}
                          </div>
                        </div>
                      </div>
                    </details>
                  ) : null}
                </form>
                <details className="mt-3 rounded-2xl border border-red-200 bg-red-50/60 px-4 py-3">
                  <summary className="cursor-pointer text-[11px] font-semibold text-red-700">Danger zone</summary>
                  <div className="mt-3 space-y-2 text-[11px] text-red-700">
                    <p>Delete this team member. This cannot be undone.</p>
                    <form action={`/api/team/access/members/${member.id}/delete`} method="post" className="flex flex-wrap items-center gap-2">
                      <input
                        name="confirm"
                        placeholder='Type "DELETE" to confirm'
                        className="min-w-[220px] flex-1 rounded-full border border-red-200 bg-white px-3 py-2 text-xs text-slate-700"
                      />
                      <SubmitButton
                        className="rounded-full bg-red-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-red-200/50 transition hover:bg-red-700"
                        pendingLabel="Deleting..."
                      >
                        Delete
                      </SubmitButton>
                    </form>
                  </div>
                </details>
              </div>
            ))}
          </div>
          <form action="/api/team/access/members" method="post" className="mt-5 space-y-3 text-xs text-slate-600">
            <label className="flex flex-col gap-1">
              <span>Name</span>
              <input
                name="name"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span>Email</span>
              <input
                name="email"
                type="email"
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span>Role</span>
              <select
                name="roleId"
                defaultValue=""
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-700 shadow-sm focus:border-primary-500 focus:outline-none focus:ring-2 focus:ring-primary-100"
              >
                <option value="">No role</option>
                {roles.map((role) => (
                  <option key={role.id} value={role.id}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" name="active" defaultChecked className="h-4 w-4 rounded border-slate-300" />
              Active
            </label>
            <SubmitButton
              className="inline-flex items-center rounded-full bg-primary-600 px-4 py-2 text-xs font-semibold text-white shadow-lg shadow-primary-200/50 transition hover:bg-primary-700"
              pendingLabel="Saving..."
            >
              Add member
            </SubmitButton>
          </form>
        </div>
      </div>
    </section>
  );
}
