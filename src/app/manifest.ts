import type { MetadataRoute } from "next";

/**
 * Web app manifest: lets both phones install the app to the home screen,
 * where it opens full screen like a native app.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Household Hub",
    short_name: "Hub",
    description: "Shared lists that learn what your household buys and when.",
    start_url: "/",
    display: "standalone",
    background_color: "#f2f2f7",
    theme_color: "#f2f2f7",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icons/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
