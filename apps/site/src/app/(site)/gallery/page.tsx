import Image from "next/image";
import { notFound } from "next/navigation";
import { Card, Section } from "@myst-os/ui";
import { MdxContent } from "@/components/MdxContent";
import { getPageBySlug } from "@/lib/content";
import { createPageMetadata } from "@/lib/metadata";

export const metadata = createPageMetadata("gallery");

const galleryItems = [
  {
    src: "/images/gallery/showcase/BrickWall_beforeafter_16x9.png",
    alt: "Before and after cleanup of a brick area with debris removed",
    caption: "Brick facade revival in Downtown Woodstock"
  },
  {
    src: "/images/gallery/showcase/Sidewalk_beforeafter_16x9.png",
    alt: "Before and after of sidewalk cleaned free of clay and rust stains",
    caption: "Clay-stained sidewalk restored near Towne Lake"
  },
  {
    src: "/images/gallery/showcase/home-after.png",
    alt: "Front elevation of a home after junk removal with a clear driveway and entry",
    caption: "Full property glow-up in Bridgemill"
  },
  {
    src: "/images/gallery/showcase/commercial-after.png",
    alt: "Clean commercial service entry for Audi Atlanta",
    caption: "After-hours exterior refresh for Audi Atlanta"
  },
  {
    src: "/images/gallery/showcase/after.png",
    alt: "Driveway and entryway after junk removal and cleanup",
    caption: "Driveway decontamination in Milton"
  }
];

export default function Page() {
  const page = getPageBySlug("gallery");
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
          <MdxContent code={page.body.code} />
        </Card>
        <div className="grid gap-6 sm:grid-cols-2">
          {galleryItems.map((item) => (
            <figure
              key={item.src}
              className="overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-soft"
            >
              <div className="relative aspect-[16/9]">
                <Image
                  src={item.src}
                  alt={item.alt}
                  fill
                  sizes="(min-width: 1024px) 420px, (min-width: 768px) 50vw, 100vw"
                  className="object-cover"
                  priority={false}
                />
              </div>
              {item.caption ? (
                <figcaption className="px-5 py-4 text-sm text-neutral-600">{item.caption}</figcaption>
              ) : null}
            </figure>
          ))}
        </div>
      </div>
    </Section>
  );
}

