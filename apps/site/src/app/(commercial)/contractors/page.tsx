import type { Metadata } from "next";
import { Droplets, Hammer, Trees, Truck } from "lucide-react";
import { Card, Section } from "@myst-os/ui";
import { CommercialContactActions } from "@/components/CommercialContactActions";
import { getPublicCompanyProfile } from "@/lib/company";
import { absoluteUrl } from "@/lib/metadata";
import styles from "@/components/CommercialTheme.module.css";

const title = "Contractor Demo, Hauling & Cleanup";
const description =
  "We provide subcontractor support for demolition, debris removal, hauling, and jobsite cleanup across North Metro Atlanta. Call us about your next job or text project photos.";

export const metadata: Metadata = {
  title,
  description,
  alternates: { canonical: absoluteUrl("/contractors") },
  openGraph: {
    title,
    description,
    url: absoluteUrl("/contractors"),
    type: "website",
    images: [{ url: absoluteUrl("/opengraph-image") }],
  },
  twitter: {
    card: "summary_large_image",
    title,
    description,
    images: [absoluteUrl("/twitter-image")],
  },
};

const services = [
  {
    title: "Interior Demo & Removal",
    icon: Hammer,
    description:
      "We take on selective interior demolition and haul away what comes out. We confirm the scope and site conditions with you before work begins.",
    examples: [
      "Flooring and cabinet removal",
      "Bathroom tear-outs and fixture removal",
      "Non-structural demo for remodels",
    ],
  },
  {
    title: "Debris, Hauling & Cleanouts",
    icon: Truck,
    description:
      "We handle loading, haul-off, and jobsite cleanup between phases or at the end of a job. We also clear rentals and investment properties ahead of the next trade.",
    examples: [
      "Construction debris and jobsite cleanup",
      "Material hauling — tell us the load and route",
      "Rental turnovers and flip cleanouts",
    ],
  },
  {
    title: "Brush & Exterior Cleanup",
    icon: Trees,
    description:
      "We clear brush, overgrowth, and exterior debris around your project. For land clearing, we review the area, access, and extent of the work with you.",
    examples: [
      "Brush and overgrowth removal",
      "Exterior debris and lot cleanup",
      "Clearing access and work areas",
    ],
  },
  {
    title: "Soft Washing & Pressure Washing",
    icon: Droplets,
    description:
      "We offer soft washing and pressure washing for property turnovers, exterior upkeep, and cleanup at the end of a project. We’ll review the surfaces and scope with you before work begins.",
    examples: [
      "Property turnovers",
      "Exterior surface upkeep",
      "End-of-project cleanup",
    ],
  },
] as const;

const workingTogether = [
  {
    title: "Pricing for Contractor Work",
    description:
      "We offer contractor pricing based on the scope, access, and frequency of the work. We agree on the price before we start.",
  },
  {
    title: "One Project or Recurring Support",
    description:
      "We can handle a single phase or arrange recurring visits. We coordinate with you around project milestones, site access, and other trades.",
  },
  {
    title: "Photos & Invoicing",
    description:
      "We provide before-and-after job photos and invoicing, so you can document completed work and keep your project records together.",
  },
  {
    title: "Short-Notice Availability",
    description:
      "We offer same-day or next-day service when our schedule allows. Call us with the location and scope, and we’ll confirm availability with you.",
  },
] as const;

