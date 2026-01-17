"use client";

import { useEffect, useMemo, useState } from "react";

function getCheckboxes(formId: string): HTMLInputElement[] {
  if (typeof document === "undefined") return [];
  return Array.from(
    document.querySelectorAll<HTMLInputElement>(`input[form="${formId}"][name="taskIds"][type="checkbox"]`)
  );
}

export function OutboundBulkSelectionControls({ formId }: { formId: string }) {
  const [selectedCount, setSelectedCount] = useState(0);
  const [totalCount, setTotalCount] = useState(0);

  const recompute = useMemo(() => {
    return () => {
      const boxes = getCheckboxes(formId);
      setTotalCount(boxes.length);
      setSelectedCount(boxes.filter((b) => b.checked).length);
    };
  }, [formId]);

  useEffect(() => {
    const boxes = getCheckboxes(formId);
    setTotalCount(boxes.length);
    setSelectedCount(boxes.filter((b) => b.checked).length);

    const handler = () => recompute();
    for (const box of boxes) box.addEventListener("change", handler);
    return () => {
      for (const box of boxes) box.removeEventListener("change", handler);
    };
  }, [formId, recompute]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-600 sm:justify-end">
      <div className="text-[11px] text-slate-500">
        Selected {selectedCount}/{totalCount}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="rounded-full border border-slate-200 bg-slate-50 px-3 py-2 font-semibold text-slate-700 hover:bg-slate-100"
          onClick={() => {
            const boxes = getCheckboxes(formId);
            for (const box of boxes) box.checked = true;
            recompute();
          }}
        >
          Select page
        </button>
        <button
          type="button"
          className="rounded-full border border-slate-200 bg-white px-3 py-2 font-semibold text-slate-700 hover:bg-slate-50"
          onClick={() => {
            const boxes = getCheckboxes(formId);
            for (const box of boxes) box.checked = false;
            recompute();
          }}
        >
          Clear
        </button>
      </div>
    </div>
  );
}

