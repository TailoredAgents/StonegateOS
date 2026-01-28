import { notFound } from "next/navigation";
import { Card, Section } from "@myst-os/ui";
import { MdxContent } from "@/components/MdxContent";
import { getPublicCompanyProfile } from "@/lib/company";
import { getPageBySlug } from "@/lib/content";
import { createPageMetadata } from "@/lib/metadata";

export const metadata = createPageMetadata("contact");

export default function Page() {
  const page = getPageBySlug("contact");
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
        <Card tone="outline" className="p-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">Call or text</p>
              <a className="text-sm font-semibold text-primary-800 hover:underline" href={`tel:${company.phoneE164}`}>
                {company.phoneDisplay}
              </a>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">Email</p>
              <a className="text-sm font-semibold text-primary-800 hover:underline" href={`mailto:${company.email}`}>
                {company.email}
              </a>
            </div>
            <div className="space-y-1">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">Hours</p>
              <p className="text-sm text-neutral-700">{company.hoursSummary}</p>
            </div>
          </div>
        </Card>
        <Card tone="outline">
          <MdxContent code={page.body.code} />
        </Card>
      </div>
    </Section>
  );
}

