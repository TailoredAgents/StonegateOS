import { withContentlayer } from "next-contentlayer";
import { createPartnerBillingCsp } from "./config/partner-billing-csp.mjs";

// Square Web Payments SDK requirements:
// https://developer.squareup.com/docs/web-payments/content-security-policy
// Both official origins are allowed because sandbox/production selection is
// returned by the authenticated API at runtime; the client still accepts only
// the two exact versioned SDK URLs.
const partnerBillingCsp = createPartnerBillingCsp(
  process.env["PARTNER_MEDIA_STORAGE_ORIGIN"],
);

const nextConfig = {
  typedRoutes: true,
  eslint: {
    ignoreDuringBuilds: true,
  },
  async redirects() {
    return [
      { source: "/areas/areas", destination: "/areas", permanent: true },
      { source: "/areas/index", destination: "/areas", permanent: true },
    ];
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

export default withContentlayer(nextConfig);
