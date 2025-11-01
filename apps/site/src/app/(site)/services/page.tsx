import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, Button, Card, Section } from "@myst-os/ui";
import { absoluteUrl } from "@/lib/metadata";
import { getOrderedServices } from "../../../lib/content";

const description =
  "Explore our most‑requested junk removal services. Every visit includes careful handling, responsible disposal, and a make‑it‑right guarantee.";

export const metadata: Metadata = {
  title: "Junk removal services built for Georgia homes",
  description,
  openGraph: {
    title: "Junk removal services built for Georgia homes",
    description,
    url: absoluteUrl("/services"),
    type: "website"
  },
  alternates: {
    canonical: absoluteUrl("/services")
  }
};

export default function ServicesIndex() {
  const services = getOrderedServices();
  if (!services.length) {
    notFound();
  }

  return (
    <Section>
      <div className="mx-auto max-w-5xl space-y-6">
        <header className="space-y-3">
          <Badge tone="highlight">Junk Removal Specialists</Badge>
          <h1 className="font-display text-display text-primary-800">Junk removal services built for Georgia homes</h1>
          <p className="text-body text-neutral-600">
            Explore our most-requested packages. Every visit includes a detailed pre-walk, careful surface prep, and a make-it-right guarantee when we wrap.
          </p>
        </header>
        <div className="grid gap-6 md:grid-cols-2">
          {services.map((service) => (
            <Card key={service.slug} className="flex h-full flex-col gap-4">
              <div>
                <h2 className="text-2xl font-semibold text-primary-800">{service.title}</h2>
                {service.short ? (
                  <p className="mt-2 text-body text-neutral-600">{service.short}</p>
                ) : null}
              </div>
              <Button variant="ghost" asChild className="mt-auto w-fit px-0 text-accent-600">
                <Link href={`/services/${service.slug}`}>View details{" ->"}</Link>
              </Button>
            </Card>
          ))}
          <Card key="commercial-services" className="flex h-full flex-col gap-4">
            <div>
              <h2 className="text-2xl font-semibold text-primary-800">Commercial & Construction</h2>
              <p className="mt-2 text-body text-neutral-600">
                Offices, retail cleanouts, and light construction debris cleared with minimal disruption.
              </p>
            </div>
            <Button variant="ghost" asChild className="mt-auto w-fit px-0 text-accent-600">
              <Link href="/contact?type=commercial">Request commercial quote{" ->"}</Link>
            </Button>
          </Card>
        </div>
      </div>
    </Section>
  );
}

