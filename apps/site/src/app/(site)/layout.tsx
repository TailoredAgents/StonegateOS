import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { StickyCtaBar } from "@/components/StickyCtaBar";
import { SiteChatBot } from "@/components/SiteChatBot";
import { SiteStructuredData } from "@/components/StructuredData";
import { WebAnalyticsClient } from "@/components/WebAnalyticsClient";
import { PublicMarketingTags } from "@/components/PublicMarketingTags";
import "@/components/public-site/public-site.css";

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div className="public-site flex min-h-screen flex-col">
      <PublicMarketingTags includeMetaPixel />
      <WebAnalyticsClient />
      <SiteStructuredData />
      <a href="#main-content" className="public-skip-link">
        Skip to content
      </a>
      <Header />
      <main
        id="main-content"
        tabIndex={-1}
        className="public-main flex-1 scroll-mt-28 focus:outline-none"
      >
        {children}
      </main>
      <Footer />
      <SiteChatBot />
      <StickyCtaBar />
    </div>
  );
}
