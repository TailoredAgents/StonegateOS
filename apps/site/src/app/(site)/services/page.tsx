import type { Metadata } from "next";
import { Section } from "@myst-os/ui";
import { absoluteUrl } from "@/lib/metadata";
import {
  PublicPageIntro,
  PublicServiceGrid,
  PublicTrustStrip,
} from "@/components/public-site/PublicPageIntro";

const description =
  "Explore our most-requested junk removal services. Every visit includes careful handling, responsible disposal, and a make-it-right guarantee.";

export const metadata: Metadata = {
  title: "Junk removal services built for Georgia homes",
  description,
  openGraph: {
    title: "Junk removal services built for Georgia homes",
    description,
    url: absoluteUrl("/services"),
    type: "website",
  },
  alternates: {
    canonical: absoluteUrl("/services"),
  },
};

export default function ServicesIndex() {
  return (
    <Section className="public-page">
      <div className="public-page-stack space-y-8">
        <PublicPageIntro
          eyebrow="We do the heavy lifting"
          title="A fresh start for every space."
          description="From a single bulky item to a full cleanout, find the right pickup for your home. Careful handling and responsible disposal come with every visit."
        />
        <PublicServiceGrid />
        <PublicTrustStrip />
      </div>
    </Section>
  );
}
