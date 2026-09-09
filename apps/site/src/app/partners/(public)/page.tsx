import type { Metadata } from "next";
import { PartnerLandingContent } from "@/app/partners/components/PartnerLandingContent";
import { getPublicCompanyProfile } from "@/lib/company";
import { absoluteUrl } from "@/lib/metadata";

const title = "For Partners";
const socialTitle = "Stonegate Partner Portal";
const description =
  "Sign in to request Stonegate service and check your jobs. Existing partners can contact Stonegate Sales for access or help.";
const socialImage = absoluteUrl("/partners/social-image");

export const dynamic = "force-static";
export const revalidate = 3600;

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: absoluteUrl("/partners") },
  robots: { index: false, follow: false },
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
