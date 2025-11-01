import "@/lib/react-internals-polyfill";
import type { Metadata } from "next";
import { Inter, Playfair_Display } from "next/font/google";
import { absoluteUrl, siteUrl } from "@/lib/metadata";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-sans",
  weight: ["400", "500", "600"]
});

const playfair = Playfair_Display({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
  weight: ["700"]
});

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
    <html lang="en" className={`${inter.variable} ${playfair.variable}`}>
      <body className="antialiased bg-neutral-100 text-neutral-900 font-sans">
        {children}
      </body>
    </html>
  );
}


