import type { ReactNode } from "react";
import {
  CommercialFooter,
  CommercialHeader,
  CommercialStickyContactBar,
} from "@/components/CommercialSiteChrome";
import { MetaPixel } from "@/components/MetaPixel";
import { PublicMarketingTags } from "@/components/PublicMarketingTags";
import { SiteStructuredData } from "@/components/StructuredData";
import { WebAnalyticsClient } from "@/components/WebAnalyticsClient";

export default function CommercialLayout({
  children,
}: {
  children: ReactNode;
}) {
  const metaPixelId = process.env["NEXT_PUBLIC_META_PIXEL_ID"] ?? null;

  return (
    <div className="flex min-h-screen flex-col bg-white pb-[calc(env(safe-area-inset-bottom,0px)+6rem)] md:pb-0">
      <PublicMarketingTags />
      <MetaPixel pixelId={metaPixelId} />
      <WebAnalyticsClient />
      <SiteStructuredData />
      <CommercialHeader />
      <main
        id="main-content"
        tabIndex={-1}
        className="flex-1 scroll-mt-24 focus:outline-none"
      >
        {children}
      </main>
      <CommercialFooter />
      <CommercialStickyContactBar />
    </div>
  );
}
