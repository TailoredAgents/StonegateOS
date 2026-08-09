import { readFileSync } from "node:fs";
import { join } from "node:path";

const API_ROOT = join(process.cwd());
const REPO_ROOT = join(process.cwd(), "../..");

function apiSource(relativePath: string): string {
  return readFileSync(join(API_ROOT, relativePath), "utf8");
}

function repoSource(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("SEO editorial workflow", () => {
  const migration = apiSource(
    "src/db/migrations/0074_seo_editorial_workflow.sql",
  );
  const agent = apiSource("src/lib/seo/agent.ts");
  const runRoute = apiSource("app/api/admin/seo/run/route.ts");
  const reviewRoute = apiSource(
    "app/api/admin/seo/posts/[postId]/review/route.ts",
  );
  const publishRoute = apiSource(
    "app/api/admin/seo/posts/[postId]/publish/route.ts",
  );
  const statusRoute = apiSource("app/api/admin/seo/status/route.ts");
  const siteActions = repoSource("apps/site/src/app/team/actions.ts");
  const siteSurface = repoSource(
    "apps/site/src/app/team/components/SeoAgentSection.tsx",
  );

  it("registers the additive editorial migration after durable dispatch", () => {
    const journal = JSON.parse(
      apiSource("src/db/migrations/meta/_journal.json"),
    ) as { entries?: Array<{ idx?: number; tag?: string }> };
    const entries = journal.entries ?? [];
    const dispatchIndex = entries.findIndex(
      (entry) => entry.tag === "0073_external_message_dispatches",
    );
    const editorialIndex = entries.findIndex(
      (entry) => entry.tag === "0074_seo_editorial_workflow",
    );
    expect(entries[dispatchIndex]).toEqual(
      expect.objectContaining({ idx: 70 }),
    );
    expect(entries[editorialIndex]).toEqual(
      expect.objectContaining({ idx: 71 }),
    );
    expect(editorialIndex).toBe(dispatchIndex + 1);
    expect(migration).toContain("'draft', 'review', 'published', 'failed'");
    expect(migration).toContain("blog_posts_publication_state_check");
    expect(migration).toContain("editorial_status\" = 'published'");
    expect(migration).toContain('published_at" IS NOT NULL');
    expect(migration).toContain("blog_posts_generation_key_hash_key");
    expect(migration).toContain("blog_posts_version_check");
    expect(migration).toContain("VALIDATE CONSTRAINT");
  });

  it("makes generation private and crash-replayable instead of autopublishing", () => {
    expect(agent).toContain("export async function maybeGenerateSeoDraft");
    expect(agent).toContain('editorialStatus: "draft"');
    expect(agent).toContain("publishedAt: null");
    expect(agent).toContain("generationKeyHash: generationKeyHash ?? null");
    expect(agent).toContain(
      "eq(blogPosts.generationKeyHash, generationKeyHash)",
    );
    expect(agent).toContain('action: "seo.draft.generated"');
    expect(agent).toContain('publicationEffect: "none"');

    const insertStart = agent.indexOf(".insert(blogPosts)");
    const insertEnd = agent.indexOf("await persistCursor", insertStart);
    expect(insertStart).toBeGreaterThan(-1);
    expect(agent.slice(insertStart, insertEnd)).not.toContain(
      "publishedAt: generatedAt",
    );
  });

  it("keeps the structured-output brief contract aligned with runtime validation", () => {
    expect(agent).toContain("const BRIEF_LIMITS = {");
    expect(agent).toContain("minLength: BRIEF_LIMITS.title.minimum");
    expect(agent).toContain("maxLength: BRIEF_LIMITS.title.maximum");
    expect(agent).toContain("minLength: BRIEF_LIMITS.metaDescription.minimum");
    expect(agent).toContain("minLength: BRIEF_LIMITS.excerpt.minimum");
    expect(agent).toContain("minItems: BRIEF_LIMITS.outline.minimumItems");
    expect(agent).toContain("maxItems: BRIEF_LIMITS.outline.maximumItems");
    expect(agent).toContain("minLength: BRIEF_LIMITS.outline.itemMinimum");
    expect(agent).toContain("maxLength: BRIEF_LIMITS.outline.itemMaximum");
  });

  it("puts generation behind the shared external/idempotent boundary", () => {
    const boundary = runRoute.indexOf("beginTeamMutation(");
    const body = runRoute.indexOf("request.json(");
    const provider = runRoute.indexOf("maybeGenerateSeoDraft(");
    expect(boundary).toBeGreaterThan(-1);
    expect(boundary).toBeLessThan(body);
    expect(boundary).toBeLessThan(provider);
    expect(runRoute).toContain('requiredPermissions: ["marketing.publish"]');
    expect(runRoute).toContain('risk: "external"');
    expect(runRoute).toContain("claimTeamMutationIdempotency");
    expect(runRoute).toContain("scheduleLimitsEnforced: true");
    expect(runRoute).toContain("force: false");
    expect(runRoute).toContain(
      "generationKeyHash: mutation.idempotencyKeyHash",
    );
    expect(runRoute).toContain("completeTeamMutationIdempotency");
    expect(runRoute).toContain("settleTeamMutationIdempotencyFailure");
    expect(runRoute).toContain('publicationEffect: "none"');
  });

  it("requires a versioned Draft to Review transition with atomic audit", () => {
    expect(reviewRoute.indexOf("beginTeamMutation(")).toBeLessThan(
      reviewRoute.indexOf("context.params"),
    );
    expect(reviewRoute).toContain("assertTeamMutationExpectedVersion");
    expect(reviewRoute).toContain('existing.editorialStatus !== "draft"');
    expect(reviewRoute).toContain('editorialStatus: "review"');
    expect(reviewRoute).toContain("reviewRequestedAt: now");
    expect(reviewRoute).toContain("mutation.audit.insertSuccess(tx");
    expect(reviewRoute).toContain("completeTeamMutationIdempotency(");
    expect(reviewRoute).toContain('publicationEffect: "none"');
    expect(reviewRoute).not.toContain("publishedAt: now");
  });

  it("publishes only reviewed, confirmed, eligible, versioned posts", () => {
    expect(publishRoute.indexOf("beginTeamMutation(")).toBeLessThan(
      publishRoute.indexOf("request.json("),
    );
    expect(publishRoute).toContain('risk: "external"');
    expect(publishRoute).toContain("assertTeamMutationExpectedVersion");
    expect(publishRoute).toContain(
      "parsed.data.confirmation !== existing.slug",
    );
    expect(publishRoute).toContain('existing.editorialStatus !== "review"');
    expect(publishRoute).toContain("recentPublished.length >= 2");
    expect(publishRoute).toContain("3 * DAY_MS");
    expect(publishRoute).toContain('editorialStatus: "published"');
    expect(publishRoute).toContain("publishedBy: actorId");
    expect(publishRoute).toContain("mutation.audit.insertSuccess(tx");
    expect(publishRoute).toContain("completeTeamMutationIdempotency(");
  });

  it("keeps public reads limited to actually published timestamps", () => {
    for (const route of [
      "app/api/public/blog/route.ts",
      "app/api/public/blog/[slug]/route.ts",
    ]) {
      const source = apiSource(route);
      expect(source).toContain("isNotNull(blogPosts.publishedAt)");
      expect(source).toContain("lte(blogPosts.publishedAt, now)");
    }
  });

  it("shows truthful status, private previews, and separate approval controls", () => {
    expect(statusRoute).toContain("editorialStatus: blogPosts.editorialStatus");
    expect(statusRoute).toContain("contentMarkdown: blogPosts.contentMarkdown");
    expect(statusRoute).toContain("generatedLast7Days");
    expect(statusRoute).toContain("nextGenerationEligibleAt");

    expect(siteSurface).toContain("Generate a private draft");
    expect(siteSurface).toContain("Generation can never make a post public");
    expect(siteSurface).toContain("Preview full draft and search metadata");
    expect(siteSurface).toContain("Submit for review");
    expect(siteSurface).toContain("Publish publicly");
    expect(siteSurface).toContain("Type <span");
    expect(siteSurface).toContain("Only Published posts are public");
    expect(siteSurface).toContain(
      'hasTeamPermission(principal, "marketing.publish")',
    );

    expect(siteActions).toContain("export async function runSeoDraftAction");
    expect(siteActions).toContain(
      "export async function submitSeoPostForReviewAction",
    );
    expect(siteActions).toContain("export async function publishSeoPostAction");
    expect(siteActions).toContain('"Idempotency-Key": idempotencyKey');
    expect(siteActions).toContain('"If-Match": expectedVersion');
    expect(siteActions).not.toContain(
      "export async function runSeoAutopublishAction",
    );
  });
});
