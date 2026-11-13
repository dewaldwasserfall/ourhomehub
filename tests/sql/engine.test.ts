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
  ];
  await db.exec(SUPABASE_GRANTS);
  for (const file of files) {
    await db.exec(readFileSync(path.join(MIGRATIONS_DIR, file), "utf8"));
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
