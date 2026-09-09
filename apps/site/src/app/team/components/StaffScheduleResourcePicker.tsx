"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import {
  loadStaffAppointmentResources,
  type StaffResourceOptions,
} from "../actions/scheduling-resources";

export function StaffScheduleResourcePicker({
  appointmentId,
  disabled = false,
}: {
  appointmentId: string;
  disabled?: boolean;
}) {
  const [data, setData] = useState<StaffResourceOptions | null>(null);
  const [error, setError] = useState("");
  const [manual, setManual] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    let current = true;
    setData(null);
    setError("");
    setManual(false);
    setSelected([]);
    void loadStaffAppointmentResources(appointmentId).then((result) => {
      if (!current) return;
      if (!result.ok) setError(result.message);
      else {
        setData(result.data);
        setSelected(
          result.data.selectedResourceIds.filter((id) =>
            result.data.resources.some((resource) => resource.id === id),
          ),
        );
      }
    });
    return () => {
      current = false;
    };
  }, [appointmentId, generation]);
  if (data && !data.applicable) return null;
  return (
    <fieldset
      disabled={disabled}
      className="min-w-0 space-y-2 rounded-xl border border-slate-200 bg-slate-50 p-3"
    >
      <legend className="px-1 text-sm font-semibold">
        Crew, truck & equipment
      </legend>
      {error ? (
        <p role="status" className="text-sm text-rose-800">
          {error}
        </p>
      ) : !data ? (
        <p role="status" className="text-sm">
          Loading current resource configuration…
        </p>
      ) : (
        <>
          {data.warning ? (
            <p role="status" className="text-sm text-amber-900">
              {data.warning}{" "}
              <Link
                href="/team/partners/scheduling"
                className="inline-flex min-h-11 items-center font-semibold underline"
              >
                Scheduling configuration
              </Link>
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-700">
                Required:{" "}
                {data.requirements
                  .map(
                    (requirement) =>
                      `${requirement.quantity} ${requirement.kind}${requirement.requiredSkillKeys.length ? ` (${requirement.requiredSkillKeys.join(", ")})` : ""}`,
                  )
                  .join("; ")}
                . Availability and daily crew limits are checked again when
                saved.
              </p>
              <label className="flex min-h-11 items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={manual}
                  onChange={(event) => setManual(event.target.checked)}
                  className="h-5 w-5"
                />
                Choose specific resources
              </label>
              {!manual ? (
                <p className="text-sm text-slate-600">
                  Automatically assign resources that meet these requirements.
                  No reservation is made until the schedule is saved.
                </p>
              ) : (
                <div className="grid gap-1 sm:grid-cols-2">
                  {data.resources.map((resource) => (
                    <label
                      key={resource.id}
                      className="flex min-h-11 items-center gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        name="selectedResourceIds"
                        value={resource.id}
                        checked={selected.includes(resource.id)}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, resource.id]
                              : current.filter((id) => id !== resource.id),
                          )
                        }
                        className="h-5 w-5"
                      />
                      <span>
                        {resource.label}{" "}
                        <span className="text-slate-600">
                          · {resource.kind}
                          {resource.skillKeys.length
                            ? ` · ${resource.skillKeys.join(", ")}`
                            : ""}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              {manual ? (
                <input
                  type="hidden"
                  name="resourceSelectionMode"
                  value="manual"
                />
              ) : null}
            </>
          )}
        </>
      )}
      <button
        type="button"
        className="inline-flex min-h-11 items-center font-semibold underline"
        onClick={() => setGeneration((value) => value + 1)}
      >
        Refresh resource options
      </button>
    </fieldset>
  );
}
