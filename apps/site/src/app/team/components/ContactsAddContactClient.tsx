"use client";

import React from "react";
import { PIPELINE_STAGES, labelForPipelineStage } from "./pipeline.stages";
import { TEAM_INPUT, teamButtonClass } from "./team-ui";

type Props = {
  teamMembers: Array<{ id: string; name: string }>;
};

export function ContactsAddContactClient({ teamMembers }: Props): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const [showAddress, setShowAddress] = React.useState(false);

  return (
    <>
      <button type="button" className={teamButtonClass("primary")} onClick={() => setOpen(true)}>
        Add contact
      </button>

      {open ? (
        <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/30 p-4">
          <div className="mt-10 w-full max-w-2xl rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h3 className="text-lg font-semibold text-slate-900">New contact</h3>
                <p className="mt-1 text-sm text-slate-600">
                  Add a homeowner lead or a manual contact. Address is optional.
                </p>
              </div>
              <button
                type="button"
                className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-600 hover:border-primary-300 hover:text-primary-700"
                onClick={() => setOpen(false)}
              >
                Close
              </button>
            </div>

            <form action="/api/team/contacts" method="post" className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                <span>First name</span>
                <input name="firstName" required className={TEAM_INPUT} />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                <span>Last name</span>
                <input name="lastName" required className={TEAM_INPUT} />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                <span>Email</span>
                <input name="email" type="email" placeholder="optional" className={TEAM_INPUT} />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                <span>Phone</span>
                <input name="phone" type="tel" placeholder="optional" className={TEAM_INPUT} />
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                <span>Assigned to</span>
                <select name="salespersonMemberId" defaultValue="" className={TEAM_INPUT}>
                  <option value="">(Select)</option>
                  {teamMembers.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600">
                <span>Pipeline stage</span>
                <select name="pipelineStage" defaultValue="new" className={TEAM_INPUT}>
                  {PIPELINE_STAGES.map((stage) => (
                    <option key={stage} value={stage}>
                      {labelForPipelineStage(stage)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1 text-sm text-slate-600 sm:col-span-2">
                <span>Notes</span>
                <textarea name="pipelineNotes" rows={3} placeholder="Optional" className={TEAM_INPUT} />
              </label>

              <div className="sm:col-span-2">
                <button
                  type="button"
                  className={teamButtonClass("secondary", "sm")}
                  onClick={() => setShowAddress((prev) => !prev)}
                >
                  {showAddress ? "Hide address" : "Add address (optional)"}
                </button>
              </div>

              {showAddress ? (
                <>
                  <label className="flex flex-col gap-1 text-sm text-slate-600 sm:col-span-2">
                    <span>Street address</span>
                    <input name="addressLine1" placeholder="Street address" className={TEAM_INPUT} />
                  </label>
                  <label className="flex flex-col gap-1 text-sm text-slate-600">
                    <span>City</span>
                    <input name="city" placeholder="City" className={TEAM_INPUT} />
                  </label>
                  <div className="grid grid-cols-2 gap-4">
                    <label className="flex flex-col gap-1 text-sm text-slate-600">
                      <span>State</span>
                      <input name="state" maxLength={2} placeholder="GA" className={`${TEAM_INPUT} uppercase`} />
                    </label>
                    <label className="flex flex-col gap-1 text-sm text-slate-600">
                      <span>Postal code</span>
                      <input name="postalCode" placeholder="ZIP" className={TEAM_INPUT} />
                    </label>
                  </div>
                  <div className="sm:col-span-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
                    If you add an address, include street, city, state, and postal code.
                  </div>
                </>
              ) : null}

              <div className="sm:col-span-2 flex items-center justify-end gap-2">
                <button type="button" className={teamButtonClass("secondary")} onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <button type="submit" className={teamButtonClass("primary")}>
                  Save contact
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </>
  );
}

