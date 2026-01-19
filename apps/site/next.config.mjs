import { withContentlayer } from "next-contentlayer";

const nextConfig = {
  typedRoutes: true,
  eslint: {
    ignoreDuringBuilds: true
  },
  experimental: {
    // Allow larger uploads for Team Console (e.g., photo attachments).
    serverActions: {
      bodySizeLimit: "20mb"
    },
    // Next.js middleware default is 10MB; raise to match server action limit.
    middlewareClientMaxBodySize: "20mb"
  }
};

export default withContentlayer(nextConfig);

