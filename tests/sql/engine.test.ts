/**
 * Database tests for the Household Hub migrations.
 *
 * Runs the real migration SQL inside PGlite (Postgres compiled to WASM), with
 * small stand-ins for the parts of Supabase that PGlite does not have: the
 * `auth` schema, `auth.uid()` / `auth.jwt()` and the API roles.
 *
 * Covers: allowlist, onboarding, Row Level Security between households,
 * add_entry de-duplication, purchase recording, and the prediction engine
 * (suggest, accept, dismiss, irregular items, items still being learned).
 */
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

// -----------------------------------------------------------------------------
// Step 1: test harness
// -----------------------------------------------------------------------------

const MIGRATIONS_DIR = path.resolve(__dirname, "../../supabase/migrations");

/** Minimal Supabase look-alike so the migrations run unchanged. */
const SUPABASE_STUB = `
  create role anon nologin;
  create role authenticated nologin;
  create role service_role nologin;

  create schema auth;
  create table auth.users (id uuid primary key, email text);

  -- Same contract as Supabase: identity comes from request.jwt.* settings.
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create function auth.jwt() returns jsonb language sql stable as $$
    select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
  $$;

  grant usage on schema auth to anon, authenticated, service_role;
  grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;
  grant usage on schema public to anon, authenticated, service_role;

  -- Supabase Vault look-alike: same function signatures, no real encryption.
  create schema vault;
  create table vault.secrets (
    id uuid primary key default gen_random_uuid(),
    name text, secret text, description text
  );
  create function vault.create_secret(new_secret text, new_name text default null, new_description text default '')
  returns uuid language sql as $$
    insert into vault.secrets (secret, name, description) values (new_secret, new_name, new_description) returning id
  $$;
  create function vault.update_secret(secret_id uuid, new_secret text default null)
  returns void language sql as $$
    update vault.secrets set secret = coalesce(new_secret, secret) where id = secret_id
  $$;
  create view vault.decrypted_secrets as select id, name, secret as decrypted_secret from vault.secrets;

  -- Realtime publication that the migrations add tables to.
  create publication supabase_realtime;
`;

/**
 * Supabase's default table grants; RLS is what actually restricts access.
 * Set as default privileges BEFORE the migrations run (as on Supabase), so a
 * migration that narrows a grant (e.g. hiding households.invite_code from
 * the browser) is tested exactly as it behaves in production.
 */
const SUPABASE_GRANTS = `
  alter default privileges in schema public
    grant select, insert, update, delete on tables to anon, authenticated, service_role;
`;

const USERS = {
  dewald: { id: "11111111-1111-4111-8111-111111111111", email: "dewald@example.com" },
  partner: { id: "22222222-2222-4222-8222-222222222222", email: "partner@example.com" },
  stranger: { id: "33333333-3333-4333-8333-333333333333", email: "stranger@example.com" },
  outsider: { id: "44444444-4444-4444-8444-444444444444", email: "outsider@example.com" },
  aupair: { id: "55555555-5555-4555-8555-555555555555", email: "aupair@example.com" },
  kid: { id: "66666666-6666-4666-8666-666666666666", email: "kid@example.com" },
  // A wall tablet's own sign-in: not on the allowlist, no member row.
  board: { id: "77777777-7777-4777-8777-777777777777", email: "board-1@board.ourhomehub.nl" },
} as const;

type UserKey = keyof typeof USERS;

let db: PGlite;

/** Run the following statements as a signed-in user (RLS applies). */
async function actAs(user: UserKey) {
  const { id, email } = USERS[user];
  await db.exec(`
    reset role;
    select set_config('request.jwt.claim.sub', '${id}', false);
    select set_config('request.jwt.claims', '${JSON.stringify({ sub: id, email })}', false);
    set role authenticated;
  `);
}

/** Back to the superuser (bypasses RLS) for seeding and inspection. */
async function actAsAdmin() {
  await db.exec(`reset role;`);
}

async function one<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await db.query<T>(sql, params);
  return result.rows[0];
}

async function all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query<T>(sql, params)).rows;
}

/** Insert past purchases for an item, `daysAgo` measured from now. */
async function seedPurchases(itemId: string, householdId: string, daysAgo: number[]) {
  await actAsAdmin();
  for (const d of daysAgo) {
    await db.query(
      `insert into public.purchase_events (household_id, item_id, purchased_at)
       values ($1, $2, now() - make_interval(days => $3))`,
      [householdId, itemId, d],
    );
  }
  await db.query(`select public.compute_item_pattern($1)`, [itemId]);
}

// Shared state built up by the onboarding tests.
let householdId: string;
let groceriesListId: string;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);

  // Apply the schema and engine migrations. The realtime/cron migration needs
  // Supabase platform features and is not part of this test.
  const files = [
    "20261112000100_core_schema.sql",
    "20261112000200_engine_and_rpcs.sql",
    "20261112000400_allowlist_expiry.sql",
    "20261112000500_pin_function_search_paths.sql",
    "20261112000600_calendar.sql",
    "20261113000700_today_routines_roles.sql",
    "20261113000800_member_themes.sql",
    "20261113000900_notifications.sql",
    "20261113001000_bin_days.sql",
    "20261113001100_bins_morning.sql",
    "20261113001200_grocery_budget.sql",
    "20261113001300_stars_rewards.sql",
    "20261113001400_weekly_review.sql",
    "20261113001500_supplies.sql",
    "20261113001600_done_for.sql",
    "20261114000100_trips.sql",
    "20261114000200_trip_packing_budget.sql",
    "20261114000300_trip_documents_ids.sql",
    "20261114000400_member_ids_details.sql",
    "20261114000500_family_board.sql",
    "20261114000600_smartthings.sql",
    "20261114000700_member_ids_rijbewijs.sql",
  ];
  await db.exec(SUPABASE_GRANTS);
  for (const file of files) {
    let sql = readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    // The notifications job needs pg_net, pg_cron and pgcrypto, which PGlite
    // doesn't have: run everything except creating the secret and the jobs.
    if (file.includes("notifications")) {
      sql = sql
        .replace(/create extension if not exists pg_net[\s\S]*?(?=create or replace function public\.notify_check_secret)/, "")
        .replace(/-- 5b\.[\s\S]*?(?=-- -{10,}\n-- STEP 6)/, "");
    }
    // Supabase Storage (buckets, storage.objects policies) doesn't exist in
    // PGlite: skip blocks marked [storage:start] ... [storage:end].
    sql = sql.replace(/-- \[storage:start\][\s\S]*?-- \[storage:end\][^\n]*\n/g, "");
    await db.exec(sql);
  }

  for (const u of Object.values(USERS)) {
    await db.query(`insert into auth.users (id, email) values ($1, $2)`, [u.id, u.email]);
  }
  // Everyone except "outsider" is allowlisted.
  await db.exec(`
    insert into public.app_allowlist (email) values
      ('dewald@example.com'), ('partner@example.com'), ('stranger@example.com');
    insert into public.app_allowlist (email, expires_at) values
      ('aupair@example.com', now() + interval '30 days');
    insert into public.app_allowlist (email, role) values ('kid@example.com', 'child');
  `);
});

// -----------------------------------------------------------------------------
// Step 2: item name normalisation
// -----------------------------------------------------------------------------

describe("normalize_item_name", () => {
  it.each([
    ["  Coffee   Beans ", "coffee bean"],
    ["Eggs", "egg"],
    ["Berries", "berry"],
    ["Cookies", "cookie"],
    ["Tomatoes", "tomato"],
    ["Sandwiches", "sandwich"],
    ["Hummus", "hummus"],
    ["Toilet paper", "toilet paper"],
    ["Glasses", "glass"],
  ])("%s -> %s", async (input, expected) => {
    const row = await one<{ n: string }>(`select public.normalize_item_name($1) as n`, [input]);
    expect(row.n).toBe(expected);
  });
});

// -----------------------------------------------------------------------------
// Step 3: onboarding, allowlist and RLS
// -----------------------------------------------------------------------------

