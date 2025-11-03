import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { allAreas, allPages, allServices } from "contentlayer/generated";
import { notFound } from "next/navigation";
import { BeforeAfterSlider, Button, Card, Section, Stat, Testimonials } from "@myst-os/ui";
import { HeroV2 } from "@/components/HeroV2";
import { LeadForm } from "@/components/LeadForm";
import { MdxContent } from "@/components/MdxContent";
import { StickyCtaBar } from "@/components/StickyCtaBar";
import { createPageMetadata } from "@/lib/metadata";
import { DEFAULT_LEAD_SERVICE_OPTIONS } from "@/lib/lead-services";

// Junk removal hero/gallery assets can be added under /images/services

type ResultTile = {
  title: string;
  description: string;
  afterImage: string;
  beforeImage?: string;
};

const resultTiles: ResultTile[] = [
  {
    title: "Garage Cleanout",
    description: "Boxes, old furniture, and junk cleared in one scheduled visit.",
    beforeImage: "/images/gallery/showcase/garage_before_aligned_16x9_1080p.jpg",
    afterImage: "/images/gallery/showcase/garage_after_aligned_16x9_1080p.jpg"
  },
  {
    title: "Appliance & Furniture Pickup",
    description: "Refrigerators, washers, and sofas hauled without scuffs or mess.",
    afterImage: "/images/services/junk-furniture.jpg"
  },
  {
    title: "Yard & Debris Removal",
    description: "Storm brush and light construction debris responsibly disposed.",
    afterImage: "/images/services/junk-yard.jpg"
  }
];

const testimonials = [
  {
    quote: "They cleared our garage in under two hours and swept up after. Pricing matched the estimate.",
    name: "Brianna S.",
    location: "Woodstock"
  },
  {
    quote: "On-time, professional, and careful through the house with a large sofa and fridge.",
    name: "Marcus T.",
    location: "Canton"
  },
  {
    quote: "Text updates, polite crew, and quick yard debris removal. CouldnÃ¢â‚¬â„¢t be easier.",
    name: "Alyssa K.",
    location: "Roswell"
  }
];

const stats = [
  { label: "Projects", value: "1,200+", secondary: "Completed across North Metro Atlanta" },
  { label: "Estimator Dispatch", value: "< 24 hrs", secondary: "Average onsite scheduling time" },
  { label: "Guarantee", value: "Make-It-Right", secondary: "We fix issues within 48 hours" }
];

export const metadata = createPageMetadata("home");

