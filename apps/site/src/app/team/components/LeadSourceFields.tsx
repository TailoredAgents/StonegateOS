"use client";

import React from "react";
import {
  LEAD_SOURCE_OPTIONS,
  type LeadSourceType,
} from "../lib/booking-details";

type TeamMember = {
  id: string;
  name: string;
};

type Props = {
  teamMembers: TeamMember[];
  selectName?: string;
  teamMemberName?: string;
  referralName?: string;
  defaultType?: LeadSourceType | "";
  defaultTeamMemberId?: string | null;
  defaultReferralName?: string | null;
  required?: boolean;
  label: string;
  labelClassName: string;
  fieldClassName: string;
};

export function LeadSourceFields({
  teamMembers,
  selectName = "sourceType",
  teamMemberName = "sourceTeamMemberId",
  referralName = "sourceReferralName",
  defaultType = "",
  defaultTeamMemberId = null,
  defaultReferralName = null,
  required = false,
  label,
  labelClassName,
  fieldClassName,
}: Props): React.ReactElement {
  const [sourceType, setSourceType] = React.useState<LeadSourceType | "">(
    defaultType,
  );

  React.useEffect(() => {
    setSourceType(defaultType);
  }, [defaultType]);

  return (
    <>
      <label className={labelClassName}>
        <span>{label}</span>
        <select
          name={selectName}
          required={required}
          value={sourceType}
          onChange={(event) =>
            setSourceType(event.target.value as LeadSourceType | "")
          }
          className={fieldClassName}
        >
          <option value="">{required ? "(Select)" : "(Optional)"}</option>
          {LEAD_SOURCE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      {sourceType === "team_member" ? (
        <label className={labelClassName}>
          <span>Which team member?</span>
          <select
            name={teamMemberName}
            required
            defaultValue={defaultTeamMemberId ?? ""}
            className={fieldClassName}
          >
            <option value="">(Select)</option>
            {teamMembers.map((member) => (
              <option key={member.id} value={member.id}>
                {member.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {sourceType === "referral" ? (
        <label className={labelClassName}>
          <span>Who referred them?</span>
          <input
            name={referralName}
            required
            defaultValue={defaultReferralName ?? ""}
            placeholder="Name"
            className={fieldClassName}
          />
        </label>
      ) : null}
    </>
  );
}
