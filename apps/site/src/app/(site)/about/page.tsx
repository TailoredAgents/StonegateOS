import { notFound } from "next/navigation";
import { Card, Section } from "@myst-os/ui";
import { MdxContent } from "@/components/MdxContent";
import { getPageBySlug } from "@/lib/content";
import { createPageMetadata } from "@/lib/metadata";
import Image from "next/image";
import {
  PublicPageIntro,
  PublicTrustStrip,
} from "@/components/public-site/PublicPageIntro";

export const metadata = createPageMetadata("about");

export default function Page() {
  const page = getPageBySlug("about");
  if (!page) {
    notFound();
  }

  return (
    <Section className="public-page">
      <div className="public-page-stack space-y-8">
        <PublicPageIntro
          eyebrow="Your local crew"
          title="Good neighbors. Careful work."
          description={page.description}
        />
        <div className="public-split">
          <Card tone="outline" className="public-prose public-panel">
            <MdxContent code={page.body.code} />
          </Card>
          <div className="public-photo" style={{ minHeight: 440 }}>
            <Image
              src="/images/gallery/trailer_16x9.jpg"
              alt="Stonegate’s trailer, ready to serve Woodstock and nearby communities"
              fill
              sizes="(min-width: 768px) 480px, 100vw"
              className="object-cover"
            />
            <div className="public-photo-caption">
              <strong>From Woodstock, with care.</strong>
              <p>Local hauling for the places you call home.</p>
            </div>
          </div>
        </div>
        <PublicTrustStrip />
      </div>
    </Section>
  );
}
