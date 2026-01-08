import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Badge, Button, Card, Section } from "@myst-os/ui";
import { MdxContent } from "@/components/MdxContent";
import { getOrderedServices, getServiceBySlug } from "@/lib/content";
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

  if (!service) {
    notFound();
  }

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
        <Button asChild>
          <Link href="/estimate">Schedule an on-site estimate</Link>
        </Button>
      </div>
    </Section>
  );
}
