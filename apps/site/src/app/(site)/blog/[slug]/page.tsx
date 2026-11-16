import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Section } from "@myst-os/ui";
import Link from "next/link";
import { PublicPageIntro } from "@/components/public-site/PublicPageIntro";
import { MarkdownContent } from "@/components/MarkdownContent";
import { absoluteUrl, siteUrl } from "@/lib/metadata";

type BlogPostResponse = {
  ok?: boolean;
  post?: {
    id: string;
    slug: string;
    title: string;
    excerpt: string | null;
    contentMarkdown: string;
    metaTitle: string | null;
    metaDescription: string | null;
    publishedAt: string;
    updatedAt: string | null;
  };
};

const API_BASE_URL =
  process.env["API_BASE_URL"] ?? process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "";

async function fetchPost(slug: string) {
  const base = API_BASE_URL.replace(/\/$/, "");
  if (!base) return null;

  try {
    const res = await fetch(
      `${base}/api/public/blog/${encodeURIComponent(slug)}`,
      {
        next: { revalidate: 60 },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as BlogPostResponse;
    return data.post ?? null;
  } catch {
    return null;
  }
}

function fmtDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
}

export async function generateMetadata(props: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await props.params;
  const post = await fetchPost(slug);
  if (!post) {
    return {
      title: "Blog",
      alternates: { canonical: absoluteUrl("/blog") },
    };
  }

  const title = post.metaTitle?.trim().length
    ? post.metaTitle.trim()
    : post.title;
  const description = post.metaDescription?.trim().length
    ? post.metaDescription.trim()
    : (post.excerpt ?? undefined);
  const path = `/blog/${post.slug}`;

  return {
    title,
    description,
    openGraph: {
      title: post.title,
      description,
      url: absoluteUrl(path),
      type: "article",
    },
    alternates: {
      canonical: absoluteUrl(path),
    },
  };
}

export default async function Page(props: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await props.params;
  const post = await fetchPost(slug);
  if (!post) {
    notFound();
  }

  const path = `/blog/${post.slug}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    datePublished: post.publishedAt,
    dateModified: post.updatedAt ?? post.publishedAt,
    mainEntityOfPage: absoluteUrl(path),
    image: [absoluteUrl("/opengraph-image")],
    author: { "@id": `${siteUrl}/#organization` },
    publisher: { "@id": `${siteUrl}/#organization` },
    description: post.metaDescription ?? post.excerpt ?? undefined,
  };

  return (
    <Section className="public-page">
      <div>
        <article className="public-article space-y-8">
          <Link href="/blog" className="public-text-link">
            ← All tips &amp; guides
          </Link>
          <PublicPageIntro
            eyebrow={fmtDate(post.publishedAt) || "The Stonegate journal"}
            title={post.title}
            description={post.excerpt}
          />
          <div className="public-article-body public-prose">
            <MarkdownContent markdown={post.contentMarkdown} />
          </div>
        </article>

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </div>
    </Section>
  );
}
