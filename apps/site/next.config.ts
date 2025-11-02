import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  typescript: {
    // Temporarily ignore type errors during production builds on Render.
    // We still validate types locally and in CI.
    ignoreBuildErrors: true
  },
  eslint: {
    // Skip ESLint during build to avoid non-blocking warnings failing deploys.
    ignoreDuringBuilds: true
  }
};

export default nextConfig;

