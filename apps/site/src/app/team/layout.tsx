import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  // Native same-origin mutation forms need a non-opaque Origin so the Site can
  // enforce its CSRF boundary. `same-origin` preserves that proof while still
  // withholding CRM paths from every cross-origin destination.
  referrer: "same-origin",
  robots: {
    index: false,
    follow: false,
    nocache: true,
    googleBot: { index: false, follow: false, noimageindex: true },
  },
};

export default function TeamLayout({ children }: { children: ReactNode }) {
  return children;
}
