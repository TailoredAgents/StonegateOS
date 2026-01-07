'use client';

import dynamic from "next/dynamic";

const ServiceAreaMap = dynamic(() => import("./ServiceAreaMap").then((mod) => mod.ServiceAreaMap), {
  ssr: false,
  loading: () => (
    <div className="h-[420px] w-full animate-pulse rounded-3xl border border-neutral-200 bg-white" />
  )
});

export function ServiceAreaMapNoSSR({ className }: { className?: string }) {
  return <ServiceAreaMap className={className} />;
}

