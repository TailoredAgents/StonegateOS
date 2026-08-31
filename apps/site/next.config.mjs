import { withContentlayer } from "next-contentlayer";

// Square Web Payments SDK requirements:
// https://developer.squareup.com/docs/web-payments/content-security-policy
// Both official origins are allowed because sandbox/production selection is
// returned by the authenticated API at runtime; the client still accepts only
// the two exact versioned SDK URLs.
const partnerBillingCsp = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self' 'unsafe-inline' https://web.squarecdn.com https://sandbox.web.squarecdn.com",
  "style-src 'self' 'unsafe-inline' https://web.squarecdn.com https://sandbox.web.squarecdn.com",
  "frame-src https://web.squarecdn.com https://sandbox.web.squarecdn.com",
  "connect-src 'self' https://pci-connect.squareup.com https://pci-connect.squareupsandbox.com https://o160250.ingest.sentry.io",
  "font-src 'self' data: https://square-fonts-production-f.squarecdn.com https://d1g145x70srn7h.cloudfront.net",
  "img-src 'self' data: blob:",
  "upgrade-insecure-requests",
].join("; ");

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
