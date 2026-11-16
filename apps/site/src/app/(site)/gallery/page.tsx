import Image from "next/image";
import { BeforeAfterSlider, Section } from "@myst-os/ui";
import { PublicPageIntro } from "@/components/public-site/PublicPageIntro";
import { transformationShowcases } from "@/components/public-site/content";
import { createPageMetadata } from "@/lib/metadata";
export const metadata = createPageMetadata("gallery");
export default function GalleryPage() {
  return (
    <Section className="public-page">
      <div className="public-page-stack space-y-10">
        <PublicPageIntro
          eyebrow="Our work, in plain sight"
          title="From full of clutter to full of possibility."
          description="A closer look at recent residential cleanouts. Move each slider to compare the space before and after our visit."
        />
        <div className="public-work-grid">
          {transformationShowcases.map((work) => (
            <article key={work.title}>
              <BeforeAfterSlider
                beforeImage={work.beforeImage}
                afterImage={work.afterImage}
                alt={work.alt}
                aspectRatio="4/3"
                imageSizes="(min-width: 768px) 360px, 100vw"
              />
              <h3>{work.title}</h3>
              <p>{work.description}</p>
            </article>
          ))}
        </div>
        <div className="public-split public-panel">
          <div className="public-section-heading">
            <p className="public-eyebrow">Ready for your pickup</p>
            <h2>The trailer behind the transformation.</h2>
            <p>
              Our 7×16 dumpster trailer helps us handle bulky items and larger
              cleanouts. We load it, haul it, and leave you with room to
              breathe.
            </p>
          </div>
          <div className="public-photo">
            <Image
              src="/images/gallery/trailer_16x9.jpg"
              alt="Stonegate’s 7 by 16 foot junk removal trailer"
              fill
              sizes="(min-width: 768px) 480px, 100vw"
            />
          </div>
        </div>
      </div>
    </Section>
  );
}
