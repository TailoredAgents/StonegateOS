"use client";

import * as React from "react";
import type { PartnerProofMedia } from "../lib/portal-v2";

function previewUrl(media: PartnerProofMedia): string | null {
  return (
    media.downloadIntent?.displayUrl ??
    media.downloadIntent?.thumbnailUrl ??
    null
  );
}

export function PartnerBeforeAfterCompare({
  before,
  after,
}: {
  before: PartnerProofMedia;
  after: PartnerProofMedia;
}) {
  const [position, setPosition] = React.useState(50);
  const beforeUrl = previewUrl(before);
  const afterUrl = previewUrl(after);
  if (!beforeUrl || !afterUrl) return null;

  return (
    <section
      aria-labelledby={`before-after-${before.id}-${after.id}`}
      className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"
    >
      <div>
        <h3
          id={`before-after-${before.id}-${after.id}`}
          className="text-lg font-semibold text-slate-950"
        >
          Before &amp; after comparison
        </h3>
        <p className="mt-1 text-sm leading-6 text-slate-600">
          Move the control to reveal more of either image. Both originals remain
          available in the photo gallery.
        </p>
      </div>

      <div className="relative mt-4 aspect-[4/3] max-h-[38rem] overflow-hidden rounded-xl bg-slate-100">
        {/* Signed account media intentionally bypasses image optimization. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={beforeUrl}
          alt={before.caption?.trim() || "Condition before service"}
          className="absolute inset-0 h-full w-full object-cover"
        />
        <div
          className="absolute inset-0 overflow-hidden motion-reduce:transition-none"
          style={{ clipPath: `inset(0 ${100 - position}% 0 0)` }}
          aria-hidden="true"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={afterUrl} alt="" className="h-full w-full object-cover" />
        </div>
        <div
          className="pointer-events-none absolute inset-y-0 w-0.5 -translate-x-1/2 bg-white shadow-[0_0_0_1px_rgba(15,23,42,0.35)]"
          style={{ left: `${position}%` }}
          aria-hidden="true"
        />
        <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-slate-950/85 px-3 py-1 text-xs font-semibold text-white">
          After
        </span>
        <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-slate-950/85 px-3 py-1 text-xs font-semibold text-white">
          Before
        </span>
      </div>

      <label
        htmlFor={`before-after-control-${before.id}-${after.id}`}
        className="mt-4 block text-sm font-semibold text-slate-800"
      >
        Reveal after photo
      </label>
      <input
        id={`before-after-control-${before.id}-${after.id}`}
        type="range"
        min={0}
        max={100}
        step={1}
        value={position}
        onChange={(event) => setPosition(Number(event.currentTarget.value))}
        aria-valuetext={`${position}% after photo visible`}
        className="mt-2 min-h-11 w-full cursor-ew-resize accent-primary-700 touch-pan-y focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2"
      />
      <div
        className="flex justify-between text-xs font-medium text-slate-600"
        aria-hidden="true"
      >
        <span>Before</span>
        <span>After</span>
      </div>
      <p className="sr-only">
        Before image: {before.caption?.trim() || "Condition before service"}.
        After image: {after.caption?.trim() || "Condition after service"}.
      </p>
    </section>
  );
}
