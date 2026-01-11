import React from "react";
import { SubmitButton } from "@/components/SubmitButton";
import { CopyButton } from "@/components/CopyButton";
import { callAdminApi } from "../lib/api";
import { createRoleAction, createTeamMemberAction, updateTeamMemberAction } from "../actions";

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
  active: boolean;
  role: {
    id: string;
    name: string | null;
    slug: string | null;
  } | null;
};

export async function AccessSection(): Promise<React.ReactElement> {
  const [rolesRes, membersRes] = await Promise.all([
    callAdminApi("/api/admin/roles"),
    callAdminApi("/api/admin/team/members")
  ]);

  if (!rolesRes.ok) {
    throw new Error("Failed to load roles");
  }
  if (!membersRes.ok) {
    throw new Error("Failed to load team members");
  }

  const rolesPayload = (await rolesRes.json()) as { roles?: Role[] };
  const membersPayload = (await membersRes.json()) as { members?: TeamMember[] };

  const roles = rolesPayload.roles ?? [];
  const members = membersPayload.members ?? [];

  return (
    <section className="space-y-6">
      <header className="rounded-3xl border border-slate-200 bg-white/90 p-6 shadow-xl shadow-slate-200/60 backdrop-blur">
        <h2 className="text-xl font-semibold text-slate-900">Access Control</h2>
        <p className="mt-1 text-sm text-slate-600">
          Assign roles, permissions, and active access for the team.
        </p>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
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
          <form action={createRoleAction} className="mt-5 space-y-3 text-xs text-slate-600">
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
              <form key={member.id} action={updateTeamMemberAction} className="rounded-2xl border border-slate-200 bg-slate-50/80 px-4 py-3 text-xs text-slate-600">
                <input type="hidden" name="memberId" value={member.id} />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <div className="font-semibold text-slate-900">{member.name}</div>
                    <div className="text-[11px] text-slate-500">{member.email ?? "No email"}</div>
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-slate-500">
                      <span className="font-medium text-slate-600">ID:</span>
                      <code className="rounded bg-white/70 px-2 py-0.5">{member.id}</code>
                      <CopyButton value={member.id} label="Copy" />
                    </div>
                  </div>
                  <label className="flex items-center gap-2 text-[11px]">
                    <input type="checkbox" name="active" defaultChecked={member.active} className="h-4 w-4 rounded border-slate-300" />
                    Active
                  </label>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
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
                    placeholder="SMS phone (E.164, e.g. +16785551234)"
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
              </form>
            ))}
          </div>
          <form action={createTeamMemberAction} className="mt-5 space-y-3 text-xs text-slate-600">
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
