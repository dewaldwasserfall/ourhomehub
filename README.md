# Household Hub

Shared household lists that learn what you buy and when. Version 1 covers:

- **Household logins.** Google sign-in, an allowlist of permitted accounts, and a six-character invite code so a second person can join.
- **Lists.** Shopping lists sorted by aisle, to-do lists, live sync between phones, quantities (`2 milk`, `500g mince`), notes, swipe to delete.
- **Predictions.** Every tick on a shopping list is a purchase. After three shopping days the app works out each item's rhythm, adds it to Groceries just before you usually run out, and adjusts the timing based on your feedback.

Built with Next.js 15 (App Router), Supabase (Postgres, Auth, Realtime, pg_cron) and Framer Motion. Installs to the home screen as a web app.

---

## Project layout

```
supabase/migrations/   Database schema, security rules, prediction engine, nightly job
src/app/               Screens (login, onboarding, lists, a single list, rhythms, household)
src/components/        UI building blocks (rows, composer, sheets, tab bar, icons)
src/lib/               Supabase clients, types, input parsing, aisle guessing, rhythm wording
tests/sql/             Database tests (run the real migrations in PGlite)
tests/unit/            Tests for the browser-side helpers
scripts/               Icon renderer
```

---

## Setup

You'll need a Supabase account, a Google Cloud account and (to host it) a Vercel account. All three have free tiers that cover a two-person household.

### 1. Create the Supabase project

