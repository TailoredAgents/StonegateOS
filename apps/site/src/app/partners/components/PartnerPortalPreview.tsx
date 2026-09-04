import { PartnerStatusBadge } from "./PartnerStatusBadge";

export function PartnerPortalPreview() {
  return (
    <figure className="relative overflow-hidden rounded-3xl bg-primary-900 p-3 shadow-float sm:p-5">
      <div
        className="absolute -right-20 -top-20 h-56 w-56 rounded-full bg-accent-500/30 blur-3xl"
        aria-hidden="true"
      />
      <div className="relative overflow-hidden rounded-2xl border border-white/20 bg-slate-50 shadow-soft">
        <header className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white px-4 py-3 sm:px-5">
          <div>
            <p className="text-sm font-semibold text-slate-950">
              Example workspace
            </p>
          </div>
          <PartnerStatusBadge status="completed" />
        </header>

        <div className="space-y-3 p-3 sm:p-5">
          <section
            aria-labelledby="preview-job-title"
            className="rounded-xl border border-slate-200 bg-white p-4"
          >
            <p className="text-xs font-semibold uppercase tracking-widest text-primary-900">
              Property cleanout
            </p>
            <h2
              id="preview-job-title"
              className="mt-1 text-lg font-semibold text-slate-950"
            >
              Sample property
            </h2>
            <p className="mt-2 text-sm text-slate-600">
              Tuesday, 10:00 AM–12:00 PM arrival window
            </p>
          </section>

          <section
            aria-labelledby="preview-proof-title"
            className="overflow-hidden rounded-xl border border-slate-200 bg-white"
          >
            {/* This 720 px WebP is stripped of metadata and sized for this bounded preview. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/images/partners-proof-preview-720.webp"
              alt="Before and after view of a completed garage cleanout"
              width="720"
              height="405"
              loading="eager"
              fetchPriority="high"
              decoding="async"
              className="aspect-video h-auto w-full object-cover"
            />
            <div className="grid gap-3 p-4 text-sm sm:grid-cols-2">
              <div>
                <h2
                  id="preview-proof-title"
                  className="font-semibold text-slate-950"
                >
                  Proof complete
                </h2>
                <p className="mt-1 text-slate-600">Completion report ready</p>
              </div>
              <div className="border-t border-slate-200 pt-3 sm:border-l sm:border-t-0 sm:pl-4 sm:pt-0">
                <p className="font-semibold text-slate-950">Latest update</p>
                <p className="mt-1 text-slate-600">
                  Service finished and proof added
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>
      <figcaption className="relative mt-3 text-center text-xs text-slate-200">
        Example only. No live account data.
      </figcaption>
    </figure>
  );
}
