import type { NextConfig } from "next";
import { createPartnerBillingCsp } from "./config/partner-billing-csp.mjs";

// Keep this in sync with next.config.mjs while both deployment entrypoints
// exist. Square's current Web Payments SDK requires its official script,
// frame, connect, style, and font origins on the payment page.
const partnerBillingCsp = createPartnerBillingCsp(
  process.env["PARTNER_MEDIA_STORAGE_ORIGIN"],
);

const nextConfig: NextConfig = {
  typescript: {
    // Temporarily ignore type errors during production builds on Render.
    // We still validate types locally and in CI.
    ignoreBuildErrors: true,
  },
  eslint: {
    // Skip ESLint during build to avoid non-blocking warnings failing deploys.
    ignoreDuringBuilds: true,
  },
  headers() {
    return Promise.resolve([
      {
        source: "/partners/billing",
        headers: [
          { key: "Content-Security-Policy", value: partnerBillingCsp },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Permissions-Policy",
            value: "camera=(), microphone=(), geolocation=(), payment=(self)",
          },
        ],
      },
    ]);
  },
  experimental: {
    // Allow larger uploads for Team Console (e.g., photo attachments).
    serverActions: {
      bodySizeLimit: "20mb",
    },
    // Next.js middleware default is 10MB; raise to match server action limit.
    middlewareClientMaxBodySize: "20mb",
  },
};

export default nextConfig;
