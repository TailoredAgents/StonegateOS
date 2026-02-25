import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { allAreas, allPages, allServices } from "contentlayer/generated";
import { notFound } from "next/navigation";
import {
  BeforeAfterSlider,
  Button,
  Card,
  Section,
  Stat,
  Testimonials,
} from "@myst-os/ui";
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

type TransformationShowcase = {
  title: string;
  description: string;
  alt: string;
  beforeImage: string;
  afterImage: string;
};

const GOOGLE_REVIEW_RATING =
  process.env["NEXT_PUBLIC_GOOGLE_REVIEW_RATING"]?.trim() || "5.0";
const GOOGLE_REVIEW_COUNT =
  process.env["NEXT_PUBLIC_GOOGLE_REVIEW_COUNT"]?.trim() || "15";

const resultTiles: ResultTile[] = [
  {
    title: "Garage Cleanout",
    description:
      "Boxes, old furniture, and junk cleared in one scheduled visit.",
    afterImage: "/images/gallery/showcase/garage_after_aligned_16x9_1080p.jpg",
  },
  {
    title: "Appliance & Furniture Pickup",
    description:
      "Refrigerators, washers, and sofas hauled without scuffs or mess.",
    afterImage: "/images/services/Junkremoval.jpg",
  },
  {
    title: "Yard & Debris Removal",
    description:
      "Storm brush and light construction debris responsibly disposed.",
    afterImage: "/images/services/Yarddebris.jpg",
  },
];

const testimonials = [
  {
    quote:
      "The two guys who helped me were great! Very polite and eager to help. I inquired yesterday and the process is already over - everything was incredibly easy.",
    name: "Ashlyn Hickmon",
    location: "Google Review",
  },
  {
    quote:
      "Removed garage contents. On time and professional. Would use their services again!",
    name: "Sharon Martin",
    location: "Google Review",
  },
  {
    quote: "The guys were great! Very professional and helpful!",
    name: "Debbie McCaulley",
    location: "Google Review",
  },
];

const stats = [
  {
    label: "Google Rating",
    value: `${GOOGLE_REVIEW_RATING} / 5`,
    secondary: `Based on ${GOOGLE_REVIEW_COUNT} verified Google reviews`,
  },
  {
    label: "Response Time",
    value: "< 24 hrs",
    secondary: "Fast replies for quote requests and scheduling",
  },
  {
    label: "Established",
    value: "Nov 2025",
    secondary: "Locally owned and operated in Woodstock, GA",
  },
];

const transformationShowcases: TransformationShowcase[] = [
  {
    title: "Garage Cleanout",
    description:
      "Large clutter pile removed and swept for a clear two-car garage.",
    alt: "Garage cleanout transformation in Woodstock",
    beforeImage: "/images/gallery/customer/garage-before-01.jpg",
    afterImage: "/images/gallery/customer/garage-after-01.jpg",
  },
  {
    title: "Living Area Cleanout",
    description:
      "Household debris and scattered items cleared for a move-ready room.",
    alt: "Living area cleanout transformation in North Metro Atlanta",
    beforeImage: "/images/gallery/customer/living-before-02.jpg",
    afterImage: "/images/gallery/customer/living-after-02.jpg",
  },
  {
    title: "Bedroom Debris Removal",
    description:
      "Single-room cleanup completed with a final sweep before departure.",
    alt: "Bedroom debris removal transformation in Woodstock",
    beforeImage: "/images/gallery/customer/bedroom-before-03.jpg",
    afterImage: "/images/gallery/customer/bedroom-after-03.jpg",
  },
];

const commitments = [
  {
    title: "No-Surprise Pricing Policy",
    description:
      "Before work begins, we confirm included items and your total price so you know exactly what you are approving.",
  },
  {
    title: "Scope-Approved Additions",
    description:
      "If you add items outside the agreed scope, we provide an updated quote and only continue with your approval.",
  },
  {
    title: "Residential-First Care",
    description:
      "Background-checked, licensed, and insured crews protect floors, walls, and walkways during every pickup.",
  },
];

const bookingSteps = [
  {
    title: "1) Request your instant quote",
    description:
      "Answer a few questions and pick your load size in under a minute.",
  },
  {
    title: "2) Confirm scope and pricing",
    description:
      "We review included items, final price, and same-day availability before we start.",
  },
  {
    title: "3) Book and get it cleared",
    description:
      "Choose your slot online. Our crew hauls and finishes with a final walkthrough.",
  },
];

