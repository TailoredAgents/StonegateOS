import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Stonegate Partner Portal",
    template: "%s | Stonegate Partner Portal",
  },
  description:
    "Schedule service, manage locations, and keep track of Stonegate jobs in one place.",
};

export default function PartnersLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