export default function HomePage() {
  const home = allPages.find((page) => page.slug === "home");
  if (!home) {
    notFound();
  }

  const services = [...allServices].sort((a, b) => a.title.localeCompare(b.title));
  const areas = allAreas.filter((area) => area.slug !== "index").sort((a, b) => a.title.localeCompare(b.title));
  const serviceContentMap = new Map(services.map((service) => [service.slug, service]));
  const leadServiceOptions = DEFAULT_LEAD_SERVICE_OPTIONS.map((option) => {
    const content = serviceContentMap.get(option.slug);
    return {
      ...option,
      description: content?.short ?? option.description
    };
  });
  const leadFormServices = [
    ...leadServiceOptions,
    {
      slug: "commercial-services",
      title: "Commercial Services",
      description: "Storefronts, office parks, HOA amenities, and shared spaces"
    }
  ];

  return (
    <div className="relative flex flex-col gap-16 pb-24">
      <Section className="pt-10 md:pt-12">
        <HeroV2 variant="lean" />
      </Section>
      <Section className="relative" containerClassName="">
        <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
          {resultTiles.map((tile) => (
            <article
              key={tile.title}
              className="group relative overflow-hidden rounded-3xl border border-neutral-200 bg-white shadow-soft transition hover:-translate-y-1 hover:shadow-float"
            >
              <div className="relative aspect-[16/10] overflow-hidden">
                <Image
                  src={tile.afterImage}
                  alt={`${tile.title} by Stonegate Junk Removal`}
                  fill
                  className="object-cover transition duration-700 group-hover:scale-105"
                  sizes="(min-width: 1280px) 400px, (min-width: 768px) 50vw, 100vw"
                  priority={false}
                />
                {tile.beforeImage ? (
                  <>
                    <div
                      className="pointer-events-none absolute inset-0 overflow-hidden transition duration-700 group-hover:translate-x-1"
                      style={{ clipPath: "inset(0 52% 0 0)" }}
                    >
                      <Image
                        src={tile.beforeImage}
                        alt={`${tile.title} before Stonegate service`}
                        fill
                        className="object-cover"
                        sizes="(min-width: 1280px) 400px, (min-width: 768px) 50vw, 100vw"
                        priority={false}
                      />
                    </div>
                    <div className="pointer-events-none absolute inset-y-0 left-[48%] w-px bg-white/80 shadow-[0_0_12px_rgba(15,23,42,0.35)]" />
                    <div className="absolute left-4 top-4 inline-flex items-center gap-1 rounded-full bg-black/60 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-white">
                      <span>Before</span>
                    </div>
                    <div className="absolute right-4 top-4 inline-flex items-center gap-1 rounded-full bg-primary-700/80 px-3 py-1 text-[0.65rem] font-semibold uppercase tracking-[0.18em] text-white">
                      <span>After</span>
                    </div>
                  </>
                ) : null}
              </div>
              <div className="space-y-2 px-6 py-5">
                <h3 className="text-lg font-semibold text-primary-900">{tile.title}</h3>
                <p className="text-sm text-neutral-600">{tile.description}</p>
              </div>
            </article>
          ))}
        </div>
      </Section>

      <Section containerClassName="gap-10">
        <div className="grid gap-6 sm:grid-cols-3">
          {stats.map((stat) => (
            <Stat key={stat.label} {...stat} />
          ))}
        </div>
        <div className="grid gap-8">
          <div className="rounded-xl border border-neutral-300/50 bg-white p-8 shadow-soft">
            <MdxContent code={home.body.code} />
          </div>
          <div id="schedule-estimate">
            <Suspense
              fallback={
                <div className="rounded-xl border border-neutral-300/50 bg-white p-8 text-sm text-neutral-600 shadow-soft">
                  Loading scheduler...
                </div>
              }
            >
              <LeadForm services={leadFormServices} />
            </Suspense>
          </div>
        </div>
      </Section>

      <Section className="mt-4">
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="font-display text-headline text-primary-800">Services for every pickup need</h2>
            <p className="mt-3 max-w-2xl text-body text-neutral-600">From single-item pickups to full cleanouts, Stonegate builds each visit around your space and schedule with clear, upfront estimates.</p>
          </div>
          <Button variant="secondary" asChild>
            <Link href="/services">Explore Services</Link>
          </Button>
        </div>
        <div className="grid gap-6 md:grid-cols-3">
          {leadFormServices.map((service) => {
            const isCommercial = service.slug === "commercial-services";
            return (
              <Card key={service.slug} className="flex h-full flex-col gap-4">
              <div>
                <h3 className="text-xl font-semibold text-primary-800">{service.title}</h3>
                  {service.description ? (
                    <p className="mt-2 text-body text-neutral-600">{service.description}</p>
                  ) : null}
              </div>
              <Button variant="ghost" asChild className="mt-auto w-fit px-0 text-accent-600">
                  <Link href={isCommercial ? "/contact?type=commercial" : `/services/${service.slug}`}>
                    {isCommercial ? "Request commercial quote ->" : "Learn more ->"}
                  </Link>
              </Button>
              </Card>
            );
          })}
        </div>
      </Section>

      <Section>
        <div className="grid gap-6">
          <div>
            <h2 className="font-display text-headline text-primary-800">Why Stonegate?</h2>
            <ul className="mt-3 space-y-2 text-body text-neutral-600">
              <li>- Careful in-home handling and floor protection.</li>
              <li>- Responsible disposal and recycling whenever possible.</li>
              <li>- Same-day and next-day availability.</li>
            </ul>
          </div>
        </div>
      </Section>

      <Section>
        <div className="grid gap-6">
          <div>
            <h2 className="font-display text-headline text-primary-800">See the Stonegate difference</h2>
            <p className="mt-3 text-body text-neutral-600">
              Slide to compare a real before-and-after result.
            </p>
          </div>
          <BeforeAfterSlider
            beforeImage="/images/gallery/showcase/garage_before_aligned_16x9_1080p.jpg"
            afterImage="/images/gallery/showcase/garage_after_aligned_16x9_1080p.jpg"
            alt="Garage cleanout transformation"
          />
        </div>
      </Section>

      <Section>
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="font-display text-headline text-primary-800">Homeowners and businesses rave about Stonegate</h2>
            <p className="mt-2 max-w-2xl text-body text-neutral-600">
              Verified five-star reviews and a make-it-right guarantee on every pickup.
            </p>
          </div>
          <Button variant="secondary" asChild>
            <Link href="/reviews">Read reviews</Link>
          </Button>
        </div>
        <Testimonials items={testimonials} />
      </Section>

      <Section>
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div>
            <h2 className="font-display text-headline text-primary-800">Serving North Metro communities</h2>
            <p className="mt-2 text-body text-neutral-600">
              Core coverage includes Woodstock, Towne Lake, Canton, Roswell, Alpharetta, and beyond. Extended travel options available up to 30 miles.
            </p>
          </div>
          <Button asChild>
            <Link href="/areas">View all areas</Link>
          </Button>
        </div>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {areas.slice(0, 6).map((area) => (
            <Card key={area.slug} className="flex h-full flex-col gap-3">
              <h3 className="text-lg font-semibold text-primary-800">{area.title}</h3>
              {area.city ? <p className="text-sm text-neutral-500">{area.city}</p> : null}
              <Button variant="ghost" asChild className="mt-auto w-fit px-0 text-accent-600">
                <Link href={`/areas/${area.slug}`}>Explore area{" ->"}</Link>
              </Button>
            </Card>
          ))}
        </div>
      </Section>
      <StickyCtaBar />
    </div>
  );
}
