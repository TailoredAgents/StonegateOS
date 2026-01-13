import Link from "next/link";
import type { Metadata } from "next";
import { Card, Section } from "@myst-os/ui";
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
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "";

async function fetchPosts() {
  const base = API_BASE_URL.replace(/\/$/, "");
  if (!base) return [];

  const res = await fetch(`${base}/api/public/blog?limit=50`, {
    next: { revalidate: 60 }
  });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => ({}))) as BlogListResponse;
  return Array.isArray(data.posts) ? data.posts : [];
}

export const metadata: Metadata = {
  title: "Blog | Stonegate Junk Removal",
  description:
    "Helpful local guides, checklists, and cleanup tips from Stonegate Junk Removal in North Metro Atlanta.",
  openGraph: {
    title: "Blog | Stonegate Junk Removal",
    description:
      "Helpful local guides, checklists, and cleanup tips from Stonegate Junk Removal in North Metro Atlanta.",
    url: absoluteUrl("/blog"),
    type: "website"
  },
  alternates: {
    canonical: absoluteUrl("/blog")
  }
};

function fmtDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric" }).format(date);
}

export default async function Page() {
  const posts = await fetchPosts();

  return (
    <Section>
      <div className="mx-auto max-w-4xl space-y-6">
        <header className="space-y-3">
          <p className="text-label uppercase tracking-[0.28em] text-neutral-500">Stonegate Junk Removal</p>
          <h1 className="font-display text-display text-primary-800">Blog</h1>
          <p className="text-body text-neutral-600">
            Local cleanout tips, checklists, and pickup prep guides for North Metro Atlanta.
          </p>
        </header>

        {posts.length ? (
          <div className="grid gap-4">
            {posts.map((post) => (
              <Card key={post.slug} tone="outline" className="p-6">
                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-[0.18em] text-neutral-500">
                    {fmtDate(post.publishedAt)}
                  </div>
                  <h2 className="text-xl font-semibold text-primary-900">
                    <Link href={`/blog/${post.slug}`} className="hover:underline">
                      {post.title}
                    </Link>
                  </h2>
                  {post.excerpt ? <p className="text-sm text-neutral-600">{post.excerpt}</p> : null}
                  <div>
                    <Link
                      href={`/blog/${post.slug}`}
                      className="text-sm font-semibold text-primary-700 hover:underline"
                    >
                      Read more
                    </Link>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <Card tone="outline" className="p-6">
            <p className="text-sm text-neutral-600">No posts yet—check back soon.</p>
          </Card>
        )}
      </div>
    </Section>
  );
}
