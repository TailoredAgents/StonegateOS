"use client";

import React, {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  POLICY_CATEGORIES,
  POLICY_CARD_DEFINITIONS,
  getPolicyCardDefinition,
  policyCardMatches,
  type PolicyCardId,
  type PolicyCategoryFilter,
} from "./policy-center-model";

type PolicyFilterContextValue = {
  category: PolicyCategoryFilter;
  query: string;
};

const PolicyFilterContext = createContext<PolicyFilterContextValue>({
  category: "all",
  query: "",
});

export function PolicyCenterWorkspace({
  canWrite,
  children,
}: {
  canWrite: boolean;
  children: ReactNode;
}): React.ReactElement {
  const [category, setCategory] = useState<PolicyCategoryFilter>("all");
  const [query, setQuery] = useState("");
  const filterValue = useMemo(() => ({ category, query }), [category, query]);
  const visibleCount = POLICY_CARD_DEFINITIONS.filter((card) =>
    policyCardMatches(card, category, query),
  ).length;

  const resetFilters = () => {
    setCategory("all");
    setQuery("");
  };

  return (
    <>
      <section
        aria-labelledby="policy-center-find-heading"
        className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur dark:border-slate-700 dark:bg-slate-900/90 dark:shadow-black/20"
      >
        <div className="flex flex-col gap-1">
          <h3
            id="policy-center-find-heading"
            className="text-base font-semibold text-slate-900 dark:text-slate-100"
          >
            Find a policy
          </h3>
          <p className="text-xs text-slate-600 dark:text-slate-300">
            Search by rule or choose a category. Filtering never discards
            unsaved input.
          </p>
        </div>

        <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="w-full lg:max-w-md">
            <label
              htmlFor="policy-center-search"
              className="text-xs font-semibold text-slate-700 dark:text-slate-200"
            >
              Search policies
            </label>
            <div className="mt-1 flex gap-2">
              <input
                id="policy-center-search"
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Try booking, SMS, pricing, or reviews"
                className="min-h-[44px] w-full rounded-2xl border border-slate-300 bg-white px-4 text-sm text-slate-800 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-primary-500 focus:ring-2 focus:ring-primary-200 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-100 dark:focus:ring-primary-800"
              />
              {query ? (
                <button
                  type="button"
                  onClick={() => setQuery("")}
                  className="min-h-[44px] shrink-0 rounded-2xl border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800"
                >
                  Clear
                </button>
              ) : null}
            </div>
          </div>

          <p
            className="text-xs font-medium text-slate-600 dark:text-slate-300"
            role="status"
            aria-live="polite"
          >
            {visibleCount} of {POLICY_CARD_DEFINITIONS.length} policies shown
          </p>
        </div>

        <div
          className="mt-4 flex gap-2 overflow-x-auto pb-1"
          aria-label="Policy categories"
          role="group"
        >
          {[
            { id: "all" as const, label: "All" },
            ...POLICY_CATEGORIES.map(({ id, label }) => ({ id, label })),
          ].map((entry) => {
            const active = category === entry.id;
            return (
              <button
                key={entry.id}
                type="button"
                aria-pressed={active}
                onClick={() => setCategory(entry.id)}
                className={`min-h-[44px] shrink-0 rounded-full border px-4 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 ${
                  active
                    ? "border-primary-600 bg-primary-600 text-white"
                    : "border-slate-300 bg-white text-slate-700 hover:border-primary-300 hover:bg-primary-50 dark:border-slate-600 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800"
                }`}
              >
                {entry.label}
              </button>
            );
          })}
        </div>

        <div className="mt-4 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-xs leading-5 text-emerald-950 dark:border-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-100">
          <p className="font-semibold">Concurrent edits are protected</p>
          <p>
            Each save includes the version loaded with that card. If another
            teammate saves first, your stale change is rejected and your input
            remains available for review instead of overwriting their work.
          </p>
        </div>

        {!canWrite ? (
          <div
            role="alert"
            className="mt-4 rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-950 dark:border-sky-800 dark:bg-sky-950/50 dark:text-sky-100"
          >
            You can review policies, but your current permissions do not allow
            policy changes. Editing and save controls are disabled.
          </div>
        ) : null}
      </section>

      <PolicyFilterContext.Provider value={filterValue}>
        <div className="space-y-4">{children}</div>
      </PolicyFilterContext.Provider>

      {visibleCount === 0 ? (
        <section className="rounded-3xl border border-dashed border-slate-300 bg-white/80 px-5 py-10 text-center dark:border-slate-700 dark:bg-slate-900/80">
          <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
            No policies match
          </h3>
          <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
            Try a broader search or show every category.
          </p>
          <button
            type="button"
            onClick={resetFilters}
            className="mt-4 min-h-[44px] rounded-full bg-slate-900 px-5 text-sm font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 dark:bg-slate-100 dark:text-slate-900"
          >
            Reset filters
          </button>
        </section>
      ) : null}
    </>
  );
}

