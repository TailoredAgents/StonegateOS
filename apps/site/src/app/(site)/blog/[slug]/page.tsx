import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Card, Section } from "@myst-os/ui";
import { MarkdownContent } from "@/components/MarkdownContent";
import { absoluteUrl } from "@/lib/metadata";

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
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "";

async function fetchPost(slug: string) {
  const base = API_BASE_URL.replace(/\/$/, "");
  if (!base) return null;

  const res = await fetch(`${base}/api/public/blog/${encodeURIComponent(slug)}`, {
    next: { revalidate: 300 }
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as BlogPostResponse;
  return data.post ?? null;
}

function fmtDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

export async function generateMetadata(
  props: { params: Promise<{ slug: string }> }
): Promise<Metadata> {
  const { slug } = await props.params;
  const post = await fetchPost(slug);
  if (!post) {
    return {
      title: "Blog | Stonegate Junk Removal",
      alternates: { canonical: absoluteUrl("/blog") }
    };
  }

  const title = post.metaTitle?.trim().length ? post.metaTitle.trim() : `${post.title} | Stonegate Junk Removal`;
  const description =
    post.metaDescription?.trim().length ? post.metaDescription.trim() : post.excerpt ?? undefined;
  const path = `/blog/${post.slug}`;

  return {
    title,
    description,
    openGraph: {
      title: post.title,
      description,
      url: absoluteUrl(path),
      type: "article"
    },
    alternates: {
      canonical: absoluteUrl(path)
    }
  };
}

export default async function Page(props: { params: Promise<{ slug: string }> }) {
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
    author: {
      "@type": "Organization",
      name: "Stonegate Junk Removal"
    },
    publisher: {
      "@type": "Organization",
      name: "Stonegate Junk Removal",
      logo: {
        "@type": "ImageObject",
        url: absoluteUrl("/images/brand/Stonegatelogo.png")
      }
    },
    description: post.metaDescription ?? post.excerpt ?? undefined
  };

  return (
    <Section>
      <div className="mx-auto max-w-4xl space-y-6">
        <Card tone="outline" className="p-6">
          <header className="space-y-3">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">{fmtDate(post.publishedAt)}</p>
            <h1 className="font-display text-headline text-primary-900">{post.title}</h1>
            {post.excerpt ? <p className="text-body text-neutral-600">{post.excerpt}</p> : null}
          </header>
        </Card>

        <Card tone="outline" className="p-6">
          <MarkdownContent markdown={post.contentMarkdown} />
        </Card>

        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
      </div>
    </Section>
  );
}

