import React from "react";
import { TEAM_CARD_PADDED } from "./team-ui";

function SkeletonLine({ className }: { className: string }) {
  return <div className={`rounded-full bg-slate-200/70 ${className}`} />;
}

export function TeamSkeletonCard({ title }: { title: string }) {
  return (
    <div className={`${TEAM_CARD_PADDED} animate-pulse`}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-sm font-semibold text-slate-800">{title}</div>
        <SkeletonLine className="h-6 w-20" />
      </div>
      <div className="mt-4 space-y-3">
        <SkeletonLine className="h-4 w-3/4" />
        <SkeletonLine className="h-4 w-2/3" />
        <SkeletonLine className="h-4 w-5/6" />
        <div className="pt-2">
          <SkeletonLine className="h-10 w-44" />
        </div>
      </div>
    </div>
  );
}

