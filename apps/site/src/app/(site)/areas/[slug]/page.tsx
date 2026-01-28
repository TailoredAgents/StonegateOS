import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, Button, Card, Section } from "@myst-os/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { MdxContent } from "@/components/MdxContent";
import { BreadcrumbStructuredData } from "@/components/StructuredData";
import { getAreaBySlug, getOrderedAreas, getOrderedServices } from "@/lib/content";
import { createAreaMetadata } from "@/lib/metadata";

interface AreaPageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return getOrderedAreas().map((area) => ({ slug: area.slug }));
}

export async function generateMetadata({ params }: AreaPageProps): Promise<Metadata> {
  const { slug } = await params;
  return createAreaMetadata(slug);
}

export default async function AreaPage({ params }: AreaPageProps) {
  const { slug } = await params;
  const area = getAreaBySlug(slug);

  if (!area) {
    notFound();
  }

  const locationPieces = [area.city, area.county ? `${area.county} County` : undefined].filter(
    Boolean
  ) as string[];
  const locationLabel = locationPieces.length ? locationPieces.join(" - ") : "Georgia";
  const services = getOrderedServices();
  const breadcrumbItems = [
    { label: "Home", href: "/" },
    { label: "Service areas", href: "/areas" },
    { label: area.title, href: `/areas/${area.slug}` }
  ];

  return (
    <Section>
      <div className="mx-auto max-w-4xl space-y-6">
        <BreadcrumbStructuredData
          items={[
            { name: "Home", path: "/" },
            { name: "Service areas", path: "/areas" },
            { name: area.title, path: `/areas/${area.slug}` }
          ]}
        />
        <Breadcrumbs items={breadcrumbItems} />
        <header className="space-y-3">
          <Badge tone="default">Stonegate Service Area</Badge>
          <h1 className="font-display text-display text-primary-800">{area.title}</h1>
          <p className="text-body text-neutral-600">{locationLabel}</p>
        </header>
        <Card tone="outline" className="space-y-4">
          <MdxContent code={area.body.code} />
        </Card>
        {services.length ? (
          <div className="space-y-3">
            <h2 className="font-display text-headline text-primary-800">
              Popular services in {area.city || "Georgia"}
            </h2>
            <div className="grid gap-4 md:grid-cols-2">
              {services.map((service) => (
                <Card key={service.slug} tone="subtle" className="space-y-2 p-4">
                  <p className="text-sm font-semibold text-primary-900">{service.title}</p>
                  {service.short ? <p className="text-sm text-neutral-600">{service.short}</p> : null}
                  <Button size="sm" variant="secondary" asChild className="w-fit">
                    <Link href={`/services/${service.slug}`}>View service details</Link>
                  </Button>
                </Card>
              ))}
            </div>
          </div>
        ) : null}
        <Button asChild>
          <Link href="/estimate">Request an on-site estimate in this area</Link>
        </Button>
      </div>
    </Section>
  );
}
