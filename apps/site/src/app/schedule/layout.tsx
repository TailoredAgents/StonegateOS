import type { ReactNode } from "react";
import "@/components/public-site/public-site.css";

export default function ScheduleLayout({ children }: { children: ReactNode }) {
  // Scheduling handoffs can contain private request identifiers in the URL.
  return <div className="public-site public-scheduling">{children}</div>;
}
