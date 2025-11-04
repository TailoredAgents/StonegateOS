import Image from "next/image";
import { notFound } from "next/navigation";
import { Card, Section } from "@myst-os/ui";
import { MdxContent } from "@/components/MdxContent";
import { getPageBySlug } from "@/lib/content";
import { createPageMetadata } from "@/lib/metadata";

export const metadata = createPageMetadata("gallery");

const galleryItems = [
  {
    src: "/images/gallery/garage_before_after_split_1080p.jpg",
    alt: "Before and after garage cleanout with debris removed and floor swept",
    caption: "Garage cleanout — before and after"
  },
  {
    src: "/images/gallery/trailer_16x9.png",
    alt: "Stonegate 7x16 dumpster trailer ready for junk removal service",
    caption: "7x16 dumpster trailer — ready for your pickup"
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

