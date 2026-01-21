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
    images: [{ url: absoluteUrl("/images/hero/home.jpg") }],
    type: "website"
  },
  twitter: {
    card: "summary_large_image",
    title: defaultTitle,
    description: defaultDescription,
    images: [absoluteUrl("/images/hero/home.jpg")]
  },
  robots: {
    index: true,
    follow: true
  },
  icons: {
    icon: "/favicon.png",
    shortcut: "/favicon.png",
    apple: "/favicon.png"
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased bg-neutral-100 text-neutral-900 font-sans">
        {children}
      </body>
    </html>
  );
}


