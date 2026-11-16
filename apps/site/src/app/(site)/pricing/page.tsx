import { notFound } from "next/navigation";
import { Card, Section } from "@myst-os/ui";
import { MdxContent } from "@/components/MdxContent";
import { PricingDumpsterEstimator } from "@/components/PricingDumpsterEstimator";
import { getPublicCompanyProfile } from "@/lib/company";
import { getPageBySlug } from "@/lib/content";
import { createPageMetadata } from "@/lib/metadata";
import { PublicPageIntro } from "@/components/public-site/PublicPageIntro";

export const metadata = createPageMetadata("pricing");

export default function Page() {
  const page = getPageBySlug("pricing");
  if (!page) {
    notFound();
  }

  const company = getPublicCompanyProfile();

  return (
    <Section className="public-page">
      <div className="public-page-stack space-y-8">
        <PublicPageIntro
          eyebrow="Know what to expect"
          title="Less guesswork. Clearer pricing."
          description="See how much space your items might take, explore an estimate range, and choose your next step. We confirm the final price before work begins."
        />
        <Card tone="outline" className="public-pricing-panel">
          <PricingDumpsterEstimator />
        </Card>
        <Card tone="outline" className="public-prose public-panel">
          <MdxContent code={page.body.code} />
        </Card>
        <Card tone="outline" className="p-6">
          <p className="text-sm text-neutral-700">
            Questions about a pickup or a special item? Call or text{" "}
            <a
              className="font-semibold text-primary-800 hover:underline"
              href={`tel:${company.phoneE164}`}
            >
              {company.phoneDisplay}
            </a>{" "}
            or email{" "}
            <a
              className="font-semibold text-primary-800 hover:underline"
              href={`mailto:${company.email}`}
            >
              {company.email}
            </a>
            .
          </p>
        </Card>
      </div>
    </Section>
  );
}
