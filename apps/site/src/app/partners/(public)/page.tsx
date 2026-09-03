import type { Metadata } from "next";
import { PartnerLandingContent } from "@/app/partners/components/PartnerLandingContent";
import { getPublicCompanyProfile } from "@/lib/company";
import { absoluteUrl } from "@/lib/metadata";

const title = "For Partners";
const socialTitle =
  "Stonegate Partner Portal — Schedule. Coordinate. Document.";
const description =
  "Request Stonegate junk removal, manage locations, share photos, follow completion proof, and keep billing organized in one secure partner workspace.";
const socialImage = absoluteUrl("/partners/social-image");

export const dynamic = "force-static";
export const revalidate = 3600;

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: absoluteUrl("/partners") },
  robots: { index: true, follow: true },
  openGraph: {
    title: socialTitle,
    description,
    type: "website",
    url: absoluteUrl("/partners"),
    siteName: "Stonegate Junk Removal",
    images: [
      {
        url: socialImage,
        width: 1200,
        height: 630,
        alt: socialTitle,
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: socialTitle,
    description,
    images: [socialImage],
  },
};

export default function PartnerLandingPage() {
  return <PartnerLandingContent company={getPublicCompanyProfile()} />;
}
