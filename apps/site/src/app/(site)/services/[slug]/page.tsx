import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, Button, Card, Section } from "@myst-os/ui";
import { Breadcrumbs } from "@/components/Breadcrumbs";
import { MdxContent } from "@/components/MdxContent";
import { BreadcrumbStructuredData, ServiceStructuredData } from "@/components/StructuredData";
import { getOrderedAreas, getOrderedServices, getServiceBySlug } from "@/lib/content";
import { createServiceMetadata } from "@/lib/metadata";

interface ServicePageProps {
  params: Promise<{ slug: string }>;
}

export function generateStaticParams() {
  return getOrderedServices().map((service) => ({ slug: service.slug }));
}

export async function generateMetadata({ params }: ServicePageProps): Promise<Metadata> {
  const { slug } = await params;
  return createServiceMetadata(slug);
}

export default async function ServicePage({ params }: ServicePageProps) {
  const { slug } = await params;
  const service = getServiceBySlug(slug);
  const areas = getOrderedAreas();

  if (!service) {
    notFound();
  }

  const breadcrumbItems = [
    { label: "Home", href: "/" },
    { label: "Services", href: "/services" },
    { label: service.title, href: `/services/${service.slug}` }
  ];

  const faqs = (service.faq ?? []).map((entry) => {
    const [question, answer] = entry.split("|");
    return {
      question: question?.trim() ?? "",
      answer: answer?.trim() ?? ""
    };
  });

  return (
    <Section>
      <div className="mx-auto max-w-5xl space-y-8">
        <ServiceStructuredData
          title={service.title}
          description={service.short ?? null}
          path={`/services/${service.slug}`}
          faqs={faqs}
        />
        <BreadcrumbStructuredData
          items={[
            { name: "Home", path: "/" },
            { name: "Services", path: "/services" },
            { name: service.title, path: `/services/${service.slug}` }
          ]}
        />
        <Breadcrumbs items={breadcrumbItems} />
        <header className="space-y-3">
          <Badge tone="default">Stonegate Service</Badge>
          <h1 className="font-display text-display text-primary-800">{service.title}</h1>
          {service.short ? (
            <p className="text-body text-neutral-600">{service.short}</p>
          ) : null}
        </header>
        <Card tone="outline" className="space-y-6">
          <MdxContent code={service.body.code} />
        </Card>
        {faqs.length ? (
          <div className="space-y-4">
            <h2 className="font-display text-headline text-primary-800">Service FAQs</h2>
            <div className="grid gap-4 md:grid-cols-2">
              {faqs.map((faq) => (
                <Card key={faq.question} tone="subtle" className="space-y-2">
                  <p className="text-sm font-semibold text-primary-800">{faq.question}</p>
                  <p className="text-body text-neutral-600">{faq.answer}</p>
                </Card>
              ))}
            </div>
          </div>
        ) : null}
        {areas.length ? (
          <div className="space-y-3">
            <h2 className="font-display text-headline text-primary-800">Service areas</h2>
            <p className="text-body text-neutral-600">
              Explore where we provide {service.title.toLowerCase()} across North Metro Atlanta.
            </p>
            <div className="flex flex-wrap gap-2">
              {areas.map((area) => (
                <Button key={area.slug} size="sm" variant="secondary" asChild>
                  <Link href={`/areas/${area.slug}`}>{area.title}</Link>
                </Button>
              ))}
              <Button size="sm" variant="ghost" asChild>
                <Link href="/areas">View all areas</Link>
              </Button>
            </div>
          </div>
        ) : null}
        <Button asChild>
          <Link href="/estimate">Schedule an on-site estimate</Link>
        </Button>
      </div>
    </Section>
  );
}
