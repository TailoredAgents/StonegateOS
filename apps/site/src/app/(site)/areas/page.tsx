import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Button, Card, Section } from "@myst-os/ui";
import { MdxContent } from "@/components/MdxContent";
import { ServiceAreaMapNoSSR } from "@/components/ServiceAreaMapNoSSR";
import { getAreaIntro, getOrderedAreas } from "@/lib/content";
import { createAreaMetadata } from "@/lib/metadata";

export const metadata = createAreaMetadata("index");

export default function AreasIndex() {
  const intro = getAreaIntro();
  const areas = getOrderedAreas();

  if (!areas.length) {
    notFound();
  }

  return (
    <Section>
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-3">
          <Badge tone="highlight">Core Coverage</Badge>
          <h1 className="font-display text-display text-primary-800">North Metro Atlanta service areas</h1>
          {intro?.description ? (
            <p className="text-body text-neutral-600">{intro.description}</p>
          ) : null}
        </header>
        {intro ? (
          <Card tone="outline" className="space-y-4">
            <MdxContent code={intro.body.code} />
          </Card>
        ) : null}
        <div className="space-y-4">
          <ServiceAreaMapNoSSR />
          <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-600">
            <span className="font-medium text-neutral-700">Explore area details:</span>
            {areas.map((area) => (
              <Button key={area.slug} size="sm" variant="secondary" asChild>
                <Link href={`/areas/${area.slug}`}>{area.title}</Link>
              </Button>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}
