import type { Metadata } from "next";

export const metadata: Metadata = {
  title: {
    default: "Stonegate Partner Portal",
    template: "%s | Stonegate Partner Portal",
  },
  description:
    "Quickly request Stonegate service, reuse saved locations, choose eligible arrival windows, and keep updates, proof, and billing easy to find.",
};

export default function PartnersLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return children;
}
