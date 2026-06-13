import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { and, eq, isNotNull, lte } from "drizzle-orm";
import { blogPosts, getDb } from "@/db";

const FORBIDDEN_PUBLIC_SERVICE_PATTERN =
  /\b(yard|lawn|brush|branch|branches|leaf|leaves|green[-\s]?waste|storm debris|overgrowth|vines?|weeds?|saplings?|land clearing|landscaping|outdoor items|patio items)\b/i;

function hasForbiddenPublicServiceTerms(input: Array<string | null>): boolean {
  return FORBIDDEN_PUBLIC_SERVICE_PATTERN.test(input.filter(Boolean).join(" "));
}

export async function GET(
  _request: NextRequest,
  context: { params: Promise<{ slug: string }> }
): Promise<Response> {
  const { slug } = await context.params;
  if (!slug) {
    return NextResponse.json({ error: "missing_slug" }, { status: 400 });
  }

  const db = getDb();
  const now = new Date();

  const rows = await db
    .select({
      id: blogPosts.id,
      slug: blogPosts.slug,
      title: blogPosts.title,
      excerpt: blogPosts.excerpt,
      contentMarkdown: blogPosts.contentMarkdown,
      metaTitle: blogPosts.metaTitle,
      metaDescription: blogPosts.metaDescription,
      publishedAt: blogPosts.publishedAt,
      updatedAt: blogPosts.updatedAt
    })
    .from(blogPosts)
    .where(and(eq(blogPosts.slug, slug), isNotNull(blogPosts.publishedAt), lte(blogPosts.publishedAt, now)))
    .limit(1);

  const post = rows[0];
  if (!post || !post.publishedAt) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  if (
    hasForbiddenPublicServiceTerms([
      post.slug,
      post.title,
      post.excerpt,
      post.metaTitle,
      post.metaDescription,
      post.contentMarkdown
    ])
  ) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  return NextResponse.json({
    ok: true,
    post: {
      id: post.id,
      slug: post.slug,
      title: post.title,
      excerpt: post.excerpt ?? null,
      contentMarkdown: post.contentMarkdown,
      metaTitle: post.metaTitle ?? null,
      metaDescription: post.metaDescription ?? null,
      publishedAt: post.publishedAt.toISOString(),
      updatedAt: post.updatedAt ? post.updatedAt.toISOString() : null
    }
  });
}
