import React from "react";
import { absoluteUrl, siteUrl } from "@/lib/metadata";

type JsonLd = Record<string, unknown>;

function JsonLdScript({ data }: { data: JsonLd | JsonLd[] }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

export function SiteStructuredData(): React.ReactElement {
  const businessName = "Stonegate Junk Removal";
  const phoneE164 = "+14047772631";
  const email = "austin@stonegatejunkremoval.com";

  const organization = {
    "@type": "Organization",
    name: businessName,
    url: siteUrl,
    logo: absoluteUrl("/images/brand/Stonegatelogo.png")
  };

  const localBusiness = {
    "@context": "https://schema.org",
    "@type": "WasteRemovalService",
    name: businessName,
    url: siteUrl,
    telephone: phoneE164,
    email,
    areaServed: [{ "@type": "State", name: "Georgia" }],
    address: {
      "@type": "PostalAddress",
      addressLocality: "Woodstock",
      addressRegion: "GA",
      addressCountry: "US"
    },
    image: [absoluteUrl("/opengraph-image")],
    logo: absoluteUrl("/images/brand/Stonegatelogo.png"),
    priceRange: "$$",
    sameAs: []
  };

  const website = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: businessName,
    url: siteUrl,
    publisher: organization
  };

  return <JsonLdScript data={[website, localBusiness]} />;
}

export function ServiceStructuredData(props: {
  title: string;
  description?: string | null;
  path: string;
  faqs?: Array<{ question: string; answer: string }>;
}): React.ReactElement {
  const businessName = "Stonegate Junk Removal";
  const phoneE164 = "+14047772631";

  const service = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: props.title,
    description: props.description ?? undefined,
    url: absoluteUrl(props.path),
    areaServed: [{ "@type": "State", name: "Georgia" }],
    provider: {
      "@type": "LocalBusiness",
      name: businessName,
      url: siteUrl,
      telephone: phoneE164
    }
  };

  const faqEntries = (props.faqs ?? [])
    .map((faq) => ({
      question: faq.question.trim(),
      answer: faq.answer.trim()
    }))
    .filter((faq) => faq.question.length > 0 && faq.answer.length > 0);

  const faqPage =
    faqEntries.length > 0
      ? {
          "@context": "https://schema.org",
          "@type": "FAQPage",
          mainEntity: faqEntries.map((faq) => ({
            "@type": "Question",
            name: faq.question,
            acceptedAnswer: { "@type": "Answer", text: faq.answer }
          }))
        }
      : null;

  const data = faqPage ? [service, faqPage] : [service];
  return <JsonLdScript data={data} />;
}