export default function ContractorsPage() {
  const company = getPublicCompanyProfile();

  return (
    <>
      <Section
        className={`${styles["hero"]} border-b pb-12 pt-12 md:pb-16 md:pt-20`}
        aria-labelledby="commercial-heading"
      >
        <header className="max-w-5xl">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary-700">
            North Metro Atlanta · Contractor crew support
          </p>
          <h1
            id="commercial-heading"
            className="mt-5 max-w-4xl font-display text-4xl leading-tight tracking-tight text-primary-900 sm:text-5xl lg:text-6xl"
          >
            Your Subcontractor for Demo &amp; Cleanup
          </h1>
          <div className={styles["divider"]} aria-hidden="true">
            <span />
          </div>
          <p className="mt-6 max-w-3xl text-lg leading-8 text-neutral-700">
            We take on demo, hauling, and cleanup for contractors, remodelers,
            and property teams. Bring us in for one project or recurring
            support, so you can keep your crew focused without adding permanent
            staff.
          </p>
          <div className="mt-8">
            <CommercialContactActions
              placement="hero"
              textLabel="Text Job Photos"
            />
          </div>
          <p className="mt-5 text-sm text-neutral-600">
            We’re based in {company.hqCity} and work across North Metro Atlanta.
          </p>
        </header>
      </Section>

      <Section
        id="services"
        className="scroll-mt-24 bg-white py-12 md:py-16"
        aria-labelledby="commercial-services-heading"
        containerClassName="gap-7"
      >
        <div className="max-w-2xl">
          <h2
            id="commercial-services-heading"
            className="font-display text-3xl tracking-tight text-primary-900 sm:text-4xl"
          >
            The Work We Can Take On
          </h2>
        </div>
        <div className="grid gap-5 md:grid-cols-2">
          {services.map((service) => (
            <Card
              key={service.title}
              tone="outline"
              className={`${styles["serviceCard"]} flex h-full flex-col p-6 lg:p-7`}
            >
              <div
                className={`${styles["serviceIcon"]} flex h-11 w-11 items-center justify-center`}
              >
                <service.icon
                  className="h-6 w-6"
                  strokeWidth={1.7}
                  aria-hidden="true"
                />
              </div>
              <h3 className="mt-5 text-xl font-semibold text-primary-900">
                {service.title}
              </h3>
              <p className="mt-3 text-sm leading-7 text-neutral-700">
                {service.description}
              </p>
              <ul className="mt-5 space-y-3 border-t border-neutral-200 pt-5 text-sm leading-6 text-neutral-600">
                {service.examples.map((example) => (
                  <li key={example} className="flex gap-3">
                    <span
                      className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-primary-400"
                      aria-hidden="true"
                    />
                    <span>{example}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ))}
        </div>
      </Section>

      <Section
        id="working-together"
        className={`${styles["clientSection"]} border-y py-12 md:py-16`}
        aria-labelledby="commercial-working-heading"
      >
        <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:gap-14">
          <div className="max-w-xl">
            <h2
              id="commercial-working-heading"
              className="font-display text-3xl tracking-tight text-primary-900 sm:text-4xl"
            >
              Built Around Your Project
            </h2>
            <p className="mt-5 text-base leading-7 text-neutral-700">
              We work alongside general contractors, remodelers, property
              managers, landlords, and rental or flip investors. Tell us which
              part of the job you need covered, and we’ll work through the scope
              and timing with you.
            </p>
          </div>
          <div className="grid gap-x-8 gap-y-7 sm:grid-cols-2">
            {workingTogether.map((item) => (
              <div
                key={item.title}
                className={`${styles["clientItem"]} border-t pt-5`}
              >
                <h3 className="text-base font-semibold text-primary-900">
                  {item.title}
                </h3>
                <p className="mt-2 text-sm leading-7 text-neutral-700">
                  {item.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <Section
        id="project"
        className="scroll-mt-24 bg-white py-12 md:py-16"
        aria-labelledby="commercial-project-heading"
      >
        <div className="max-w-3xl">
          <h2
            id="commercial-project-heading"
            className="font-display text-3xl tracking-tight text-primary-900 sm:text-4xl"
          >
            A Job That Doesn’t Fit the List?
          </h2>
          <p className="mt-5 text-base leading-8 text-neutral-700">
            Text us a few photos, the job location, and what you need done.
            We’ll let you know whether it’s a fit and what we’d need to quote
            it. If you’d rather talk it through, call us. You can also email the
            project details.
          </p>
          <div className="mt-7">
            <CommercialContactActions
              placement="closing"
              textLabel="Text Job Photos"
            />
          </div>
        </div>
      </Section>
    </>
  );
}
