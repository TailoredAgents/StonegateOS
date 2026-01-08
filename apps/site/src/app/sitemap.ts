import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/metadata";
import { getOrderedAreas, getOrderedPages, getOrderedServices } from "@/lib/content";

type BlogListResponse = {
  ok?: boolean;
  posts?: Array<{
    slug: string;
    updatedAt: string | null;
    publishedAt: string | null;
  }>;
};

const API_BASE_URL =
  process.env["API_BASE_URL"] ??
  process.env["NEXT_PUBLIC_API_BASE_URL"] ??
  "";

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const now = new Date();
  const urls: MetadataRoute.Sitemap = [];

  const pages = getOrderedPages().filter((page) => !page.draft);
  for (const page of pages) {
    const path = page.slug === "home" ? "/" : `/${page.slug}`;
    urls.push({ url: absoluteUrl(path), lastModified: now });
  }

  urls.push({ url: absoluteUrl("/services"), lastModified: now });
  getOrderedServices().forEach((service) => {
    urls.push({ url: absoluteUrl(`/services/${service.slug}`), lastModified: now });
  });

  urls.push({ url: absoluteUrl("/areas"), lastModified: now });
  getOrderedAreas().forEach((area) => {
    urls.push({ url: absoluteUrl(`/areas/${area.slug}`), lastModified: now });
  });

  urls.push({ url: absoluteUrl("/estimate"), lastModified: now });
  urls.push({ url: absoluteUrl("/contractors"), lastModified: now });

  urls.push({ url: absoluteUrl("/blog"), lastModified: now });
  const base = API_BASE_URL.replace(/\/$/, "");
  if (base) {
    try {
      const res = await fetch(`${base}/api/public/blog?limit=1000`, { next: { revalidate: 300 } });
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as BlogListResponse;
        const posts = Array.isArray(data.posts) ? data.posts : [];
        for (const post of posts) {
          if (!post.slug) continue;
          const lastModified = post.updatedAt ?? post.publishedAt;
          urls.push({
            url: absoluteUrl(`/blog/${post.slug}`),
            lastModified: lastModified ? new Date(lastModified) : now
          });
        }
      }
    } catch {
      // ignore sitemap blog fetch failures
    }
  }

  return urls;
}
