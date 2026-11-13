/**
 * Root layout: document shell, fonts, theme colour and iOS home-screen setup.
 *
 * The person's theme (accent + light/dark) is read from a cookie and put on
 * <html> here, so the very first paint is already in their colours.
 */
import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
// Inter is only a fallback: Apple devices render the system San Francisco font.
import "@fontsource-variable/inter";
import "./globals.css";
import { parseThemeCookie, THEME_COOKIE, themeAttributes, themeCss } from "@/lib/themes";

export const metadata: Metadata = {
  title: "HomeHub",
  description: "Shared lists that learn what your household buys and when.",
  applicationName: "HomeHub",
  // Full-screen launch from the iOS home screen.
  appleWebApp: { capable: true, title: "HomeHub", statusBarStyle: "default" },
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

// Built once: the CSS for every accent, light and dark (see src/lib/themes.ts).
const THEME_CSS = themeCss();

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Step 1: the theme saved on this device (validated; defaults if missing).
  const { accent, mode } = parseThemeCookie((await cookies()).get(THEME_COOKIE)?.value);

  // Step 2: render with it applied. suppressHydrationWarning: the app may
  // update these attributes in the browser when the person changes theme.
  return (
    <html lang="en" {...themeAttributes(accent, mode)} suppressHydrationWarning>
      <head>
        <style dangerouslySetInnerHTML={{ __html: THEME_CSS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
