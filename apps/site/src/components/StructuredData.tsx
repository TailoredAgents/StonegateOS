import React from "react";
import { absoluteUrl, siteUrl } from "@/lib/metadata";
import { getPublicCompanyProfile } from "@/lib/company";

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
  const company = getPublicCompanyProfile();
  const businessName = company.name;
  const phoneE164 = company.phoneE164;
  const email = company.email;

  const sameAs = [
    process.env["NEXT_PUBLIC_GOOGLE_BUSINESS_PROFILE_URL"],
    process.env["NEXT_PUBLIC_FACEBOOK_PAGE_URL"],
    process.env["NEXT_PUBLIC_INSTAGRAM_URL"]
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));

  const gbpUrl = process.env["NEXT_PUBLIC_GOOGLE_BUSINESS_PROFILE_URL"]?.trim() || null;

  const businessId = `${siteUrl}/#business`;
  const organizationId = `${siteUrl}/#organization`;

  const organization = {
    "@id": organizationId,
    "@type": "Organization",
    name: businessName,
    url: siteUrl,
    logo: absoluteUrl(company.logoPath),
    email,
    telephone: phoneE164,
    sameAs: sameAs.length ? sameAs : undefined
  };

  const localBusiness = {
    "@context": "https://schema.org",
    "@type": ["LocalBusiness", "WasteRemovalService"],
    "@id": businessId,
    name: businessName,
    url: siteUrl,
    telephone: phoneE164,
    email,
    areaServed: [{ "@type": "State", name: "Georgia" }],
    address: {
      "@type": "PostalAddress",
      addressLocality: company.hqCity,
      addressRegion: company.hqState,
      addressCountry: company.hqCountry
    },
    image: [absoluteUrl("/opengraph-image")],
    logo: absoluteUrl(company.logoPath),
    priceRange: "$$",
    sameAs: sameAs.length ? sameAs : undefined,
    hasMap: gbpUrl ?? undefined,
    contactPoint: [
      {
        "@type": "ContactPoint",
        contactType: "customer service",
        telephone: phoneE164,
        email
      }
    ],
    openingHoursSpecification: [
      {
        "@type": "OpeningHoursSpecification",
        dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"],
        opens: "07:30",
        closes: "19:30"
      }
    ]
  };

  const website = {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: businessName,
    url: siteUrl,
    publisher: organization
  };

  return <JsonLdScript data={[organization, website, localBusiness]} />;
}

export function ServiceStructuredData(props: {
  title: string;
  description?: string | null;
  path: string;
  faqs?: Array<{ question: string; answer: string }>;
}): React.ReactElement {
  const company = getPublicCompanyProfile();
  const businessName = company.name;
  const phoneE164 = company.phoneE164;
  const businessId = `${siteUrl}/#business`;

  const service = {
    "@context": "https://schema.org",
    "@type": "Service",
    name: props.title,
    description: props.description ?? undefined,
    url: absoluteUrl(props.path),
    areaServed: [{ "@type": "State", name: "Georgia" }],
    provider: {
      "@id": businessId,
      "@type": ["LocalBusiness", "WasteRemovalService"],
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
