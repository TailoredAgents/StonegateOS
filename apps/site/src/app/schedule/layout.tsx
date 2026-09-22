import type { ReactNode } from "react";

export default function ScheduleLayout({ children }: { children: ReactNode }) {
  // Scheduling handoffs can contain private request identifiers in the URL.
  return children;
}
