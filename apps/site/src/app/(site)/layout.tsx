import type { ReactNode } from "react";
import { Header } from "@/components/Header";
import { Footer } from "@/components/Footer";
import { StickyCtaBar } from "@/components/StickyCtaBar";
import { ChatBot } from "@/components/ChatBot";
import { MetaPixel } from "@/components/MetaPixel";
import { SiteStructuredData } from "@/components/StructuredData";
import { WebAnalyticsClient } from "@/components/WebAnalyticsClient";

export default function SiteLayout({ children }: { children: ReactNode }) {
  const metaPixelId = process.env["NEXT_PUBLIC_META_PIXEL_ID"] ?? null;
  return (
    <div className="flex min-h-screen flex-col bg-gradient-to-b from-white via-neutral-100 to-white">
      <MetaPixel pixelId={metaPixelId} />
      <WebAnalyticsClient />
      <SiteStructuredData />
      <Header />
      <main className="flex-1 pb-[calc(env(safe-area-inset-bottom,0px)+6rem)] md:pb-0">
        {children}
      </main>
      <Footer />
      <ChatBot />
      <StickyCtaBar />
    </div>
  );
}



