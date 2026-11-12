/**
 * Root layout: document shell, fonts, theme colour and iOS home-screen setup.
 */
import type { Metadata, Viewport } from "next";
// Inter is only a fallback: Apple devices render the system San Francisco font.
import "@fontsource-variable/inter";
import "./globals.css";

export const metadata: Metadata = {
  title: "Household Hub",
  description: "Shared lists that learn what your household buys and when.",
  applicationName: "Household Hub",
  // Full-screen launch from the iOS home screen.
  appleWebApp: { capable: true, title: "Hub", statusBarStyle: "default" },
  icons: {
    icon: [{ url: "/icons/icon.svg", type: "image/svg+xml" }],
    apple: [{ url: "/icons/apple-touch-icon.png", sizes: "180x180" }],
  },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Draw under the notch / home indicator; CSS pads with safe-area insets.
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
