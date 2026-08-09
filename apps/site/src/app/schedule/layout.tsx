import type { ReactNode } from "react";
import { PublicMarketingTags } from "@/components/PublicMarketingTags";

export default function ScheduleLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PublicMarketingTags />
      {children}
    </>
  );
}
