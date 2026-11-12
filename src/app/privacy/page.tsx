/**
 * Privacy policy. Public (no sign-in needed) because Google's sign-in
 * consent screen links to it.
 */
import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy – Household Hub" };

export default function PrivacyPage() {
  return (
    <main className="welcome" style={{ paddingTop: "calc(var(--safe-top) + 32px)", maxWidth: 640 }}>
      <h1 className="welcome__title" style={{ fontSize: 34 }}>Privacy</h1>
      <div style={{ color: "var(--ink-2)", fontSize: 16, lineHeight: 1.55, display: "grid", gap: 16 }}>
        <p style={{ margin: 0 }}>
          Household Hub is a private app for one family. Only Google accounts the household has invited can sign in.
        </p>
        <p style={{ margin: 0 }}>
          <strong style={{ color: "var(--ink)" }}>What we store.</strong> Your name, email address and profile photo
          from Google; the lists you create and what you add to them; and when items are ticked off, which the app
          uses to learn how often the household buys things.
        </p>
        <p style={{ margin: 0 }}>
          <strong style={{ color: "var(--ink)" }}>Where it lives.</strong> In a Supabase database in Frankfurt,
          Germany. Each household can only see its own data. Nothing is sold, shared with advertisers or used for
          anything other than running the app.
        </p>
        <p style={{ margin: 0 }}>
          <strong style={{ color: "var(--ink)" }}>Google access.</strong> The app asks Google only for your name, email
          address and profile photo, to sign you in.
        </p>
        <p style={{ margin: 0 }}>
          <strong style={{ color: "var(--ink)" }}>Removing your data.</strong> Ask the household owner, or email{" "}
          <a href="mailto:dewaldwasserfall@gmail.com" style={{ color: "var(--accent)" }}>
            dewaldwasserfall@gmail.com
          </a>
          , and your account and personal details will be deleted.
        </p>
        <p style={{ margin: 0, fontSize: 14 }}>Last updated 12 November 2026.</p>
        <p style={{ margin: 0 }}>
          <Link href="/login" style={{ color: "var(--accent)" }}>
            Back to sign in
          </Link>
        </p>
      </div>
    </main>
  );
}