export function PolicyCard({
  id,
  canWrite,
  updatedAtLabel,
  editorLabel,
  metadataUnavailable = false,
  revisionKey,
  children,
}: {
  id: PolicyCardId;
  canWrite: boolean;
  updatedAtLabel: string;
  editorLabel: string;
  metadataUnavailable?: boolean;
  revisionKey: string;
  children: ReactNode;
}): React.ReactElement {
  const { category, query } = useContext(PolicyFilterContext);
  const definition = getPolicyCardDefinition(id);
  const visible = policyCardMatches(definition, category, query);
  const [dirty, setDirty] = useState(false);
  const [announcement, setAnnouncement] = useState("No unsaved changes.");
  const articleRef = useRef<HTMLElement>(null);
  const previousRevision = useRef(revisionKey);

  useEffect(() => {
    if (previousRevision.current === revisionKey) {
      return;
    }
    previousRevision.current = revisionKey;
    for (const form of Array.from(
      articleRef.current?.querySelectorAll("form") ?? [],
    )) {
      form.reset();
    }
    setDirty(false);
    setAnnouncement(`${definition.title} saved.`);
  }, [definition.title, revisionKey]);

  useEffect(() => {
    if (!dirty) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty]);

  const markDirty = () => {
    if (!canWrite) return;
    setDirty(true);
    setAnnouncement(`Unsaved changes in ${definition.title}.`);
  };

  const revertChanges = () => {
    for (const form of Array.from(
      articleRef.current?.querySelectorAll("form") ?? [],
    )) {
      form.reset();
    }
    setDirty(false);
    setAnnouncement(`Unsaved changes in ${definition.title} were reverted.`);
  };

  return (
    <article
      ref={articleRef}
      hidden={!visible}
      aria-label={definition.title}
      data-policy-card={id}
      data-policy-category={definition.category}
      onInputCapture={markDirty}
      onChangeCapture={markDirty}
      onSubmitCapture={() =>
        setAnnouncement(`Saving ${definition.title}. Keep this page open.`)
      }
      onInvalidCapture={() =>
        setAnnouncement(
          `Fix the highlighted fields in ${definition.title} before saving.`,
        )
      }
      className="rounded-3xl border border-slate-200 bg-white/90 p-5 shadow-xl shadow-slate-200/50 backdrop-blur dark:border-slate-700 dark:bg-slate-900/90 dark:shadow-black/20 [&_button]:min-h-[44px] [&_input:not([type='checkbox'])]:min-h-[44px] [&_select]:min-h-[44px] [&_summary]:flex [&_summary]:min-h-[44px] [&_summary]:items-center"
    >
      <fieldset disabled={!canWrite} className="contents disabled:opacity-70">
        {children}
      </fieldset>

      <footer className="mt-5 border-t border-slate-200 pt-4 dark:border-slate-700">
        <div className="rounded-2xl bg-slate-50 px-4 py-3 dark:bg-slate-950/60">
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
            Downstream effect preview
          </p>
          <p className="mt-1 text-xs text-slate-700 dark:text-slate-200">
            A successful save can change:{" "}
            {definition.affectedSurfaces.join(" · ")}. Existing in-progress work
            should be refreshed before relying on the new rule.
          </p>
        </div>

        <dl className="mt-3 grid gap-2 text-xs text-slate-600 sm:grid-cols-2 dark:text-slate-300">
          <div>
            <dt className="font-semibold text-slate-700 dark:text-slate-200">
              Last saved
            </dt>
            <dd>
              {metadataUnavailable
                ? "Not exposed by this endpoint"
                : updatedAtLabel}
            </dd>
          </div>
          <div>
            <dt className="font-semibold text-slate-700 dark:text-slate-200">
              Editor
            </dt>
            <dd>{editorLabel}</dd>
          </div>
        </dl>

        <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <p
              className={`text-xs font-semibold ${
                dirty
                  ? "text-amber-700 dark:text-amber-300"
                  : "text-emerald-700 dark:text-emerald-300"
              }`}
            >
              {dirty ? "Unsaved changes" : "No unsaved changes"}
            </p>
            <p className="sr-only" role="status" aria-live="polite">
              {announcement}
            </p>
          </div>
          <button
            type="button"
            onClick={revertChanges}
            disabled={!canWrite || !dirty}
            className="min-h-[44px] w-full rounded-full border border-slate-300 bg-white px-4 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500 disabled:cursor-not-allowed disabled:opacity-50 sm:w-auto dark:border-slate-600 dark:bg-slate-950 dark:text-slate-200 dark:hover:bg-slate-800"
          >
            Revert unsaved changes
          </button>
        </div>
      </footer>
    </article>
  );
}
