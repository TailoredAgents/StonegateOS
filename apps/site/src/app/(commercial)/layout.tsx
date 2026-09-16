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
import { CommercialBrandFrame } from "@/components/CommercialBrandFrame";
import styles from "@/components/CommercialTheme.module.css";

export default function CommercialLayout({
  children,
}: {
  children: ReactNode;
}) {
  const metaPixelId = process.env["NEXT_PUBLIC_META_PIXEL_ID"] ?? null;

  return (
    <div className={styles["theme"]}>
      <PublicMarketingTags />
      <MetaPixel pixelId={metaPixelId} />
      <WebAnalyticsClient />
      <SiteStructuredData />
      <CommercialBrandFrame>
        <CommercialHeader />
        <main
          id="main-content"
          tabIndex={-1}
          className="flex-1 scroll-mt-24 focus:outline-none"
        >
          {children}
        </main>
        <CommercialFooter />
      </CommercialBrandFrame>
      <CommercialStickyContactBar />
    </div>
  );
}
