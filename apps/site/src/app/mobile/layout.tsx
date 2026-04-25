import type { Metadata, Viewport } from "next";

export const metadata: Metadata = {
  title: "StonegateOS Mobile",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "StonegateOS",
    statusBarStyle: "black-translucent"
  },
  robots: {
    index: false,
    follow: false
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#020617"
};

export default function MobileLayout({ children }: { children: React.ReactNode }) {
  return children;
}