1. In [Supabase](https://supabase.com/dashboard), create a new project. Pick the **Frankfurt (eu-central-1)** region to keep data in the EU.
2. Open **SQL Editor** and run the files in `supabase/migrations/` **in order**, pasting each one in full:
   1. `20261112000100_core_schema.sql`
   2. `20261112000200_engine_and_rpcs.sql`
   3. `20261112000300_realtime_and_schedule.sql`
   4. `20261112000400_allowlist_expiry.sql`

   (Or with the Supabase CLI: `supabase link --project-ref <ref>` then `supabase db push`.)
3. Add the Google accounts allowed to use the app (lowercase). Give temporary members an end date:

   ```sql
   insert into public.app_allowlist (email, note, expires_at) values
     ('you@gmail.com',     'Owner',   null),
     ('partner@gmail.com', 'Partner', null),
     ('guest@gmail.com',   'Au pair', '2026-12-10 23:59:59 Europe/Amsterdam');
   ```

   When an end date passes, or you delete someone's row, they lose access to all household data straight away, even if they're signed in. Whatever they added to the lists stays. To extend access, update `expires_at`.

### 2. Set up Google sign-in

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project (e.g. "Household Hub").
2. **APIs & Services > OAuth consent screen**: choose *External*, fill in the app name and your email, and add the scopes `email`, `profile` and `openid`.
3. **Publish the app** (set the status to *In production*). In *Testing* mode Google sign-ins expire after 7 days. You'll see an "unverified app" warning when signing in; that's expected for a private app and you can continue past it.
4. **Credentials > Create credentials > OAuth client ID**, type *Web application*.
   Under **Authorised redirect URIs** add:
   `https://<your-project-ref>.supabase.co/auth/v1/callback`
5. Copy the client ID and secret into Supabase: **Authentication > Sign In / Providers > Google**, then enable it.
6. In Supabase **Authentication > URL Configuration**:
   - **Site URL**: `https://ourhomehub.nl`
   - **Redirect URLs**: add `https://ourhomehub.nl/**`, `http://localhost:3000/**` and, for preview deployments, `https://*-dewaldwasserfall.vercel.app/**`
7. Back on the Google **OAuth consent screen**, add `ourhomehub.nl` under **Authorised domains** and set the home page to `https://ourhomehub.nl`.

### 3. Run it locally

```bash
cp .env.example .env.local     # then fill in the two values from Supabase > Project Settings > API
npm install
npm run dev                    # http://localhost:3000
```

### 4. Deploy to Vercel

1. Import this GitHub repo in [Vercel](https://vercel.com/new).
2. Add the environment variables `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`.
3. Deploy.

### 5. Point ourhomehub.nl at Vercel (Porkbun)

1. In Vercel: **Project > Settings > Domains**, add `ourhomehub.nl` and `www.ourhomehub.nl` (redirect `www` to the bare domain).
2. Vercel shows the DNS records it needs. In Porkbun: **Domain Management > ourhomehub.nl > DNS**, delete Porkbun's default parking records (the `ALIAS`/`CNAME` pointing at `pixie.porkbun.com`), then add what Vercel lists. Usually that's:

   | Type  | Host  | Answer                 |
   |-------|-------|------------------------|
   | A     | (blank) | `76.76.21.21`        |
   | CNAME | `www` | `cname.vercel-dns.com` |

   If Vercel shows different values for your project, use Vercel's.
3. Wait for Vercel to show both domains as valid (usually minutes, at most a few hours). It issues the HTTPS certificate automatically.

### 6. Install on your phones

- **iPhone:** open `https://ourhomehub.nl` in Safari, tap Share, then **Add to Home Screen**.
- **Android:** open it in Chrome, tap the menu, then **Install app**.

The first person signs in and taps **Start a household**. The second signs in, taps **Join with a code** and enters the code from the **Household** tab.

---

## How the predictions work

1. Ticking off a line on a shopping list records a purchase. Unticking removes it again.
2. Purchases on the same day count as one **shopping day** (in the household's timezone).
3. Once an item has **3 or more shopping days**, the engine takes the **median gap** between them as its rhythm, plus a confidence score from how even the gaps are and how much history there is.
4. When `median gap x timing factor` has passed since the last purchase (the factor starts at **0.85**, so a little before you run out) and confidence is at least **0.45**, the item is added to the default shopping list as a suggestion.
5. Feedback tunes the timing factor per item, using the last 8 signals:
   - **Not now** on a suggestion: +0.08, comes later next time, and isn't re-suggested for at least a quarter of its gap.
   - **Bought by hand before it was suggested:** -0.05, comes sooner next time.
   - **Ticked off a suggestion:** timing confirmed, no change.
6. The engine runs nightly at 04:15 UTC (pg_cron) and also whenever a shopping list is opened.

Everything is in plain SQL in `20261112000200_engine_and_rpcs.sql`, and `item_patterns` shows exactly what was learned. The **Rhythms** tab shows the same information in the app.

---

## Security

- **Allowlist:** only emails in `app_allowlist` can create or join a household, and every data access re-checks it, so removing an email or letting its `expires_at` pass revokes access immediately. Enforced in the database, not just the UI.
- **Row Level Security** on every table: you can only ever read or change your own household's rows.
- **Engine-owned tables** (`purchase_events`, `item_patterns`, `suggestion_feedback`) are read-only from the browser. Only triggers and server-side functions write them.
- **Function permissions** are revoked by default; the browser can call only the RPCs it needs. Internal engine functions can't be called from the app.
- The anon key in the browser is safe by design: without a valid session and RLS approval it can't read anything.
- Turn on two-factor authentication on your Supabase, Vercel, Google and GitHub accounts.

---

## Tests

```bash
npm test          # all tests
npm run test:sql  # database only
npm run typecheck
```

The database tests apply the real migrations to PGlite (Postgres in WebAssembly) with a small stand-in for Supabase's `auth` schema. They cover the allowlist, onboarding, isolation between households, duplicate handling, purchase recording and the prediction engine end to end.

---

## Roadmap

- **Phase 2:** two-way Google Calendar sync (see the Phase 1 architecture doc).
- Quantity-aware rhythms (two packs last twice as long).
- Offline support with a service worker.
- Device vault (manuals, warranties, insurance) and the FinAnél finance merge.
