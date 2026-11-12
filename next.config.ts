import type { NextConfig } from "next";

/**
 * Next.js configuration.
 * Kept deliberately small: the app is fully dynamic (every page depends on the
 * signed-in household), so there is nothing to tune for static generation.
 */
const nextConfig: NextConfig = {
  reactStrictMode: true,
  images: {
    // Google profile pictures for household members.
    remotePatterns: [{ protocol: "https", hostname: "lh3.googleusercontent.com" }],
  },
};

export default nextConfig;
