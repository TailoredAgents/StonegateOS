"use client";

import { useState } from "react";
import { partnerFieldClass } from "./PartnerPortalUi";

export function PartnerLoginPasswordInput() {
  const [visible, setVisible] = useState(false);
  return (
    <div className="relative">
      <input
        id="partner-password"
        name="password"
        type={visible ? "text" : "password"}
        required
        minLength={1}
        maxLength={128}
        autoComplete="current-password"
        className={`${partnerFieldClass} pr-20`}
      />
      <button
        type="button"
        onClick={() => setVisible(!visible)}
        aria-pressed={visible}
        aria-controls="partner-password"
        className="absolute bottom-0 right-1 inline-flex min-h-11 min-w-16 items-center justify-center rounded-lg text-sm font-semibold text-primary-900 focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {visible ? "Hide" : "Show"}
        <span className="sr-only"> password</span>
      </button>
    </div>
  );
}
