import type { NextConfig } from "next";

// Keep this in sync with next.config.mjs while both deployment entrypoints
// exist. Square's current Web Payments SDK requires its official script,
// frame, connect, style, and font origins on the payment page.
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
