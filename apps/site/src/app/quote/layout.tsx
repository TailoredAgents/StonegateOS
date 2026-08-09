import type { ReactNode } from "react";
import type { Metadata } from "next";

export const metadata: Metadata = {
  referrer: "no-referrer",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
};

export default function QuoteLayout({ children }: { children: ReactNode }) {
  // Quote URLs contain bearer capabilities. Loading marketing tags here would
  // disclose the token through the browser's page URL/referrer to analytics
  // providers. Customer quote handoffs therefore remain telemetry-free.
  return children;
}
