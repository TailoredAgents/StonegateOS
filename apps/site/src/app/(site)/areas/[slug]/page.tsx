import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button, Card, Section } from "@myst-os/ui";
import {
  PublicPageIntro,
  PublicServiceGrid,
} from "@/components/public-site/PublicPageIntro";
import { PublicPickupCard } from "@/components/public-site/PublicPickupCard";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { MdxContent } from "@/components/MdxContent";
import { BreadcrumbStructuredData } from "@/components/StructuredData";
import {
  getAreaBySlug,
  getOrderedAreas,
  getOrderedServices,
} from "@/lib/content";
import { createAreaMetadata } from "@/lib/metadata";

interface AreaPageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return getOrderedAreas().map((area) => ({ slug: area.slug }));
}

export async function generateMetadata({
  params,
}: AreaPageProps): Promise<Metadata> {
  const { slug } = await params;
  return createAreaMetadata(slug);
}

export default async function AreaPage({ params }: AreaPageProps) {
  const { slug } = await params;
  const area = getAreaBySlug(slug);

  if (!area) {
    notFound();
  }

  const locationPieces = [
    area.city,
    area.county ? `${area.county} County` : undefined,
  ].filter(Boolean) as string[];
  const locationLabel = locationPieces.length
    ? locationPieces.join(" - ")
    : "Georgia";
  const services = getOrderedServices();
  const breadcrumbItems = [
    { label: "Home", href: "/" },
    { label: "Service areas", href: "/areas" },
    { label: area.title, href: `/areas/${area.slug}` },
  ];

  return (
    <Section className="public-page">
      <div className="public-page-stack space-y-8">
        <BreadcrumbStructuredData
          items={[
            { name: "Home", path: "/" },
            { name: "Service areas", path: "/areas" },
            { name: area.title, path: `/areas/${area.slug}` },
          ]}
        />
        <Breadcrumbs items={breadcrumbItems} />
        <PublicPageIntro
          eyebrow={locationLabel}
          title={area.title}
          description="A little less clutter. A little more room for what matters. Local pickup with clear pricing and careful handling."
        />
        <div className="public-split">
          <Card tone="outline" className="public-prose public-panel space-y-4">
            <MdxContent code={area.body.code} />
          </Card>
          <PublicPickupCard local />
        </div>
        {services.length ? (
          <div className="space-y-3">
            <h2 className="font-display text-headline text-primary-800">
              Popular services in {area.city || "Georgia"}
            </h2>
            <PublicServiceGrid commercial={false} />
          </div>
        ) : null}
        <Button asChild>
          <Link href="/estimate">Request an on-site estimate in this area</Link>
        </Button>
      </div>
    </Section>
  );
}
