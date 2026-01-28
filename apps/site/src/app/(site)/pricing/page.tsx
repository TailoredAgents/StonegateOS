import { notFound } from "next/navigation";
import { Card, Section } from "@myst-os/ui";
import { MdxContent } from "@/components/MdxContent";
import { PricingDumpsterEstimator } from "@/components/PricingDumpsterEstimator";
import { getPublicCompanyProfile } from "@/lib/company";
import { getPageBySlug } from "@/lib/content";
import { createPageMetadata } from "@/lib/metadata";

export const metadata = createPageMetadata("pricing");

export default function Page() {
  const page = getPageBySlug("pricing");
  if (!page) {
    notFound();
  }

  const company = getPublicCompanyProfile();

  return (
    <Section>
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-3">
          <p className="text-label uppercase tracking-[0.28em] text-neutral-500">Stonegate Junk Removal</p>
          <h1 className="font-display text-display text-primary-800">{page.title}</h1>
          {page.description ? (
            <p className="text-body text-neutral-600">{page.description}</p>
          ) : null}
        </header>
        <Card tone="outline">
          <PricingDumpsterEstimator />
        </Card>
        <Card tone="outline">
          <MdxContent code={page.body.code} />
        </Card>
        <Card tone="outline" className="p-6">
          <p className="text-sm text-neutral-700">
            Questions about a pickup or a special item? Call or text{" "}
            <a className="font-semibold text-primary-800 hover:underline" href={`tel:${company.phoneE164}`}>
              {company.phoneDisplay}
            </a>{" "}
            or email{" "}
            <a className="font-semibold text-primary-800 hover:underline" href={`mailto:${company.email}`}>
              {company.email}
            </a>
            .
          </p>
        </Card>
      </div>
    </Section>
  );
}