const homeFaqs = [
  {
    question: "How does your No-Surprise Pricing Policy work?",
    answer:
      "We confirm exactly what is included before work begins. If additional items are added, we provide an updated quote first and only proceed after your approval.",
  },
  {
    question: "Do you offer same-day junk removal?",
    answer:
      "Yes. Same-day appointments are often available based on route capacity and scope.",
  },
  {
    question: "What areas do you serve?",
    answer:
      "For half-load and larger jobs, we cover up to 25 miles from Woodstock, GA. For single-item to quarter-load pickups, coverage is up to 15 miles.",
  },
  {
    question: "Do you charge travel fees?",
    answer: "No travel fees are charged in our core service area.",
  },
  {
    question: "Are your crews licensed and insured?",
    answer: "Yes. Stonegate operates with licensed and insured crews.",
  },
  {
    question: "Can I book online?",
    answer:
      "Yes. You can get an instant quote and book online directly from our site.",
  },
];

export const metadata = createPageMetadata("home");

export default function HomePage() {
  const home = allPages.find((page) => page.slug === "home");
  if (!home) {
    notFound();
  }
  const googleReviewsUrl =
    process.env["NEXT_PUBLIC_GOOGLE_BUSINESS_PROFILE_URL"]?.trim() ||
    "https://www.google.com/maps/place/Stonegate+Junk+Removal/@34.1041655,-84.462036,10z/data=!4m8!3m7!1s0x2077851b6c5fd83:0xddcf0b747e40a4ee!8m2!3d34.1041654!4d-84.462036!9m1!1b1!16s%2Fg%2F11yvx_5c88";
  const faqStructuredData = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: homeFaqs.map((faq) => ({
      "@type": "Question",
      name: faq.question,
      acceptedAnswer: {
        "@type": "Answer",
        text: faq.answer,
      },
    })),
  } as const;

  const services = [...allServices].sort((a, b) =>
    a.title.localeCompare(b.title),
  );
  const areas = allAreas
    .filter((area) => area.slug !== "index")
    .sort((a, b) => a.title.localeCompare(b.title));
  const serviceContentMap = new Map(
    services.map((service) => [service.slug, service]),
  );
  const leadServiceOptions = DEFAULT_LEAD_SERVICE_OPTIONS.map((option) => {
    const content = serviceContentMap.get(option.slug);
    return {
      ...option,
      description: content?.short ?? option.description,
    };
  });
  const leadFormServices = [
    ...leadServiceOptions,
    {
      slug: "commercial-services",
      title: "Commercial Services",
      description:
        "Storefronts, office parks, HOA amenities, and shared spaces",
    },
  ];

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(faqStructuredData) }}
      />
      <div className="relative flex flex-col gap-14 pb-20 sm:gap-16 sm:pb-24">
        <Section className="pt-10 md:pt-12">
          <HeroV2 variant="full" />
        </Section>
        <Section className="relative" containerClassName="">
          <div className="grid gap-6 sm:grid-cols-2 xl:grid-cols-3">
            {resultTiles.map((tile, index) => (
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
                    priority={index === 0}
                    quality={60}
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
                          quality={60}
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
                  <h3 className="text-lg font-semibold text-primary-900">
                    {tile.title}
                  </h3>
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
          <div className="rounded-2xl border border-primary-200/60 bg-white p-6 shadow-soft sm:p-8">
            <div className="flex flex-col gap-3">
              <p className="text-label uppercase tracking-[0.24em] text-accent-700">
                No-Surprise Pricing Policy
              </p>
              <h2 className="font-display text-headline text-primary-800">
                Clear scope. Clear price. Approved before we haul.
              </h2>
              <p className="max-w-3xl text-body text-neutral-600">
                Before work begins, we confirm the exact items and areas
                included in your job. If you add anything outside that scope, we
                update the quote and only proceed with your approval.
              </p>
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-3">
              {commitments.map((commitment) => (
                <Card
                  key={commitment.title}
                  className="flex h-full flex-col gap-3 p-5"
                >
                  <h3 className="text-lg font-semibold text-primary-800">
                    {commitment.title}
                  </h3>
                  <p className="text-sm text-neutral-600">
                    {commitment.description}
                  </p>
                </Card>
              ))}
            </div>
            <div className="mt-6 grid gap-4 md:grid-cols-3">
              {bookingSteps.map((step) => (
                <Card
                  key={step.title}
                  className="flex h-full flex-col gap-2 border-primary-200/50 bg-primary-50/40 p-5"
                >
                  <h3 className="text-base font-semibold text-primary-800">
                    {step.title}
                  </h3>
                  <p className="text-sm text-neutral-600">{step.description}</p>
                </Card>
              ))}
            </div>
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
                <LeadForm />
              </Suspense>
            </div>
          </div>
        </Section>

        <Section className="mt-4 bg-neutral-50/55">
          <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-display text-headline text-primary-800">
                Services for every pickup need
              </h2>
              <p className="mt-3 max-w-2xl text-body text-neutral-600">
                From rubbish removal to full cleanouts, Stonegate builds each
                visit around your space and schedule with clear, upfront
                estimates.
              </p>
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
                    <h3 className="text-xl font-semibold text-primary-800">
                      {service.title}
                    </h3>
                    {service.description ? (
                      <p className="mt-2 text-body text-neutral-600">
                        {service.description}
                      </p>
                    ) : null}
                  </div>
                  <Button
                    variant="ghost"
                    asChild
                    className="mt-auto w-fit px-0 text-accent-700 hover:text-accent-800"
                  >
                    <Link
                      href={
                        isCommercial
                          ? "/contact?type=commercial"
                          : `/services/${service.slug}`
                      }
                    >
                      {isCommercial
                        ? "Request commercial quote ->"
                        : "Learn more ->"}
                    </Link>
                  </Button>
                </Card>
              );
            })}
          </div>
        </Section>

        {/* Removed "Why Stonegate?" section per request */}

        <Section className="bg-primary-50/25">
          <div className="grid gap-5 sm:gap-6">
            <div>
              <h2 className="font-display text-headline text-primary-800">
                See the Stonegate difference
              </h2>
              <p className="mt-3 text-body text-neutral-600">
                Real before-and-after results from recent residential cleanouts.
              </p>
              <p className="mt-1 text-sm text-neutral-500">
                Drag each slider to compare before and after.
              </p>
            </div>
            <div className="grid gap-5 sm:gap-6 md:grid-cols-2 xl:grid-cols-3">
              {transformationShowcases.map((showcase) => (
                <article
                  key={showcase.title}
                  className="space-y-3 rounded-xl border border-neutral-200 bg-white p-3 shadow-soft sm:space-y-4 sm:rounded-2xl sm:p-5"
                >
                  <BeforeAfterSlider
                    beforeImage={showcase.beforeImage}
                    afterImage={showcase.afterImage}
                    alt={showcase.alt}
                    aspectRatio="4/3"
                    imageSizes="(min-width: 1280px) 30vw, (min-width: 768px) 45vw, 100vw"
                  />
                  <div className="space-y-2">
                    <h3 className="text-lg font-semibold text-primary-800">
                      {showcase.title}
                    </h3>
                    <p className="text-sm text-neutral-600">
                      {showcase.description}
                    </p>
                  </div>
                </article>
              ))}
            </div>
          </div>
        </Section>

        <Section className="bg-neutral-50/65">
          <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-display text-headline text-primary-800">
                Homeowners and businesses rave about Stonegate
              </h2>
              <p className="mt-2 max-w-2xl text-body text-neutral-600">
                Verified five-star reviews from recent Stonegate pickups.
              </p>
            </div>
            <Button variant="secondary" asChild>
              <a href={googleReviewsUrl} target="_blank" rel="noreferrer">
                Read Google reviews
              </a>
            </Button>
          </div>
          <Testimonials items={testimonials} />
        </Section>

        <Section>
          <div className="grid gap-6">
            <div>
              <h2 className="font-display text-headline text-primary-800">
                Frequently asked junk removal questions
              </h2>
              <p className="mt-2 max-w-3xl text-body text-neutral-600">
                Straight answers about pricing, service area, and booking.
              </p>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {homeFaqs.map((faq) => (
                <Card key={faq.question} className="space-y-2">
                  <h3 className="text-base font-semibold text-primary-800">
                    {faq.question}
                  </h3>
                  <p className="text-sm text-neutral-600">{faq.answer}</p>
                </Card>
              ))}
            </div>
          </div>
        </Section>

        <Section>
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="font-display text-headline text-primary-800">
                Serving North Metro communities
              </h2>
              <p className="mt-2 text-body text-neutral-600">
                We cover up to 25 miles from Woodstock for half-load jobs and
                larger, and up to 15 miles for single-item and quarter-load
                pickups.
              </p>
            </div>
            <Button asChild>
              <Link href="/areas">View all areas</Link>
            </Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {areas.slice(0, 6).map((area) => (
              <Card key={area.slug} className="flex h-full flex-col gap-3">
                <h3 className="text-lg font-semibold text-primary-800">
                  {area.title}
                </h3>
                {area.city ? (
                  <p className="text-sm text-neutral-500">{area.city}</p>
                ) : null}
                <Button
                  variant="ghost"
                  asChild
                  className="mt-auto w-fit px-0 text-accent-700 hover:text-accent-800"
                >
                  <Link href={`/areas/${area.slug}`}>Explore area{" ->"}</Link>
                </Button>
              </Card>
            ))}
          </div>
        </Section>
        <StickyCtaBar />
      </div>
    </>
  );
}
