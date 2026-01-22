import "@/lib/react-internals-polyfill";
import type { Metadata } from "next";
import { absoluteUrl, siteUrl } from "@/lib/metadata";
import "./globals.css";

const defaultTitle = "Stonegate Junk Removal";
const defaultDescription =
  "Fast, reliable junk removal and hauling across North Metro Atlanta. Schedule an on-site estimate and get clutter cleared responsibly with licensed, insured crews.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: defaultTitle,
    template: "%s | Stonegate Junk Removal"
  },
  description: defaultDescription,
  openGraph: {
    title: defaultTitle,
    description: defaultDescription,
    url: siteUrl,
    siteName: defaultTitle,
    images: [{ url: absoluteUrl("/opengraph-image") }],
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: defaultTitle,
    description: defaultDescription,
    images: [absoluteUrl("/twitter-image")]
  },
  robots: {
    index: true,
    follow: true
  },
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon.png", sizes: "256x256", type: "image/png" }
    ],
    shortcut: "/favicon-32.png",
    apple: [{ url: "/apple-touch-icon.png", sizes: "180x180", type: "image/png" }]
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="dns-prefetch" href="https://connect.facebook.net" />
        <link rel="preconnect" href="https://connect.facebook.net" />
        <link rel="dns-prefetch" href="https://www.facebook.com" />
        <link rel="preconnect" href="https://www.facebook.com" />
        <link rel="dns-prefetch" href="https://mpc-prod-27-s6uit34pua-uk.a.run.app" />
        <link rel="preconnect" href="https://mpc-prod-27-s6uit34pua-uk.a.run.app" />
      </head>
      <body className="antialiased bg-neutral-100 text-neutral-900 font-sans">
        {children}
      </body>
    </html>
  );
}


