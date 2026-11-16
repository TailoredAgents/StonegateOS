import Link from "next/link";
import type { Metadata } from "next";
import { Section } from "@myst-os/ui";
import { ArrowUpRight, BookOpen } from "lucide-react";
import { PublicPageIntro } from "@/components/public-site/PublicPageIntro";
import { absoluteUrl } from "@/lib/metadata";

type BlogListResponse = {
  ok?: boolean;
  posts?: Array<{
    slug: string;
    title: string;
    excerpt: string | null;
    publishedAt: string | null;
    updatedAt: string | null;
  }>;
};

const API_BASE_URL =
  process.env["API_BASE_URL"] ?? process.env["NEXT_PUBLIC_API_BASE_URL"] ?? "";

async function fetchPosts() {
  const base = API_BASE_URL.replace(/\/$/, "");
  if (!base) return [];

  try {
    const res = await fetch(`${base}/api/public/blog?limit=50`, {
      next: { revalidate: 60 },
    });
    if (!res.ok) return [];
    const data = (await res.json().catch(() => ({}))) as BlogListResponse;
    return Array.isArray(data.posts) ? data.posts : [];
  } catch {
    return [];
  }
}

export const metadata: Metadata = {
  title: "Blog",
  description:
    "Helpful local guides, checklists, and cleanup tips from Stonegate Junk Removal in North Metro Atlanta.",
  openGraph: {
    title: "Blog",
    description:
      "Helpful local guides, checklists, and cleanup tips from Stonegate Junk Removal in North Metro Atlanta.",
    url: absoluteUrl("/blog"),
    type: "website",
  },
  alternates: {
    canonical: absoluteUrl("/blog"),
  },
};

function fmtDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}

export default async function Page() {
  const posts = await fetchPosts();

  return (
    <Section className="public-page">
      <div className="public-page-stack space-y-8">
        <PublicPageIntro
          eyebrow="The Stonegate journal"
          title="A little know-how. A lot more space."
          description="Local cleanout tips, practical checklists, and pickup prep guides for North Metro Atlanta."
        />

        {posts.length ? (
          <div className="public-blog-grid">
            {posts.map((post) => (
              <article key={post.slug} className="public-blog-card">
                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">
                    {fmtDate(post.publishedAt)}
                  </div>
                  <h2 className="text-xl font-semibold text-primary-900">
                    <Link
                      href={`/blog/${post.slug}`}
                      className="hover:underline"
                    >
                      {post.title}
                    </Link>
                  </h2>
                  {post.excerpt ? (
                    <p className="text-sm text-neutral-600">{post.excerpt}</p>
                  ) : null}
                  <div>
                    <Link
                      href={`/blog/${post.slug}`}
                      className="public-text-link"
                    >
                      Read the guide{" "}
                      <ArrowUpRight size={17} aria-hidden="true" />
                    </Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="public-empty">
            <BookOpen size={36} strokeWidth={1.5} aria-hidden="true" />
            <h2>More room for good advice.</h2>
            <p>
              Our next local guide is on the way. In the meantime, explore our
              services or get a head start on your pickup.
            </p>
            <Link href="/services" className="public-text-link">
              Explore our services <ArrowUpRight size={17} aria-hidden="true" />
            </Link>
          </div>
        )}
      </div>
    </Section>
  );
}
