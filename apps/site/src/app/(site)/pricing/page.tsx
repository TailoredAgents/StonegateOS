import { notFound } from "next/navigation";
import { Card, Section } from "@myst-os/ui";
import { MdxContent } from "@/components/MdxContent";
import { PricingDumpsterEstimator } from "@/components/PricingDumpsterEstimator";
import { getPageBySlug } from "@/lib/content";
import { createPageMetadata } from "@/lib/metadata";

export const metadata = createPageMetadata("pricing");

export default function Page() {
  const page = getPageBySlug("pricing");
  if (!page) {
    notFound();
  }

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
      </div>
    </Section>
  );
}
