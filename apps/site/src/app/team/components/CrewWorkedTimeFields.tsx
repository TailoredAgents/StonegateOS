"use client";

import * as React from "react";
import {
  decimalHoursToTimeParts,
  timePartsToDecimalHours,
} from "../lib/crew-worked-time";

export function CrewWorkedTimeFields({
  memberId,
  memberName,
  value,
  onChange,
  inputClass,
}: {
  memberId: string;
  memberName: string;
  value: string;
  onChange: (value: string) => void;
  inputClass: string;
}) {
  const [parts, setParts] = React.useState(() =>
    decimalHoursToTimeParts(value),
  );
  const lastValue = React.useRef(value);
  React.useEffect(() => {
    if (value === lastValue.current) return;
    lastValue.current = value;
    setParts(decimalHoursToTimeParts(value));
  }, [value]);
  const update = (key: "hours" | "minutes", nextValue: string) => {
    const nextParts = { ...parts, [key]: nextValue };
    setParts(nextParts);
    lastValue.current = timePartsToDecimalHours(
      nextParts.hours,
      nextParts.minutes,
    );
    onChange(lastValue.current);
  };
  return (
    <div className="grid grid-cols-2 gap-2">
      <input type="hidden" name={`crewHours:${memberId}`} value={value} />
      <label className="min-w-0 space-y-1 text-xs font-medium">
        <span className="block">Hours</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={8760}
          step={1}
          value={parts.hours}
          aria-label={`${memberName} hours worked`}
          onChange={(event) => update("hours", event.target.value)}
          className={inputClass}
          placeholder="0"
        />
      </label>
      <label className="min-w-0 space-y-1 text-xs font-medium">
        <span className="block">Minutes</span>
        <input
          type="number"
          inputMode="numeric"
          min={0}
          max={59}
          step={1}
          value={parts.minutes}
          aria-label={`${memberName} minutes worked`}
          onChange={(event) => update("minutes", event.target.value)}
          className={inputClass}
          placeholder="0"
        />
      </label>
    </div>
  );
}
