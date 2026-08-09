import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SITE_APP = join(process.cwd(), "../site/src/app");

function read(relativePath: string): string {
  return readFileSync(join(SITE_APP, relativePath), "utf8");
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const absolute = join(directory, entry);
    if (statSync(absolute).isDirectory()) return sourceFiles(absolute);
    return /\.(?:ts|tsx)$/u.test(entry) ? [absolute] : [];
  });
}

describe("authenticated Site privacy boundary", () => {
  it("does not load marketing tags from the root inherited by /team", () => {
    const rootLayout = read("layout.tsx");

    expect(rootLayout).not.toContain("GoogleTag");
    expect(rootLayout).not.toContain("PublicMarketingTags");
    expect(rootLayout).not.toContain("NEXT_PUBLIC_GA4_ID");
    expect(rootLayout).not.toContain("NEXT_PUBLIC_GOOGLE_ADS_TAG_ID");
    expect(rootLayout).not.toContain("connect.facebook.net");
  });

  it("loads marketing tags only on public acquisition surfaces", () => {
    expect(read("(site)/layout.tsx")).toContain("<PublicMarketingTags />");
    expect(read("schedule/layout.tsx")).toContain("<PublicMarketingTags />");
    expect(read("quote/layout.tsx")).not.toContain("<PublicMarketingTags />");
    expect(read("quote/layout.tsx")).toContain('referrer: "no-referrer"');
  });

  it("keeps the complete CRM route tree free of marketing trackers", () => {
    const forbidden = [
      "@/components/GoogleTag",
      "@/components/GoogleAdsTag",
      "@/components/MetaPixel",
      "@/components/PublicMarketingTags",
      "@/components/WebAnalyticsClient",
      "googletagmanager.com",
      "connect.facebook.net",
      "NEXT_PUBLIC_GA4_ID",
      "NEXT_PUBLIC_GOOGLE_ADS_TAG_ID",
      "NEXT_PUBLIC_META_PIXEL_ID",
      "window.gtag(",
      "window.fbq(",
    ];
    const violations = sourceFiles(join(SITE_APP, "team")).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return forbidden
        .filter((value) => source.includes(value))
        .map((value) => ({ file: file.replace(`${SITE_APP}/`, ""), value }));
    });

    expect(violations).toEqual([]);
  });

  it("keeps CRM referrers same-origin for CSRF proof without cross-origin leakage", () => {
    const layout = read("team/layout.tsx");
    expect(layout).toContain('referrer: "same-origin"');
    expect(layout).toContain("withholding CRM paths from every cross-origin");
    expect(layout).not.toContain('referrer: "origin"');
    expect(layout).not.toContain('referrer: "unsafe-url"');
    expect(layout).toContain("index: false");
    expect(layout).toContain("follow: false");
    expect(layout).toContain("nocache: true");
  });
});
