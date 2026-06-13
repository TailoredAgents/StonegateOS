UPDATE "blog_posts"
SET "published_at" = NULL,
    "updated_at" = NOW()
WHERE "published_at" IS NOT NULL
  AND (
    "slug" ~* '\m(yard|lawn|brush|branch|branches|leaf|leaves|green[-[:space:]]?waste|storm debris|overgrowth|vines?|weeds?|saplings?|land clearing|landscaping|outdoor items|patio items)\M'
    OR "title" ~* '\m(yard|lawn|brush|branch|branches|leaf|leaves|green[-[:space:]]?waste|storm debris|overgrowth|vines?|weeds?|saplings?|land clearing|landscaping|outdoor items|patio items)\M'
    OR COALESCE("excerpt", '') ~* '\m(yard|lawn|brush|branch|branches|leaf|leaves|green[-[:space:]]?waste|storm debris|overgrowth|vines?|weeds?|saplings?|land clearing|landscaping|outdoor items|patio items)\M'
    OR COALESCE("meta_title", '') ~* '\m(yard|lawn|brush|branch|branches|leaf|leaves|green[-[:space:]]?waste|storm debris|overgrowth|vines?|weeds?|saplings?|land clearing|landscaping|outdoor items|patio items)\M'
    OR COALESCE("meta_description", '') ~* '\m(yard|lawn|brush|branch|branches|leaf|leaves|green[-[:space:]]?waste|storm debris|overgrowth|vines?|weeds?|saplings?|land clearing|landscaping|outdoor items|patio items)\M'
    OR "content_markdown" ~* '\m(yard|lawn|brush|branch|branches|leaf|leaves|green[-[:space:]]?waste|storm debris|overgrowth|vines?|weeds?|saplings?|land clearing|landscaping|outdoor items|patio items)\M'
  );
