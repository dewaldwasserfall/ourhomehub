/**
 * Runs before every page request.
 *
 * 1. Refreshes the Supabase session cookie so it never silently expires.
 * 2. Sends signed-out visitors to /login.
 *
 * Household membership is checked later, in the (app) layout, because it
 * needs a database read that is not worth doing for every asset request.
 */
import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/** Paths anyone may open without signing in. */
const PUBLIC_PATHS = [
  "/login",
  "/auth/",
  "/privacy",
  // Called by Google and Vercel Cron; each checks its own secret.
  "/api/calendar/webhook",
  "/api/cron/",
  // The Family board: the tablet pairs with a one-time code before it has a
  // session (the board layout shows the pairing screen when signed out).
  "/board",
  "/api/board/pair",
];

export async function middleware(request: NextRequest) {
  // Step 1: start from a pass-through response we can attach cookies to.
  let response = NextResponse.next({ request });

  // Step 2: a Supabase client that reads request cookies and writes refreshed
  // ones to both the request (for later server code) and the response.
  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
          response = NextResponse.next({ request });
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
        },
      },
    },
  );

  // Step 3: validate the session with Supabase (also refreshes it if needed).
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Step 4: signed out and not on a public page -> go to /login
  // (API routes answer 401 instead of redirecting).
  const isPublic = PUBLIC_PATHS.some((p) => request.nextUrl.pathname.startsWith(p));
  if (!user && !isPublic && request.nextUrl.pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "not_authenticated", message: "Your session ended. Sign in again." }, { status: 401 });
  }
  if (!user && !isPublic) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.search = "";
    return NextResponse.redirect(loginUrl);
  }

  return response;
}

export const config = {
  // Skip Next internals, the PWA manifest, the service worker and static images.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|sw.js|icons/|.*\\.(?:svg|png|jpg|jpeg|webp)$).*)"],
};