describe("onboarding and access control", () => {
  it("rejects a Google account that is not on the allowlist", async () => {
    await actAs("outsider");
    await expect(db.query(`select public.create_household('Hack', 'Eve')`)).rejects.toThrow(
      /email_not_allowed/,
    );
  });

  it("creates a household with Groceries and To-do lists", async () => {
    await actAs("dewald");
    householdId = (await one<{ id: string }>(`select public.create_household('Home', 'Dewald') as id`)).id;

    const lists = await all<{ name: string; type: string; is_default: boolean; id: string }>(
      `select id, name, type, is_default from public.lists order by sort_order`,
    );
    expect(lists.map((l) => [l.name, l.type, l.is_default])).toEqual([
      ["Groceries", "shopping", true],
      ["To-do", "todo", false],
    ]);
    groceriesListId = lists[0].id;
  });

  it("refuses a second household for the same person", async () => {
    await actAs("dewald");
    await expect(db.query(`select public.create_household('Again', 'Dewald')`)).rejects.toThrow(
      /already_in_household/,
    );
  });

  it("lets the partner join with the invite code, in any case", async () => {
    await actAsAdmin();
    const { invite_code } = await one<{ invite_code: string }>(
      `select invite_code from public.households where id = $1`,
      [householdId],
    );

    await actAs("partner");
    await expect(db.query(`select public.join_household('NOPE00', 'Partner')`)).rejects.toThrow(
      /invite_code_not_found/,
    );
    const joined = await one<{ id: string }>(`select public.join_household($1, 'Partner') as id`, [
      ` ${invite_code.toLowerCase()} `,
    ]);
    expect(joined.id).toBe(householdId);

    const members = await all(`select display_name from public.members`);
    expect(members).toHaveLength(2);
  });

  it("keeps a different household completely separate", async () => {
    await actAs("stranger");
    await one(`select public.create_household('Elsewhere', 'Stranger')`);

    // Sees only their own lists.
    const lists = await all<{ name: string }>(`select name from public.lists`);
    expect(lists.every((l) => ["Groceries", "To-do"].includes(l.name))).toBe(true);
    const visibleHouseholds = await all(`select id from public.households`);
    expect(visibleHouseholds).toHaveLength(1);

    // Cannot add to, or insert into, someone else's list.
    await expect(
      db.query(`select public.add_entry($1, 'Sneaky item')`, [groceriesListId]),
    ).rejects.toThrow(/list_not_found/);
    await expect(
      db.query(`insert into public.list_entries (list_id, text) values ($1, 'Sneaky')`, [groceriesListId]),
    ).rejects.toThrow();

    // Cannot read engine tables or the allowlist of others.
    expect(await all(`select * from public.app_allowlist`)).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Step 4: adding and ticking off lines
// -----------------------------------------------------------------------------

describe("lists", () => {
  it("de-duplicates the same item and learns its category", async () => {
    await actAs("dewald");
    const first = await one<{ id: string }>(`select public.add_entry($1, 'Coffee beans') as id`, [
      groceriesListId,
    ]);
    const second = await one<{ id: string }>(
      `select public.add_entry($1, ' coffee  bean ', '2 bags', 'Pantry') as id`,
      [groceriesListId],
    );
    expect(second.id).toBe(first.id);

    const entry = await one<{ quantity: string; category: string }>(
      `select e.quantity, i.category from public.list_entries e join public.items i on i.id = e.item_id where e.id = $1`,
      [first.id],
    );
    expect(entry).toEqual({ quantity: "2 bags", category: "Pantry" });
  });

  it("records a purchase on tick and removes it on untick", async () => {
    await actAs("partner");
    const { id } = await one<{ id: string }>(`select public.add_entry($1, 'Milk') as id`, [groceriesListId]);

    await db.query(`update public.list_entries set status = 'done' where id = $1`, [id]);
    let purchases = await all(`select * from public.purchase_events where list_entry_id = $1`, [id]);
    expect(purchases).toHaveLength(1);

    const pattern = await one<{ purchase_count: number; median_interval_days: string | null }>(
      `select p.purchase_count, p.median_interval_days from public.item_patterns p
       join public.list_entries e on e.item_id = p.item_id where e.id = $1`,
      [id],
    );
    expect(pattern.purchase_count).toBe(1);
    expect(pattern.median_interval_days).toBeNull(); // still learning

    await db.query(`update public.list_entries set status = 'open' where id = $1`, [id]);
    purchases = await all(`select * from public.purchase_events where list_entry_id = $1`, [id]);
    expect(purchases).toHaveLength(0);
  });

  it("browser cannot write purchase history directly", async () => {
    await actAs("dewald");
    const { item_id } = await one<{ item_id: string }>(
      `select item_id from public.list_entries where text = 'Coffee beans'`,
    );
    await expect(
      db.query(`insert into public.purchase_events (household_id, item_id) values ($1, $2)`, [
        householdId,
        item_id,
      ]),
    ).rejects.toThrow();
  });
});

// -----------------------------------------------------------------------------
// Step 5: the prediction engine
// -----------------------------------------------------------------------------

describe("prediction engine", () => {
  let toiletPaperId: string;

  /** Create (or find) an item in Dewald's household and return its id. */
  async function itemFor(name: string, category = "Household") {
    await actAsAdmin();
    const row = await one<{ id: string }>(
      `insert into public.items (household_id, canonical_name, display_name, category)
       values ($1, public.normalize_item_name($2), $2, $3)
       on conflict (household_id, canonical_name) do update set display_name = excluded.display_name
       returning id`,
      [householdId, name, category],
    );
    return row.id;
  }

  it("learns a weekly rhythm and suggests the item when it is due", async () => {
    toiletPaperId = await itemFor("Toilet paper");
    // Bought every 7 days, last time 9 days ago -> due after ~6 days.
    await seedPurchases(toiletPaperId, householdId, [30, 23, 16, 9]);

    const pattern = await one<{ median_interval_days: string; confidence: string; next_expected_at: Date }>(
      `select median_interval_days, confidence, next_expected_at from public.item_patterns where item_id = $1`,
      [toiletPaperId],
    );
    expect(Number(pattern.median_interval_days)).toBe(7);
    expect(Number(pattern.confidence)).toBeGreaterThan(0.85);
    expect(pattern.next_expected_at.getTime()).toBeLessThan(Date.now());

    await actAs("dewald");
    const added = await one<{ n: number }>(`select public.refresh_suggestions() as n`);
    expect(added.n).toBe(1);

    const suggestion = await one<{ text: string; source: string; list_id: string }>(
      `select text, source, list_id from public.list_entries where item_id = $1 and status = 'open'`,
      [toiletPaperId],
    );
    expect(suggestion).toEqual({ text: "Toilet paper", source: "suggested", list_id: groceriesListId });

    // Running again does not add a duplicate.
    expect((await one<{ n: number }>(`select public.refresh_suggestions() as n`)).n).toBe(0);
  });

  it("'Not now' waits longer and does not re-suggest straight away", async () => {
    await actAs("partner");
    await db.query(
      `update public.list_entries set status = 'dismissed' where item_id = $1 and status = 'open'`,
      [toiletPaperId],
    );

    const pattern = await one<{ threshold_factor: string }>(
      `select threshold_factor from public.item_patterns where item_id = $1`,
      [toiletPaperId],
    );
    expect(Number(pattern.threshold_factor)).toBeCloseTo(0.93, 2);

    const fb = await all<{ outcome: string }>(
      `select outcome from public.suggestion_feedback where item_id = $1`,
      [toiletPaperId],
    );
    expect(fb.map((f) => f.outcome)).toEqual(["dismissed"]);

    expect((await one<{ n: number }>(`select public.refresh_suggestions() as n`)).n).toBe(0);
  });

  it("ticking a suggestion counts as accepted and resets the clock", async () => {
    const coffeeId = await itemFor("Coffee beans", "Pantry");
    await seedPurchases(coffeeId, householdId, [40, 30, 20, 11]);

    // Coffee is already open on the list from the earlier test as a manual
    // line, so clear that first to let the engine suggest it.
    await actAsAdmin();
    await db.query(`update public.list_entries set status = 'cleared' where item_id = $1`, [coffeeId]);

    await actAs("dewald");
    expect((await one<{ n: number }>(`select public.refresh_suggestions() as n`)).n).toBe(1);

    const { id } = await one<{ id: string }>(
      `select id from public.list_entries where item_id = $1 and status = 'open'`,
      [coffeeId],
    );
    await db.query(`update public.list_entries set status = 'done' where id = $1`, [id]);

    const fb = await one<{ outcome: string; days_since_last_purchase: string }>(
      `select outcome, days_since_last_purchase from public.suggestion_feedback where list_entry_id = $1`,
      [id],
    );
    expect(fb.outcome).toBe("accepted");
    expect(Number(fb.days_since_last_purchase)).toBeCloseTo(11, 0);

    const pattern = await one<{ purchase_count: number; next_expected_at: Date }>(
      `select purchase_count, next_expected_at from public.item_patterns where item_id = $1`,
      [coffeeId],
    );
    expect(pattern.purchase_count).toBe(5);
    expect(pattern.next_expected_at.getTime()).toBeGreaterThan(Date.now());
    expect((await one<{ n: number }>(`select public.refresh_suggestions() as n`)).n).toBe(0);
  });

  it("buying by hand before it was due makes the item come sooner", async () => {
    const breadId = await itemFor("Bread", "Bakery");
    // Every 4 days, last 1 day ago -> not due yet.
    await seedPurchases(breadId, householdId, [13, 9, 5, 1]);

    await actAs("dewald");
    const { id } = await one<{ id: string }>(`select public.add_entry($1, 'Bread') as id`, [groceriesListId]);
    await db.query(`update public.list_entries set status = 'done' where id = $1`, [id]);

    const fb = await one<{ outcome: string }>(
      `select outcome from public.suggestion_feedback where list_entry_id = $1`,
      [id],
    );
    expect(fb.outcome).toBe("bought_early");
    const pattern = await one<{ threshold_factor: string }>(
      `select threshold_factor from public.item_patterns where item_id = $1`,
      [breadId],
    );
    expect(Number(pattern.threshold_factor)).toBeCloseTo(0.8, 2);
  });

  it("does not suggest items bought at irregular intervals", async () => {
    const candlesId = await itemFor("Candles");
    await seedPurchases(candlesId, householdId, [60, 59, 30, 28]); // gaps 1, 29, 2

    const pattern = await one<{ confidence: string }>(
      `select confidence from public.item_patterns where item_id = $1`,
      [candlesId],
    );
    expect(Number(pattern.confidence)).toBeLessThan(0.45);

    await actAs("dewald");
    await one(`select public.refresh_suggestions()`);
    const open = await all(`select id from public.list_entries where item_id = $1 and status = 'open'`, [
      candlesId,
    ]);
    expect(open).toHaveLength(0);
  });

  it("keeps learning items with fewer than 3 shopping days", async () => {
    const lemonsId = await itemFor("Lemons", "Produce");
    // Two purchases on the same day count as one shopping day.
    await seedPurchases(lemonsId, householdId, [10, 10, 3]);
    const pattern = await one<{ purchase_count: number; next_expected_at: Date | null }>(
      `select purchase_count, next_expected_at from public.item_patterns where item_id = $1`,
      [lemonsId],
    );
    expect(pattern.purchase_count).toBe(2);
    expect(pattern.next_expected_at).toBeNull();
  });

  it("the nightly job runs for every household without a signed-in user", async () => {
    await actAsAdmin();
    await db.exec(`
      select set_config('request.jwt.claim.sub', '', false);
      select set_config('request.jwt.claims', '', false);
    `);
    const { n } = await one<{ n: number }>(`select public.run_all_predictions() as n`);
    expect(n).toBeGreaterThanOrEqual(0);
  });

  it("signed-in users cannot call the internal engine functions", async () => {
    await actAs("dewald");
    await expect(db.query(`select public.run_all_predictions()`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select public.compute_item_pattern($1)`, [toiletPaperId])).rejects.toThrow(
      /permission denied/,
    );
  });
});

// -----------------------------------------------------------------------------
// Step 6: time-limited access (au pair)
// -----------------------------------------------------------------------------

describe("time-limited access", () => {
  it("lets a time-limited member join and use the lists before the end date", async () => {
    await actAsAdmin();
    const { invite_code } = await one<{ invite_code: string }>(
      `select invite_code from public.households where id = $1`,
      [householdId],
    );
    await actAs("aupair");
    await one(`select public.join_household($1, 'Jana')`, [invite_code]);
    const lists = await all(`select id from public.lists`);
    expect(lists.length).toBeGreaterThan(0);
    await one(`select public.add_entry($1, 'Nappies')`, [groceriesListId]);
  });

  it("cuts off all household data once the end date passes, keeping what they added", async () => {
    await actAsAdmin();
    await db.exec(`update public.app_allowlist set expires_at = now() - interval '1 minute'
                   where email = 'aupair@example.com'`);

    await actAs("aupair");
    expect(await all(`select id from public.lists`)).toHaveLength(0);
    expect(await all(`select id from public.list_entries`)).toHaveLength(0);
    expect(await all(`select id from public.members`)).toHaveLength(0);
    expect((await one<{ ok: boolean }>(`select public.is_email_allowed() as ok`)).ok).toBe(false);
    await expect(db.query(`select public.add_entry($1, 'More nappies')`, [groceriesListId])).rejects.toThrow(
      /not_in_household/,
    );

    // The rest of the household still sees the line they added.
    await actAs("dewald");
    const kept = await all(`select id from public.list_entries where text = 'Nappies'`);
    expect(kept).toHaveLength(1);
  });

  it("removing someone from the allowlist revokes access straight away", async () => {
    await actAsAdmin();
    await db.exec(`delete from public.app_allowlist where email = 'stranger@example.com'`);
    await actAs("stranger");
    expect(await all(`select id from public.lists`)).toHaveLength(0);
    await actAsAdmin();
    await db.exec(`insert into public.app_allowlist (email) values ('stranger@example.com')`);
  });
});

// -----------------------------------------------------------------------------
// Step 7: Phase 2, shared Google Calendar
// -----------------------------------------------------------------------------

describe("calendar: roles, connection and events", () => {
  /** Run statements as the server (service-role key). */
  async function actAsServer() {
    await db.exec(`reset role; set role service_role;`);
  }

  it("makes the household creator the owner and everyone else a member", async () => {
    await actAs("dewald");
    expect((await one<{ ok: boolean }>(`select public.is_household_owner() as ok`)).ok).toBe(true);
    await actAs("partner");
    expect((await one<{ ok: boolean }>(`select public.is_household_owner() as ok`)).ok).toBe(false);
  });

  it("stops members promoting themselves", async () => {
    await actAs("partner");
    await expect(
      db.query(`update public.members set role = 'owner' where user_id = $1`, [USERS.partner.id]),
    ).rejects.toThrow(/role_change_not_allowed/);
    // Changing their own name still works.
    await db.query(`update public.members set display_name = 'Anél' where user_id = $1`, [USERS.partner.id]);
  });

  it("stores the refresh token in Vault, readable only by the server", async () => {
    await actAsServer();
    await db.query(`select public.calendar_save_connection($1, 'Family@Example.com', 'family@example.com', 'refresh-1', null)`, [
      householdId,
    ]);
    const token = await one<{ t: string }>(`select public.calendar_get_refresh_token($1) as t`, [householdId]);
    expect(token.t).toBe("refresh-1");

    // Reconnecting replaces the token in the same Vault secret.
    await db.query(`select public.calendar_save_connection($1, 'family@example.com', 'family@example.com', 'refresh-2', null)`, [
      householdId,
    ]);
    await actAsAdmin();
    const secrets = await all<{ secret: string }>(`select secret from vault.secrets`);
    expect(secrets.map((s) => s.secret)).toEqual(["refresh-2"]);
  });

  it("shows members a safe status, never the token", async () => {
    await actAs("partner");
    const status = await one<{ connected: boolean; google_email: string }>(
      `select * from public.calendar_connection_status()`,
    );
    expect(status).toMatchObject({ connected: true, google_email: "family@example.com" });
    expect(await all(`select * from public.calendar_connections`)).toHaveLength(0);
    await expect(db.query(`select public.calendar_get_refresh_token($1)`, [householdId])).rejects.toThrow(
      /permission denied/,
    );

    // Another household sees no connection at all.
    await actAs("stranger");
    expect(await all(`select * from public.calendar_connection_status()`)).toHaveLength(0);
  });

  it("lets members read synced events but not write them directly", async () => {
    await actAsAdmin();
    await db.query(
      `insert into public.calendar_events (household_id, google_event_id, title, start_at, end_at)
       values ($1, 'g1', 'Swimming lessons', now() + interval '1 day', now() + interval '1 day 1 hour')`,
      [householdId],
    );

    await actAs("partner");
    const rows = await all<{ title: string }>(`select title from public.calendar_events`);
    expect(rows.map((r) => r.title)).toEqual(["Swimming lessons"]);
    await expect(
      db.query(`insert into public.calendar_events (household_id, google_event_id, title) values ($1, 'x', 'Sneaky')`, [
        householdId,
      ]),
    ).rejects.toThrow();

    await actAs("stranger");
    expect(await all(`select * from public.calendar_events`)).toHaveLength(0);
  });

  it("disconnecting removes the connection, its secret and the synced events", async () => {
    await actAsServer();
    await db.query(`select public.calendar_remove_connection($1)`, [householdId]);
    await actAsAdmin();
    expect(await all(`select * from public.calendar_connections`)).toHaveLength(0);
    expect(await all(`select * from public.calendar_events where household_id = $1`, [householdId])).toHaveLength(0);
    expect(await all(`select * from vault.secrets`)).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// Step 8: Phase 3, roles, kids, day modes, routines, zones, chores
// -----------------------------------------------------------------------------

describe("phase 3: roles and the child account", () => {
  let todoListId: string;
  let kidMemberId: string;

  it("turns existing members into adults and lets a listed child join as a child", async () => {
    await actAsAdmin();
    const roles = await all<{ display_name: string; role: string }>(
      `select display_name, role from public.members where household_id = $1 order by created_at`,
      [householdId],
    );
    expect(roles.map((r) => r.role)).toEqual(["owner", "adult", "adult"]);

    const { invite_code } = await one<{ invite_code: string }>(
      `select invite_code from public.households where id = $1`,
      [householdId],
    );
    await actAs("kid");
    await one(`select public.join_household($1, 'Shannon')`, [invite_code]);
    const me = await one<{ role: string; id: string }>(
      `select id, role from public.members where user_id = $1`,
      [USERS.kid.id],
    );
    expect(me.role).toBe("child");
    kidMemberId = me.id;
    expect((await one<{ ok: boolean }>(`select public.is_household_adult() as ok`)).ok).toBe(false);
  });

  it("hides the invite code from children but not from adults", async () => {
    await actAs("kid");
    await expect(db.query(`select invite_code from public.households`)).rejects.toThrow(/permission denied/);
    await expect(db.query(`select public.household_invite_code()`)).rejects.toThrow(/adults_only/);
    await expect(db.query(`select public.regenerate_invite_code()`)).rejects.toThrow(/adults_only/);
    // The rest of the household row is readable.
    const h = await one<{ name: string; school_region: string }>(`select name, school_region from public.households`);
    expect(h).toEqual({ name: "Home", school_region: "zuid" });

    await actAs("partner");
    const code = await one<{ c: string }>(`select public.household_invite_code() as c`);
    expect(code.c).toMatch(/^[A-Z2-9]{6}$/);
  });

  it("lets adults add dated, assigned to-dos; children can't add or rename anything", async () => {
    await actAs("dewald");
    todoListId = (await one<{ id: string }>(`select id from public.lists where type = 'todo'`)).id;
    await one(`select public.add_entry($1, 'Tidy your room', null, null, current_date, $2)`, [todoListId, kidMemberId]);
    await one(`select public.add_entry($1, 'Book the dentist')`, [todoListId]);

    await actAs("kid");
    await expect(db.query(`select public.add_entry($1, 'Sweets')`, [groceriesListId])).rejects.toThrow(/adults_only/);
    await expect(
      db.query(`insert into public.list_entries (list_id, text) values ($1, 'Sneaky')`, [todoListId]),
    ).rejects.toThrow();
    await db.query(`update public.households set name = 'Kid castle'`);
    await db.query(`update public.lists set name = 'Mine'`);
    await actAsAdmin();
    expect((await one<{ name: string }>(`select name from public.households where id = $1`, [householdId])).name).toBe("Home");
    expect(await all(`select 1 from public.lists where name = 'Mine'`)).toHaveLength(0);
  });

  it("lets a child tick only their own to-do, and only tick it", async () => {
    await actAs("kid");
    // Someone else's (unassigned) line: RLS hides it from the update.
    await db.query(`update public.list_entries set status = 'done' where text = 'Book the dentist'`);
    // Their own line: ticking works...
    await db.query(`update public.list_entries set status = 'done' where text = 'Tidy your room'`);
    // ...but changing anything else does not.
    await expect(
      db.query(`update public.list_entries set text = 'Never' where text = 'Tidy your room'`),
    ).rejects.toThrow(/children_can_only_tick/);
    await expect(
      db.query(`update public.list_entries set assigned_to = null where text = 'Tidy your room'`),
    ).rejects.toThrow();

    await actAsAdmin();
    const rows = await all<{ text: string; status: string }>(
      `select text, status from public.list_entries where list_id = $1 order by text`,
      [todoListId],
    );
    expect(rows).toEqual([
      { text: "Book the dentist", status: "open" },
      { text: "Tidy your room", status: "done" },
    ]);
  });

  it("refuses an assignee from another household", async () => {
    await actAsAdmin();
    const strangerMember = (await one<{ id: string }>(`select id from public.members where user_id = $1`, [USERS.stranger.id])).id;
    await actAs("dewald");
    await expect(
      db.query(`select public.add_entry($1, 'Odd', null, null, null, $2)`, [todoListId, strangerMember]),
    ).rejects.toThrow(/member_not_in_household/);
  });
});

describe("phase 3: school days, holidays and weekends", () => {
  it("works out each day's mode, with your own school day winning", async () => {
    await actAs("dewald");
    await db.query(
      `insert into public.day_overrides (household_id, start_date, end_date, kind, name, source, external_key) values
         ($1, '2026-10-17', '2026-10-25', 'holiday', 'Autumn holiday', 'rijksoverheid', 'zuid-2026-herfst'),
         ($1, '2026-12-25', '2026-12-25', 'public_holiday', 'Christmas Day', 'computed', 'ph-2026-12-25'),
         ($1, '2026-11-20', '2026-11-20', 'day_off', 'Study day', 'manual', null),
         ($1, '2026-10-23', '2026-10-23', 'school_day', 'Catch-up day', 'manual', null)`,
      [householdId],
    );
    const mode = async (d: string) =>
      (await one<{ m: string }>(`select public.day_mode($1, $2::date) as m`, [householdId, d])).m;

    await actAsAdmin(); // day_mode is server-only; the browser uses day_info
    expect(await mode("2026-11-17")).toBe("school"); // a Tuesday
    expect(await mode("2026-11-21")).toBe("weekend");
    expect(await mode("2026-10-18")).toBe("holiday"); // Sunday inside the holiday
    expect(await mode("2026-10-21")).toBe("holiday");
    expect(await mode("2026-10-23")).toBe("school"); // override
    expect(await mode("2026-11-20")).toBe("holiday"); // study day
    expect(await mode("2026-12-25")).toBe("holiday");
  });

  it("gives Today the holiday name and its dates", async () => {
    await actAs("kid");
    const info = await one<{ mode: string; label: string; period_start: string }>(
      `select mode, label, period_start::text from public.day_info('2026-10-21')`,
    );
    expect(info).toEqual({ mode: "holiday", label: "Autumn holiday", period_start: "2026-10-17" });
    const plain = await one<{ mode: string; label: string | null }>(`select mode, label from public.day_info('2026-11-17')`);
    expect(plain).toEqual({ mode: "school", label: null });
  });

  it("only adults change holidays; other households see none", async () => {
    await actAs("kid");
    await expect(
      db.query(
        `insert into public.day_overrides (household_id, start_date, end_date, kind, name) values ($1, '2026-11-18', '2026-11-18', 'day_off', 'Skip')`,
        [householdId],
      ),
    ).rejects.toThrow();
    await actAs("stranger");
    expect(await all(`select id from public.day_overrides`)).toHaveLength(0);
  });
});

describe("phase 3: routines, zones and chores", () => {
  let kidMemberId: string;
  let householdStepId: string;
  let kidStepId: string;
  let zoneTaskId: string;
  let choreId: string;

  it("lets adults build routines; children can't", async () => {
    await actAsAdmin();
    kidMemberId = (await one<{ id: string }>(`select id from public.members where user_id = $1`, [USERS.kid.id])).id;

    await actAs("partner");
    const morning = await one<{ id: string }>(
      `insert into public.routines (household_id, name) values ($1, 'Morning') returning id`,
      [householdId],
    );
    householdStepId = (
      await one<{ id: string }>(
        `insert into public.routine_steps (routine_id, title, weekdays, modes) values ($1, 'Pack sports kit', '{1}', '{school}') returning id`,
        [morning.id],
      )
    ).id;
    const kids = await one<{ id: string }>(
      `insert into public.routines (household_id, name, owner_member) values ($1, 'Shannon morning', $2) returning id`,
      [householdId, kidMemberId],
    );
    kidStepId = (
      await one<{ id: string }>(`insert into public.routine_steps (routine_id, title) values ($1, 'Brush teeth') returning id`, [kids.id])
    ).id;

    await actAs("kid");
    await expect(
      db.query(`insert into public.routines (household_id, name) values ($1, 'Mine')`, [householdId]),
    ).rejects.toThrow();
    const steps = await all(`select id from public.routine_steps`);
    expect(steps).toHaveLength(2);
  });

  it("lets a child tick steps of their own routine, not household ones", async () => {
    await actAs("kid");
    await db.query(`select public.set_completion('step', $1, '2026-11-16', true)`, [kidStepId]);
    await expect(
      db.query(`select public.set_completion('step', $1, '2026-11-16', true)`, [householdStepId]),
    ).rejects.toThrow(/not_assigned_to_you/);
    // The browser can't write completions directly.
    await expect(
      db.query(
        `insert into public.completions (household_id, kind, item_id, for_date) values ($1, 'step', $2, '2026-11-17')`,
        [householdId, householdStepId],
      ),
    ).rejects.toThrow();

    await actAs("dewald");
    await db.query(`select public.set_completion('step', $1, '2026-11-16', true)`, [householdStepId]);
    // Ticking twice is harmless; unticking removes it.
    await db.query(`select public.set_completion('step', $1, '2026-11-16', true)`, [householdStepId]);
    expect(await all(`select id from public.completions where kind = 'step'`)).toHaveLength(2);
    await db.query(`select public.set_completion('step', $1, '2026-11-16', false)`, [householdStepId]);
    expect(await all(`select id from public.completions where kind = 'step'`)).toHaveLength(1);
  });

  it("counts a zone task once per fortnight from the rotation start", async () => {
    await actAs("dewald");
    await expect(db.query(`update public.households set zone_rotation_start = '2026-11-11'`)).rejects.toThrow(); // not a Monday
    await db.query(`update public.households set zone_rotation_start = '2026-11-02'`);
    const zone = await one<{ id: string }>(`insert into public.zones (household_id, name) values ($1, 'Kitchen') returning id`, [householdId]);
    zoneTaskId = (
      await one<{ id: string }>(`insert into public.zone_tasks (zone_id, title) values ($1, 'Clean the oven') returning id`, [zone.id])
    ).id;

    await db.query(`select public.set_completion('zone_task', $1, '2026-11-12', true)`, [zoneTaskId]);
    const row = await one<{ d: string }>(`select for_date::text as d from public.completions where kind = 'zone_task'`);
    expect(row.d).toBe("2026-11-02");
    // Unticking from another day in the same fortnight finds the same tick.
    await db.query(`select public.set_completion('zone_task', $1, '2026-11-15', false)`, [zoneTaskId]);
    expect(await all(`select id from public.completions where kind = 'zone_task'`)).toHaveLength(0);
  });

  it("moves a chore to its next due date when ticked, and back when unticked", async () => {
    await actAs("dewald");
    choreId = (
      await one<{ id: string }>(
        `insert into public.chores (household_id, title, every_n, unit, next_due, assigned_to)
         values ($1, 'Change bed linen', 2, 'week', '2026-11-13', $2) returning id`,
        [householdId, kidMemberId],
      )
    ).id;

    await actAs("kid");
    await db.query(`select public.set_completion('chore', $1, '2026-11-14', true)`, [choreId]);
    const due = async () => (await one<{ d: string }>(`select next_due::text as d from public.chores where id = $1`, [choreId])).d;
    expect(await due()).toBe("2026-11-28");
    await db.query(`select public.set_completion('chore', $1, '2026-11-14', false)`, [choreId]);
    expect(await due()).toBe("2026-11-13");

    await actAs("dewald");
    await db.query(`update public.chores set unit = 'month', every_n = 1 where id = $1`, [choreId]);
    await db.query(`select public.set_completion('chore', $1, '2026-01-31', true)`, [choreId]);
    expect(await due()).toBe("2026-02-28");
  });

  it("deleting a chore deletes its ticks; strangers can't tick anything here", async () => {
    await actAs("stranger");
    await expect(db.query(`select public.set_completion('chore', $1, '2026-11-14', true)`, [choreId])).rejects.toThrow(
      /item_not_found/,
    );
    await actAs("dewald");
    await db.query(`delete from public.chores where id = $1`, [choreId]);
    expect(await all(`select id from public.completions where kind = 'chore'`)).toHaveLength(0);
  });
});

describe("themes", () => {
  it("lets each person change only their own theme, to a known colour", async () => {
    await actAs("kid");
    await db.query(`update public.members set theme_accent = 'lavender', theme_mode = 'dark' where user_id = $1`, [USERS.kid.id]);
    await expect(
      db.query(`update public.members set theme_accent = 'neon' where user_id = $1`, [USERS.kid.id]),
    ).rejects.toThrow();
    // Someone else's row: RLS hides it, nothing changes.
    await db.query(`update public.members set theme_accent = 'coral' where user_id = $1`, [USERS.dewald.id]);

    await actAsAdmin();
    const rows = await all<{ user_id: string; theme_accent: string; theme_mode: string }>(
      `select user_id, theme_accent, theme_mode from public.members where user_id in ($1, $2) order by created_at`,
      [USERS.dewald.id, USERS.kid.id],
    );
    expect(rows).toEqual([
      { user_id: USERS.dewald.id, theme_accent: "basil", theme_mode: "system" },
      { user_id: USERS.kid.id, theme_accent: "lavender", theme_mode: "dark" },
    ]);
  });
});

describe("notifications", () => {
  /** Run statements as the server (service-role key). */
  async function actAsServer() {
    await db.exec(`reset role; set role service_role;`);
  }

  it("registers a device for the signed-in person and moves it if someone else signs in on it", async () => {
    await actAs("partner");
    await db.query(`select public.save_push_subscription('https://push.example/abc', 'key', 'auth', 'iPhone')`);
    expect(await all(`select endpoint from public.push_subscriptions`)).toHaveLength(1);

    await actAs("kid");
    expect(await all(`select endpoint from public.push_subscriptions`)).toHaveLength(0); // not theirs
    await db.query(`select public.save_push_subscription('https://push.example/abc', 'key2', 'auth2', 'iPhone')`);
    expect(await all(`select endpoint from public.push_subscriptions`)).toHaveLength(1);

    await actAs("partner");
    expect(await all(`select endpoint from public.push_subscriptions`)).toHaveLength(0);
    await expect(
      db.query(`insert into public.push_subscriptions (member_id, household_id, endpoint, p256dh, auth) values (gen_random_uuid(), $1, 'https://x', 'k', 'a')`, [householdId]),
    ).rejects.toThrow();
  });

  it("lets each person keep their own preferences only", async () => {
    await actAs("kid");
    const kidMember = (await one<{ id: string }>(`select public.current_member_id() as id`)).id;
    await db.query(
      `insert into public.notification_prefs (member_id, household_id, routine_nudge, routine_nudge_time) values ($1, $2, true, '07:40')`,
      [kidMember, householdId],
    );
    await actAs("partner");
    expect(await all(`select * from public.notification_prefs`)).toHaveLength(0);
    await expect(
      db.query(`insert into public.notification_prefs (member_id, household_id) values ($1, $2)`, [kidMember, householdId]),
    ).rejects.toThrow();
  });

  it("keeps the send log and the cron secret check server-only", async () => {
    await actAs("dewald");
    await expect(db.query(`select public.notify_check_secret('guess')`)).rejects.toThrow(/permission denied/);
    expect(await all(`select * from public.notification_log`)).toHaveLength(0);
    await actAsServer();
    expect((await one<{ ok: boolean }>(`select public.notify_check_secret('guess') as ok`)).ok).toBe(false);
  });
});

describe("bin days", () => {
  it("lets adults add dates once per bin and date; children only read", async () => {
    await actAs("partner");
    await db.query(`insert into public.bin_days (household_id, kind, date) values ($1, 'plastic', '2026-11-16'), ($1, 'gft', '2026-11-26')`, [householdId]);
    await expect(db.query(`insert into public.bin_days (household_id, kind, date) values ($1, 'plastic', '2026-11-16')`, [householdId])).rejects.toThrow();
    await expect(db.query(`insert into public.bin_days (household_id, kind, date) values ($1, 'compost', '2026-11-17')`, [householdId])).rejects.toThrow();

    await actAs("kid");
    expect(await all(`select id from public.bin_days`)).toHaveLength(2);
    await expect(db.query(`insert into public.bin_days (household_id, kind, date) values ($1, 'paper', '2026-11-27')`, [householdId])).rejects.toThrow();

    await actAs("stranger");
    expect(await all(`select id from public.bin_days`)).toHaveLength(0);
  });
});

describe("grocery budget", () => {
  it("is visible only to members the owner gave access, and only the owner can grant it", async () => {
    await actAsAdmin();
    const partner = (await one<{ id: string }>(`select id from public.members where user_id = $1`, [USERS.partner.id])).id;
    const kid = (await one<{ id: string }>(`select id from public.members where user_id = $1`, [USERS.kid.id])).id;
    await db.query(`insert into public.bunq_connections (household_id, budget_cents) values ($1, 100000)`, [householdId]);
    await db.query(
      `insert into public.bunq_payments (id, household_id, created_at, amount_cents, counterparty, kind) values (1, $1, now(), -4512, 'AH', 'spend')`,
      [householdId],
    );

    // Owner: sees it.
    await actAs("dewald");
    expect(await all(`select id from public.bunq_payments`)).toHaveLength(1);

    // Adult without access: sees nothing, and can't give themselves access.
    await actAs("partner");
    expect(await all(`select id from public.bunq_payments`)).toHaveLength(0);
    expect(await all(`select household_id from public.bunq_connections`)).toHaveLength(0);
    await expect(db.query(`update public.members set can_see_finances = true where id = $1`, [partner])).rejects.toThrow(/owner_only/);
    await expect(db.query(`select public.set_finance_access($1, true)`, [partner])).rejects.toThrow(/owner_only/);

    // The owner grants it: now they see it.
    await actAs("dewald");
    await db.query(`select public.set_finance_access($1, true)`, [partner]);
    await expect(db.query(`select public.set_finance_access($1, true)`, [kid])).rejects.toThrow(/member_not_in_household/);
    await actAs("partner");
    expect(await all(`select id from public.bunq_payments`)).toHaveLength(1);

    // Children: never, and the browser can't read the credentials RPC.
    await actAs("kid");
    expect(await all(`select id from public.bunq_payments`)).toHaveLength(0);
    await expect(db.query(`select public.bunq_get_credentials($1)`, [householdId])).rejects.toThrow(/permission denied/);
  });
});

describe("stars and rewards", () => {
  it("counts a child's own ticks, spends stars on given rewards and keeps a streak", async () => {
    await actAsAdmin();
    const kid = (await one<{ id: string }>(`select id from public.members where user_id = $1`, [USERS.kid.id])).id;
    // Earlier tests left the kid with: one routine step ticked (16 Nov), a
    // ticked to-do of their own, and a chore that was deleted (ticks gone).
    await actAs("kid");
    const before = await one<{ earned: number; spent: number; balance: number }>(
      `select earned, spent, balance from public.member_stars($1, '2026-11-16')`,
      [kid],
    );
    expect(before.earned).toBe(2);

    // A reward, set and given by an adult, spends its stars.
    await expect(
      db.query(`insert into public.rewards (household_id, member_id, title, stars_needed) values ($1, $2, 'Mine', 1)`, [householdId, kid]),
    ).rejects.toThrow();
    await actAs("dewald");
    await db.query(`insert into public.rewards (household_id, member_id, title, stars_needed) values ($1, $2, 'Choose dinner', 2)`, [householdId, kid]);
    await db.query(`update public.rewards set given_at = now() where member_id = $1`, [kid]);
    const after = await one<{ spent: number; balance: number }>(`select spent, balance from public.member_stars($1, '2026-11-16')`, [kid]);
    expect(after).toEqual({ spent: 2, balance: 0 });

    // Streak: the kid's own routine has one every-day step, done on 16 Nov only.
    const streak = await one<{ streak: number }>(`select streak from public.member_stars($1, '2026-11-16')`, [kid]);
    expect(streak.streak).toBe(1);
    // On the 17th (not done yet) today doesn't break it.
    expect((await one<{ streak: number }>(`select streak from public.member_stars($1, '2026-11-17')`, [kid])).streak).toBe(1);
    // By the 18th the missed 17th has ended it.
    expect((await one<{ streak: number }>(`select streak from public.member_stars($1, '2026-11-18')`, [kid])).streak).toBe(0);
  });

  it("only lets children see their own stars", async () => {
    await actAsAdmin();
    const dewald = (await one<{ id: string }>(`select id from public.members where user_id = $1`, [USERS.dewald.id])).id;
    await actAs("kid");
    await expect(db.query(`select * from public.member_stars($1, '2026-11-16')`, [dewald])).rejects.toThrow(/not_assigned_to_you/);
  });
});

describe("weekly review", () => {
  it("counts each person's ticks by the household's own days, for adults only", async () => {
    await actAsAdmin();
    const dewald = (await one<{ id: string }>(`select id from public.members where user_id = $1`, [USERS.dewald.id])).id;
    const kid = (await one<{ id: string }>(`select id from public.members where user_id = $1`, [USERS.kid.id])).id;
    // A week far from the other tests' data (Mon 7 to Sun 13 Jan 2030).
    // 23:30 UTC on the 6th is 00:30 on the 7th in Amsterdam -> counts;
    // 22:30 UTC on the 6th is 23:30 on the 6th in Amsterdam -> doesn't.
    await db.query(
      `insert into public.completions (household_id, kind, item_id, for_date, done_by, done_at) values
         ($1, 'step', gen_random_uuid(), '2030-01-07', $2, '2030-01-06 23:30+00'),
         ($1, 'chore', gen_random_uuid(), '2030-01-09', $2, '2030-01-09 10:00+00'),
         ($1, 'step', gen_random_uuid(), '2030-01-08', $3, '2030-01-08 07:00+00'),
         ($1, 'step', gen_random_uuid(), '2030-01-06', $3, '2030-01-06 22:30+00')`,
      [householdId, dewald, kid],
    );

    await actAs("partner");
    const counts = (await one<{ r: { people: Array<{ member_id: string; steps: number; chores: number }>; shopping_bought: number } }>(
      `select public.weekly_review('2030-01-07', '2030-01-13') as r`,
    )).r;
    const of = (id: string) => counts.people.find((p) => p.member_id === id)!;
    expect(of(dewald)).toMatchObject({ steps: 1, chores: 1 });
    expect(of(kid)).toMatchObject({ steps: 1, chores: 0 });
    expect(counts.shopping_bought).toBe(0);

    // Children can't, nor can a range longer than a month.
    await expect(db.query(`select public.weekly_review('2030-01-01', '2030-03-01')`)).rejects.toThrow(/invalid_range/);
    await actAs("kid");
    await expect(db.query(`select public.weekly_review('2030-01-07', '2030-01-13')`)).rejects.toThrow(/adults_only/);
    // The server-side version takes any household: never from the browser.
    await actAs("dewald");
    await expect(db.query(`select public.week_counts($1, '2030-01-07', '2030-01-13')`, [householdId])).rejects.toThrow(/permission denied/);
    await db.exec(`reset role; set role service_role;`);
    const server = (await one<{ r: { people: unknown[] } }>(`select public.week_counts($1, '2030-01-07', '2030-01-13') as r`, [householdId])).r;
    expect(server.people.length).toBeGreaterThan(0);
  });
});

describe("supplies", () => {
  it("uses up with ticks, suggests once at the threshold and tops up when bought", async () => {
    await actAs("dewald");
    // The product, bought once by hand (2 bottles), and the washing chore.
    const firstLine = (await one<{ id: string }>(`select public.add_entry($1, 'Washing liquid', '2') as id`, [groceriesListId])).id;
    const itemId = (await one<{ item_id: string }>(`select item_id from public.list_entries where id = $1`, [firstLine])).item_id;
    const chore = (
      await one<{ id: string }>(
        `insert into public.chores (household_id, title, every_n, unit, next_due) values ($1, 'Do the washing', 1, 'day', '2030-02-01') returning id`,
        [householdId],
      )
    ).id;
    const supply = (
      await one<{ id: string }>(
        `insert into public.supplies (household_id, item_id, uses_per_pack, uses_left, warn_at) values ($1, $2, 3, 0, 1) returning id`,
        [householdId, itemId],
      )
    ).id;
    await db.query(`insert into public.supply_uses (supply_id, household_id, kind, task_id) values ($1, $2, 'chore', $3)`, [supply, householdId, chore]);
    const left = async () => (await one<{ n: number }>(`select uses_left as n from public.supplies where id = $1`, [supply])).n;
    const openLines = async () =>
      all<{ note: string | null; source: string }>(`select note, source from public.list_entries where item_id = $1 and status = 'open'`, [itemId]);

    // Bought: 2 packs of 3. Unticking takes them off; ticking again adds them back.
    await db.query(`update public.list_entries set status = 'done' where id = $1`, [firstLine]);
    expect(await left()).toBe(6);
    await db.query(`update public.list_entries set status = 'open' where id = $1`, [firstLine]);
    expect(await left()).toBe(0);
    await db.query(`update public.list_entries set status = 'done' where id = $1`, [firstLine]);
    expect(await left()).toBe(6);

    // A tick uses one; unticking gives it back.
    const tick = (day: string, done = true) => db.query(`select public.set_completion('chore', $1, $2, $3)`, [chore, day, done]);
    await tick("2030-02-01");
    expect(await left()).toBe(5);
    await tick("2030-02-01", false);
    expect(await left()).toBe(6);

    // Down to the threshold (1): suggested once, with how much is left.
    for (const day of ["2030-02-01", "2030-02-02", "2030-02-03", "2030-02-04", "2030-02-05"]) await tick(day);
    expect(await left()).toBe(1);
    expect(await openLines()).toEqual([{ note: "About 1 use left", source: "suggested" }]);
    // Running out while it's on the list doesn't add it twice.
    await tick("2030-02-06");
    expect(await left()).toBe(0);
    expect(await openLines()).toHaveLength(1);

    // A product by name: finds the same item, plural or not.
    expect((await one<{ id: string }>(`select public.ensure_item('washing liquids') as id`)).id).toBe(itemId);

    // Children see supplies but can't change them.
    await actAs("kid");
    await expect(db.query(`select public.ensure_item('Softener')`)).rejects.toThrow(/adults_only/);
    expect(await all(`select id from public.supplies`)).toHaveLength(1);
    await expect(db.query(`update public.supplies set uses_left = 99 where id = $1`, [supply])).resolves.toMatchObject({ affectedRows: 0 });
    await expect(
      db.query(`insert into public.supply_uses (supply_id, household_id, kind, task_id) values ($1, $2, 'chore', gen_random_uuid())`, [supply, householdId]),
    ).rejects.toThrow();

    // Deleting the task removes its links but doesn't give uses back.
    await actAs("dewald");
    await db.query(`delete from public.chores where id = $1`, [chore]);
    expect(await all(`select * from public.supply_uses where supply_id = $1`, [supply])).toHaveLength(0);
    expect(await left()).toBe(0);
  });
});

describe("done for", () => {
  it("credits the child when a grown-up ticks their task", async () => {
    await actAs("dewald");
    const kid = (await one<{ id: string }>(`select id from public.members where user_id = $1`, [USERS.kid.id])).id;
    const dewald = (await one<{ id: string }>(`select id from public.members where user_id = $1`, [USERS.dewald.id])).id;
    const stars = async () =>
      (await one<{ earned: number }>(`select earned from public.member_stars($1, '2030-03-01')`, [kid])).earned;
    const before = await stars();

    // The kid's chore and an unassigned one, both ticked by Dewald.
    const kidsChore = (
      await one<{ id: string }>(
        `insert into public.chores (household_id, title, every_n, unit, next_due, assigned_to) values ($1, 'Feed the cat', 1, 'day', '2030-03-01', $2) returning id`,
        [householdId, kid],
      )
    ).id;
    const anyones = (
      await one<{ id: string }>(
        `insert into public.chores (household_id, title, every_n, unit, next_due) values ($1, 'Water plants', 1, 'day', '2030-03-01') returning id`,
        [householdId],
      )
    ).id;
    await db.query(`select public.set_completion('chore', $1, '2030-03-01', true)`, [kidsChore]);
    await db.query(`select public.set_completion('chore', $1, '2030-03-01', true)`, [anyones]);

    const rows = await all<{ item_id: string; done_by: string; done_for: string }>(
      `select item_id, done_by, done_for from public.completions where item_id in ($1, $2)`,
      [kidsChore, anyones],
    );
    expect(rows.find((r) => r.item_id === kidsChore)).toMatchObject({ done_by: dewald, done_for: kid });
    expect(rows.find((r) => r.item_id === anyones)).toMatchObject({ done_by: dewald, done_for: dewald });

    // The star goes to the kid.
    expect(await stars()).toBe(before + 1);
  });
});

describe("trips", () => {
  it("are private to the people the owner chooses; children only read", async () => {
    await actAs("dewald");
    const memberOf = async (u: UserKey) =>
      (await one<{ id: string }>(`select id from public.members where user_id = $1`, [USERS[u].id])).id;
    const partner = await memberOf("partner");
    const kid = await memberOf("kid");

    // The owner plans a trip with a stay, a plan and who's going.
    const trip = (
      await one<{ id: string }>(
        `insert into public.trips (household_id, name, destination, start_date, end_date) values ($1, 'Spain', 'Costa Brava', '2030-07-01', '2030-07-10') returning id`,
        [householdId],
      )
    ).id;
    await db.query(`insert into public.trip_participants (trip_id, member_id) values ($1, $2)`, [trip, kid]);
    await db.query(`insert into public.trip_stays (trip_id, name, check_in, check_out) values ($1, 'Casa Mar', '2030-07-01', '2030-07-10')`, [trip]);
    await db.query(`insert into public.trip_plans (trip_id, day, time, title) values ($1, '2030-07-01', '07:30', 'Flight to Girona')`, [trip]);
    // household_id was filled from the trip.
    expect((await one<{ h: string }>(`select household_id as h from public.trip_plans where trip_id = $1`, [trip])).h).toBe(householdId);

    // Another adult without access sees nothing and can't add.
    await actAs("partner");
    expect(await all(`select id from public.trips`)).toHaveLength(0);
    expect(await all(`select * from public.trip_stays`)).toHaveLength(0);
    await expect(
      db.query(`insert into public.trips (household_id, name, start_date, end_date) values ($1, 'Mine', '2030-01-01', '2030-01-02')`, [householdId]),
    ).rejects.toThrow();
    // ...and can't give herself access.
    await expect(db.query(`update public.members set can_see_trips = true where id = $1`, [partner])).rejects.toThrow(/owner_only/);
    await expect(db.query(`select public.set_trips_access($1, true)`, [partner])).rejects.toThrow(/owner_only/);

    // The owner gives the kid access: they read, but can't change.
    await actAs("dewald");
    await db.query(`select public.set_trips_access($1, true)`, [kid]);
    await actAs("kid");
    expect(await all(`select id from public.trips`)).toHaveLength(1);
    expect(await all(`select id from public.trip_plans`)).toHaveLength(1);
    const changed = await db.query(`update public.trips set name = 'Hacked' where id = $1`, [trip]);
    expect(changed.affectedRows).toBe(0);

    // Bad dates are refused.
    await actAs("dewald");
    await expect(
      db.query(`insert into public.trip_stays (trip_id, name, check_in, check_out) values ($1, 'Oops', '2030-07-05', '2030-07-05')`, [trip]),
    ).rejects.toThrow();
  });
});

describe("trip packing and budget", () => {
  it("allows one level of groups, and keeps the money from children", async () => {
    await actAs("dewald");
    const trip = (await one<{ id: string }>(`select id from public.trips where name = 'Spain'`)).id;

    // A group with an item, and a nested group refused.
    const group = (await one<{ id: string }>(`insert into public.trip_checklist (trip_id, text) values ($1, 'Car rental') returning id`, [trip])).id;
    const child = (
      await one<{ id: string }>(`insert into public.trip_checklist (trip_id, text, parent_id) values ($1, 'Licence', $2) returning id`, [trip, group])
    ).id;
    await expect(
      db.query(`insert into public.trip_checklist (trip_id, text, parent_id) values ($1, 'Too deep', $2)`, [trip, child]),
    ).rejects.toThrow(/invalid_group/);

    // Budget and a rate.
    await db.query(`insert into public.trip_budget (trip_id, title, category, amount_cents, currency) values ($1, 'Villa', 'Accommodation', 150000, 'EUR')`, [trip]);
    await db.query(`insert into public.trip_rates (trip_id, currency, rate) values ($1, 'GBP', 1.17)`, [trip]);
    await expect(
      db.query(`insert into public.trip_budget (trip_id, title, category, amount_cents) values ($1, 'Bad', 'Nonsense', 1)`, [trip]),
    ).rejects.toThrow();

    // The kid (given Trips access earlier) sees packing, not money.
    await actAs("kid");
    expect(await all(`select id from public.trip_checklist`)).toHaveLength(2);
    expect(await all(`select id from public.trip_budget`)).toHaveLength(0);
    expect(await all(`select * from public.trip_rates`)).toHaveLength(0);
    const ticked = await db.query(`update public.trip_checklist set done = true where id = $1`, [child]);
    expect(ticked.affectedRows).toBe(0);

    // School days: a weekday is a school day, a weekend isn't.
    const days = await all<{ d: string }>(`select d::text as d from public.school_days('2030-07-05', '2030-07-08') d`);
    expect(days.map((r) => r.d)).not.toContain("2030-07-06"); // Saturday
    expect(days.map((r) => r.d)).not.toContain("2030-07-07"); // Sunday

    // Deleting the group takes its items with it.
    await actAs("dewald");
    await db.query(`delete from public.trip_checklist where id = $1`, [group]);
    expect(await all(`select id from public.trip_checklist where trip_id = $1`, [trip])).toHaveLength(0);
  });
});

describe("trip documents and IDs", () => {
  it("keeps documents in the trip's folder and IDs for adults with access", async () => {
    await actAs("dewald");
    const trip = (await one<{ id: string }>(`select id from public.trips where name = 'Spain'`)).id;
    const kid = (await one<{ id: string }>(`select id from public.members where user_id = $1`, [USERS.kid.id])).id;

    // A document in the trip's own folder; one pointing elsewhere is refused.
    await db.query(
      `insert into public.trip_documents (trip_id, name, category, storage_path) values ($1, 'Boarding passes', 'Flight', $2)`,
      [trip, `${householdId}/${trip}/abc.pdf`],
    );
    await expect(
      db.query(`insert into public.trip_documents (trip_id, name, storage_path) values ($1, 'Sneaky', 'someone-else/x.pdf')`, [trip]),
    ).rejects.toThrow(/invalid_path/);

    // A passport with its 1Password link; a non-link is refused.
    await db.query(
      `insert into public.member_ids (member_id, kind, country, expiry_date, onepassword_url) values ($1, 'passport', 'Netherlands', '2031-01-01', 'https://start.1password.com/open/i?i=x')`,
      [kid],
    );
    await expect(
      db.query(`insert into public.member_ids (member_id, kind, expiry_date, onepassword_url) values ($1, 'passport', '2031-01-01', 'NL1234567')`, [kid]),
    ).rejects.toThrow();

    // The details from the info page; an issue date after expiry is refused.
    await db.query(
      `insert into public.member_ids (member_id, kind, country, expiry_date, holder_name, issue_date, place_of_issue) values ($1, 'passport', 'South Africa', '2030-11-25', 'Test Kid', '2020-11-26', 'South Africa')`,
      [kid],
    );
    await expect(
      db.query(`insert into public.member_ids (member_id, kind, expiry_date, issue_date) values ($1, 'passport', '2030-01-01', '2031-01-01')`, [kid]),
    ).rejects.toThrow(/member_ids_issue_before_expiry/);

    // Driving licences are a kind of their own; anything else is refused.
    await db.query(`insert into public.member_ids (member_id, kind, country, expiry_date) values ($1, 'drivers_license', 'Netherlands', '2034-03-01')`, [kid]);
    await expect(db.query(`insert into public.member_ids (member_id, kind, expiry_date) values ($1, 'bsn', '2034-03-01')`, [kid])).rejects.toThrow(/member_ids_kind_check/);

    // The kid (Trips access, read-only) sees neither.
    await actAs("kid");
    expect(await all(`select id from public.trip_documents`)).toHaveLength(0);
    expect(await all(`select id from public.member_ids`)).toHaveLength(0);
  });
});

describe("family board", () => {
  it("pairs with a one-time code, reads like a child and never sees money or trips", async () => {
    // An adult makes a code; children can't.
    await actAs("kid");
    await expect(db.query(`select public.create_board_code()`)).rejects.toThrow(/adults_only/);
    await actAs("dewald");
    const code = (await one<{ c: string }>(`select public.create_board_code() as c`)).c;
    expect(code).toMatch(/^[0-9]{8}$/);

    // Only the server claims it, once.
    await expect(db.query(`select public.claim_board_code($1, $2)`, [code, USERS.board.id])).rejects.toThrow();
    await actAsAdmin();
    await db.query(`select public.claim_board_code($1, $2)`, [code, USERS.board.id]);
    await expect(db.query(`select public.claim_board_code($1, $2)`, [code, USERS.outsider.id])).rejects.toThrow(/invalid_code/);

    // The board reads the household like a child: members, chores, to-dos.
    await actAs("board");
    expect((await all(`select id from public.members`)).length).toBeGreaterThan(1);
    expect((await all(`select id from public.chores`)).length).toBeGreaterThan(0);
    // ...but nothing private, and it can't write anything directly.
    expect(await all(`select * from public.bunq_connections`)).toHaveLength(0);
    expect(await all(`select * from public.trips`)).toHaveLength(0);
    expect(await all(`select * from public.member_ids`)).toHaveLength(0);
    expect(await all(`select * from public.notification_prefs`)).toHaveLength(0);
    await expect(
      db.query(`insert into public.chores (household_id, title, every_n, unit, next_due) values ($1, 'Hack', 1, 'day', '2030-01-01')`, [householdId]),
    ).rejects.toThrow();
    await expect(db.query(`select public.set_completion('chore', gen_random_uuid(), '2030-01-01', true)`)).rejects.toThrow(/not_in_household/);
  });

  it("holds a child's board tick until any adult confirms it; adults' ticks count at once", async () => {
    await actAs("dewald");
    const id = async (user: keyof typeof USERS) =>
      (await one<{ id: string }>(`select id from public.members where user_id = $1`, [USERS[user].id])).id;
    const [kid, dewald, partner] = [await id("kid"), await id("dewald"), await id("partner")];
    const day = "2030-04-01";
    const stars = async () => (await one<{ earned: number }>(`select earned from public.member_stars($1, $2)`, [kid, day])).earned;
    const before = await stars();

    // The kid's chore (linked to a supply), an unassigned chore and an unassigned to-do.
    const kidsChore = (
      await one<{ id: string }>(
        `insert into public.chores (household_id, title, every_n, unit, next_due, assigned_to) values ($1, 'Make the bed', 1, 'day', $2, $3) returning id`,
        [householdId, day, kid],
      )
    ).id;
    const anyChore = (
      await one<{ id: string }>(
        `insert into public.chores (household_id, title, every_n, unit, next_due) values ($1, 'Sweep the porch', 1, 'day', $2) returning id`,
        [householdId, day],
      )
    ).id;
    const itemId = (await one<{ id: string }>(`select public.ensure_item('Bed spray') as id`)).id;
    const supply = (
      await one<{ id: string }>(`insert into public.supplies (household_id, item_id, uses_per_pack, uses_left, warn_at) values ($1, $2, 10, 10, 0) returning id`, [
        householdId,
        itemId,
      ])
    ).id;
    await db.query(`insert into public.supply_uses (supply_id, household_id, kind, task_id) values ($1, $2, 'chore', $3)`, [supply, householdId, kidsChore]);
    const left = async () => (await one<{ n: number }>(`select uses_left as n from public.supplies where id = $1`, [supply])).n;
    const todoList = (await one<{ id: string }>(`select id from public.lists where type = 'todo' limit 1`)).id;
    const todo = (await one<{ id: string }>(`select public.add_entry($1, 'Feed the fish') as id`, [todoList])).id;

    await actAs("board");
    // Someone else's task can't be credited to another person.
    await expect(db.query(`select public.board_set_completion('chore', $1, $2, true, $3)`, [kidsChore, day, dewald])).rejects.toThrow(
      /assigned_to_someone_else/,
    );
    // The kid ticks their chore and the to-do; Dewald ticks the unassigned chore.
    await db.query(`select public.board_set_completion('chore', $1, $2, true, $3)`, [kidsChore, day, kid]);
    await db.query(`select public.board_set_entry($1, true, $2)`, [todo, kid]);
    await db.query(`select public.board_set_completion('chore', $1, $2, true, $3)`, [anyChore, day, dewald]);

    const tick = async (item: string) =>
      one<{ pending: boolean; done_for: string; via_board: boolean }>(`select pending, done_for, via_board from public.completions where item_id = $1`, [item]);
    expect(await tick(kidsChore)).toMatchObject({ pending: true, done_for: kid, via_board: true });
    expect(await tick(anyChore)).toMatchObject({ pending: false, done_for: dewald });
    expect(await one(`select status, pending, done_for from public.list_entries where id = $1`, [todo])).toMatchObject({
      status: "done",
      pending: true,
      done_for: kid,
    });
    // Waiting: no stars, no supply used.
    expect(await stars()).toBe(before);
    expect(await left()).toBe(10);
    // The board can take back its own pending tick (a mis-tap) and redo it.
    await db.query(`select public.board_set_completion('chore', $1, $2, false, $3)`, [kidsChore, day, kid]);
    expect(await all(`select id from public.completions where item_id = $1`, [kidsChore])).toHaveLength(0);
    await db.query(`select public.board_set_completion('chore', $1, $2, true, $3)`, [kidsChore, day, kid]);

    // Children and boards can't confirm.
    await expect(db.query(`select public.confirm_ticks(array[]::uuid[], array[]::uuid[])`)).rejects.toThrow(/adults_only/);
    await actAs("kid");
    await expect(db.query(`select public.confirm_ticks(array[]::uuid[], array[]::uuid[])`)).rejects.toThrow(/adults_only/);

    // Any adult confirms: stars and supplies count now.
    await actAs("partner");
    const chorePending = (await one<{ id: string }>(`select id from public.completions where item_id = $1`, [kidsChore])).id;
    expect((await one<{ n: number }>(`select public.confirm_ticks(array[$1]::uuid[], array[$2]::uuid[]) as n`, [chorePending, todo])).n).toBe(2);
    expect(await one(`select pending, confirmed_by from public.completions where id = $1`, [chorePending])).toMatchObject({
      pending: false,
      confirmed_by: partner,
    });
    expect(await stars()).toBe(before + 2);
    expect(await left()).toBe(9);

    // Once confirmed, the board can't undo it.
    await actAs("board");
    await expect(db.query(`select public.board_set_completion('chore', $1, $2, false, $3)`, [kidsChore, day, kid])).rejects.toThrow(/ask_a_grown_up/);

    // Rejecting: the chore is undone and gets its due date back.
    const next = "2030-04-02";
    await db.query(`select public.board_set_completion('chore', $1, $2, true, $3)`, [kidsChore, next, kid]);
    await actAs("dewald");
    expect((await one<{ d: string }>(`select next_due::text as d from public.chores where id = $1`, [kidsChore])).d).toBe("2030-04-03");
    const second = (await one<{ id: string }>(`select id from public.completions where item_id = $1 and for_date = $2`, [kidsChore, next])).id;
    await db.query(`select public.reject_ticks(array[$1]::uuid[], array[]::uuid[])`, [second]);
    expect(await all(`select id from public.completions where id = $1`, [second])).toHaveLength(0);
    expect((await one<{ d: string }>(`select next_due::text as d from public.chores where id = $1`, [kidsChore])).d).toBe(next);
    expect(await left()).toBe(9);
  });
});

describe("smartthings", () => {
  it("lets only the owner (and adults they allow) see Home; the server records changes, not repeats", async () => {
    await actAs("dewald");
    const id = async (user: keyof typeof USERS) =>
      (await one<{ id: string }>(`select id from public.members where user_id = $1`, [USERS[user].id])).id;
    const partner = await id("partner");
    const kid = await id("kid");

    // Server side: a connection and a washer.
    await actAsAdmin();
    await db.query(`select public.home_save_credentials($1, '{"access_token":"x"}', 'app-1', now() + interval '1 day', null)`, [householdId]);
    await db.query(
      `insert into public.home_devices (household_id, external_id, name, kind, capabilities) values ($1, 'washer-1', 'Washer', 'washer', '{washerOperatingState}')`,
      [householdId],
    );
    const record = (value: string) =>
      one<{ id: number | null }>(`select public.home_record_event($1, 'washer-1', 'washerOperatingState', 'machineState', to_jsonb($2::text), now()) as id`, [
        householdId,
        value,
      ]);
    expect((await record("run")).id).not.toBeNull();
    expect((await record("run")).id).toBeNull(); // a repeat is not an event
    expect((await record("stop")).id).not.toBeNull();
    expect(await one(`select value, previous from public.home_events order by id desc limit 1`)).toEqual({ value: "stop", previous: "run" });
    expect((await one<{ s: string }>(`select state->'washerOperatingState'->>'machineState' as s from public.home_devices`)).s).toBe("stop");

    // The owner sees it; the partner only once allowed; kids never.
    await actAs("dewald");
    expect(await all(`select id from public.home_devices`)).toHaveLength(1);
    expect(await all(`select vault_secret_id from public.home_connections`)).toHaveLength(1);
    await expect(db.query(`select public.home_get_credentials($1)`, [householdId])).rejects.toThrow();
    await actAs("partner");
    expect(await all(`select id from public.home_devices`)).toHaveLength(0);
    await expect(db.query(`update public.members set can_manage_home = true where id = $1`, [partner])).rejects.toThrow(/owner_only/);
    await actAs("dewald");
    await db.query(`select public.set_home_access($1, true)`, [partner]);
    await expect(db.query(`select public.set_home_access($1, true)`, [kid])).rejects.toThrow(/member_not_in_household/);
    await actAs("partner");
    expect(await all(`select id from public.home_events`)).toHaveLength(2);
    await actAs("kid");
    expect(await all(`select id from public.home_devices`)).toHaveLength(0);

    // Disconnecting forgets everything.
    await actAsAdmin();
    await db.query(`select public.home_remove_connection($1)`, [householdId]);
    expect(await all(`select id from public.home_devices`)).toHaveLength(0);
    expect(await all(`select id from vault.secrets where name like 'smartthings_%'`)).toHaveLength(0);
  });

  it("only counts a supply from ticks when it's counted by ticks", async () => {
    await actAs("dewald");
    const day = "2030-05-01";
    const chore = (
      await one<{ id: string }>(`insert into public.chores (household_id, title, every_n, unit, next_due) values ($1, 'Washing', 1, 'day', $2) returning id`, [
        householdId,
        day,
      ])
    ).id;
    const itemId = (await one<{ id: string }>(`select public.ensure_item('Fabric softener') as id`)).id;
    const supply = (
      await one<{ id: string }>(
        `insert into public.supplies (household_id, item_id, uses_per_pack, uses_left, warn_at, counted_by) values ($1, $2, 10, 10, 0, 'automations') returning id`,
        [householdId, itemId],
      )
    ).id;
    await db.query(`insert into public.supply_uses (supply_id, household_id, kind, task_id) values ($1, $2, 'chore', $3)`, [supply, householdId, chore]);
    await db.query(`select public.set_completion('chore', $1, $2, true)`, [chore, day]);
    expect((await one<{ n: number }>(`select uses_left as n from public.supplies where id = $1`, [supply])).n).toBe(10);
    await db.query(`update public.supplies set counted_by = 'tasks' where id = $1`, [supply]);
    await db.query(`select public.set_completion('chore', $1, $2, true)`, [chore, "2030-05-02"]);
    expect((await one<{ n: number }>(`select uses_left as n from public.supplies where id = $1`, [supply])).n).toBe(9);
  });
});
