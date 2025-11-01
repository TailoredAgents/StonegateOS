import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, Button, Card, Section } from "@myst-os/ui";
import { MdxContent } from "@/components/MdxContent";
import { getAreaBySlug, getOrderedAreas } from "@/lib/content";
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

  return (
    <Section>
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-3">
          <Badge tone="default">Stonegate Service Area</Badge>
          <h1 className="font-display text-display text-primary-800">{area.title}</h1>
          <p className="text-body text-neutral-600">{locationLabel}</p>
        </header>
        <Card tone="outline" className="space-y-4">
          <MdxContent code={area.body.code} />
        </Card>
        <Button asChild>
          <a href="#schedule-estimate">Request an on-site estimate in this area</a>
        </Button>
      </div>
    </Section>
  );
}
