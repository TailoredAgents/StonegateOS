import type { Metadata } from "next";
import { Hammer, Trees, Truck } from "lucide-react";
import { Card, Section } from "@myst-os/ui";
import { CommercialContactActions } from "@/components/CommercialContactActions";
import { getPublicCompanyProfile } from "@/lib/company";
import { absoluteUrl } from "@/lib/metadata";

const title = "Junk Removal, Demolition & Land Clearing";
const description =
  "We help landlords, property managers, contractors, investors, and businesses with junk removal, demolition, and land clearing across North Metro Atlanta. Call us to discuss your project.";

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
    title: "Junk Removal",
    icon: Truck,
    description:
      "We clear out unwanted items and haul away debris from rentals, job sites, and commercial properties.",
    examples: [
      "Rental and property cleanouts",
      "Furniture, contents, and bulky items",
      "Construction and renovation debris",
    ],
  },
  {
    title: "Demolition",
    icon: Hammer,
    description:
      "We handle light demolition, removal, and cleanup. We review what needs to come out and confirm the scope with you before we begin.",
    examples: [
      "Cabinets, flooring, and fixtures",
      "Selective removal for remodels",
      "Cleanup and debris haul-off",
    ],
  },
  {
    title: "Land Clearing",
    icon: Trees,
    description:
      "We clear brush, overgrowth, and debris to help you make better use of your property. We review the area and access with you.",
    examples: [
      "Brush and overgrown areas",
      "Property and lot cleanup",
      "Clearing needs for your next project",
    ],
  },
] as const;

const clients = [
  {
    title: "Landlords & property managers",
    description:
      "We help you clear rental units, prepare for a turnover, and handle property cleanup.",
  },
  {
    title: "Contractors",
    description:
      "We remove jobsite debris and discuss demolition or clearing needs alongside your project.",
  },
  {
    title: "Investors",
    description:
      "We help you clear out a newly acquired property and plan the removal work ahead.",
  },
  {
    title: "Businesses",
    description:
      "We help you clear unwanted contents, clean up commercial spaces, and prepare for changes to your property.",
  },
] as const;

export default function ContractorsPage() {
  const company = getPublicCompanyProfile();

  return (
    <>
      <Section
        className="border-b border-neutral-200 bg-gradient-to-br from-primary-50/70 via-white to-white pb-12 pt-12 md:pb-16 md:pt-20"
        aria-labelledby="commercial-heading"
      >
        <header className="max-w-5xl">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary-700">
            North Metro Atlanta · Property &amp; project services
          </p>
          <h1
            id="commercial-heading"
            className="mt-5 max-w-4xl font-display text-4xl leading-tight tracking-tight text-primary-900 sm:text-5xl lg:text-6xl"
          >
            Junk Removal, Demolition &amp; Land Clearing
          </h1>
          <p className="mt-6 max-w-3xl text-lg leading-8 text-neutral-700">
            We help landlords, property managers, contractors, investors, and
            businesses clear out, take down, and prepare their properties. Tell
            us what you have in mind, and we’ll work through the scope with you.
          </p>
          <div className="mt-8">
            <CommercialContactActions placement="hero" />
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
            Our Services
          </h2>
        </div>
        <div className="grid gap-5 md:grid-cols-3">
          {services.map((service) => (
            <Card
              key={service.title}
              tone="outline"
              className="flex h-full flex-col p-6 lg:p-7"
            >
              <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-primary-50 text-primary-800">
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
        className="border-y border-neutral-200 bg-neutral-50 py-12 md:py-16"
        aria-labelledby="commercial-clients-heading"
      >
        <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:gap-14">
          <div className="max-w-xl">
            <h2
              id="commercial-clients-heading"
              className="font-display text-3xl tracking-tight text-primary-900 sm:text-4xl"
            >
              Properties and Projects We Support
            </h2>
            <p className="mt-5 text-base leading-7 text-neutral-700">
              From a rental turnover to a contractor’s job site, we start with
              what you need handled. We’ll discuss the property, access, and
              work involved so we can plan the next step together.
            </p>
          </div>
          <div className="grid gap-x-8 gap-y-7 sm:grid-cols-2">
            {clients.map((client) => (
              <div
                key={client.title}
                className="border-t border-neutral-300 pt-5"
              >
                <h3 className="text-base font-semibold text-primary-900">
                  {client.title}
                </h3>
                <p className="mt-2 text-sm leading-7 text-neutral-700">
                  {client.description}
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
            Discuss Your Project
          </h2>
          <p className="mt-5 text-base leading-8 text-neutral-700">
            Call us with the property location and a quick description of the
            work. We’ll discuss the scope, pricing, and scheduling with you
            before any work begins. If it’s easier, text us a few photos or
            email us the details.
          </p>
          <div className="mt-7">
            <CommercialContactActions placement="closing" />
          </div>
        </div>
      </Section>
    </>
  );
}
