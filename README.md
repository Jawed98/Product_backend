# Product Catalog API — CodeVector Take-Home

Browse ~200,000 products, newest first, with category filtering and pagination
that stays fast and correct as the catalog changes underneath you.

## Stack

- **Node.js + Express** — HTTP API
- **PostgreSQL** — chosen because the core requirement ("fast pagination,
  correct under concurrent writes") is fundamentally a query-planning and
  indexing problem, and Postgres gives precise control over both (composite
  indexes, `EXPLAIN`, transactional consistency) without needing a
  specialized search engine like Elasticsearch, which would be overkill for
  200k rows and adds an extra system to keep in sync.
- **`pg`** (node-postgres) as the driver — no ORM. At this scale and with
  one fairly simple query shape, an ORM adds an abstraction layer without
  saving meaningful effort, and it's important I can show I understand
  exactly what SQL is being sent.

## The two requirements, and how the schema satisfies both at once

### 1. Pagination must be fast on 200k+ rows

The naive approach (`OFFSET 4000 LIMIT 20`) gets slower the deeper you
page, because Postgres has to scan and discard every row before the
offset. Instead this uses **keyset (cursor) pagination**:

```sql
WHERE (created_at, id) < ($lastCreatedAt, $lastId)
ORDER BY created_at DESC, id DESC
LIMIT 20
```

With a composite index on `(created_at DESC, id DESC)`, this is an index
seek — verified with `EXPLAIN` to confirm it never falls back to a
sequential scan, even when the cursor is tens of thousands of rows deep
(see `test/verify-index-usage.js`).

### 2. Pagination must stay correct while data changes underneath the user

This is the part that's easy to get subtly wrong, and is really the heart
of the task. Two failure modes had to be ruled out:

- **Tied timestamps.** Bulk-inserted or rapidly-created rows can share the
  exact same `created_at`. If the cursor were `created_at` alone, a page
  boundary landing inside a tie could skip or duplicate rows. Fix: every
  query orders and filters on the *tuple* `(created_at, id)`, with `id` as
  a tiebreaker. This makes the ordering strictly unique — there is never
  any ambiguity about what "the next row" is, even with thousands of
  identical timestamps. The seed script deliberately creates rows with
  identical timestamps for this exact reason, and `test/verify-pagination.js`
  confirms zero duplicates/zero gaps across them.

- **Position drift from edits.** If sort order were driven by `updated_at`,
  editing an existing product would move it to the top of the feed —
  potentially causing it to reappear after a user has already scrolled
  past it, or to jump ahead of where they currently are. The fix: sort
  strictly by `created_at`, which is set once at creation and never
  changes. `updated_at` is tracked in the schema (useful for "last
  modified" elsewhere) but deliberately excluded from the sort/cursor.
  Newly added rows get `created_at = now()`, so they appear *above*
  whatever page the user is currently on — never inserted into a page
  they've already passed.

`test/verify-pagination.js` proves this directly: it paginates through
2,000 rows, and **midway through** injects 50 new rows and updates 30
existing ones (price + `updated_at` changes), concurrently. The assertion
checks that the in-flight pagination walk still sees exactly the original
2,000 rows — no duplicates, no gaps — which is exactly the scenario the
task describes ("if 50 new products are added/updated while someone is
browsing, they must not see the same product twice or miss one").

## Why this isn't "real-time consistent" in the strict sense — and why that's fine here

Keyset pagination as built guarantees a **stable, append-only-safe view**:
once a user starts paginating, the page they're on never reshuffles
because of writes elsewhere. It does **not** give a frozen snapshot — a
page they haven't reached yet can still reflect new inserts above it (which
is correct/expected for a "newest first" feed) and in-place edits to fields
you're not sorting on (price, name) will show the latest value if you
re-fetch that page, which is normal and desirable for a live catalog. What
it specifically prevents is duplicate/missing rows caused by the act of
paginating itself — which is what the task asks for.

## API

`GET /products`
| param | required | description |
|---|---|---|
| `category` | no | exact match filter |
| `cursor` | no | opaque token from a previous response's `nextCursor`; omit for page 1 |
| `limit` | no | page size, default 20, max 100 |

```json
{
  "data": [ { "id": 1, "name": "...", "category": "...", "price": 12.99, "createdAt": "...", "updatedAt": "..." } ],
  "nextCursor": "eyJjcmVhdGVkQXQiOiI...",
  "hasNextPage": true
}
```

`GET /categories` → `{ "categories": ["Electronics", "Books", ...] }`

## The seed script (`db/seed.js`)

Generates 200,000 products and bulk-loads them via Postgres's `COPY FROM
STDIN` protocol (through `pg-copy-streams`), the same mechanism
`pg_dump`/`pg_restore` use. This avoids the classic mistake of 200,000
individual `INSERT` round-trips, each of which carries its own network and
planning overhead — that approach can take minutes; `COPY` loads the full
200k rows in a few seconds. Rows are streamed via an async generator so
the full dataset is never materialized in memory at once. The script also
deliberately seeds a small number of rows with **identical** `created_at`
timestamps, so the tiebreaker logic described above has real data to
exercise, not just a theoretical edge case.

Run it with:
```bash
DATABASE_URL=postgres://... node db/seed.js
```
It's idempotent — re-running it truncates and reseeds rather than
appending duplicates.

## Running locally

```bash
npm install
cp .env.example .env   # fill in DATABASE_URL
node -e "require('./db/seed.js')"   # or: node db/seed.js
npm start
```

## Deployment

- **Database:** Neon or Supabase free tier.
- **Backend:** Render free web service. Build command `npm install`,
  start command `node src/server.js`. Set `DATABASE_URL` as an env var
  pointing at the hosted Postgres connection string.

## What I'd improve with more time

- **Total count.** The API currently returns `hasNextPage` (cheap: fetch
  `limit + 1` rows) rather than a total row count, because `COUNT(*)` on
  200k+ rows with a `WHERE` filter is comparatively expensive and not
  needed for "next/previous" style browsing. If a "Page 1 of 10,000" UI
  were required, I'd maintain an approximate count (e.g. via
  `pg_stat_user_tables` estimates, refreshed periodically) rather than
  computing it live.
- **Backward pagination.** The current cursor only walks forward
  (older). The bonus UI fakes "Previous" by remembering cursors it's
  already seen client-side, but a more robust API would support a
  `direction=before` cursor using `(created_at, id) >` with ascending
  order, then reversing the result — I scoped this out to keep the core
  submission focused on the two stated requirements.
- **Rate limiting / auth.** None implemented since the task didn't ask for
  it, but I'd add basic rate limiting before treating this as
  production-ready.
- **Full-text search on name.** Out of scope per the task (only category
  filter + pagination were required), but `pg_trgm` or a `tsvector` column
  would be the natural next step.

## How I used AI

I used Claude to help design and implement this. Specifically:

- **Helped with:** discussing the tradeoffs between OFFSET and keyset
  pagination upfront, writing the SQL/index design, the COPY-based seed
  script, the Express routes, and an automated test harness (using
  `@electric-sql/pglite`, a real Postgres engine compiled to WASM) to
  *actually run* the schema, seed logic, and full HTTP API end-to-end and
  verify the no-duplicates/no-gaps claim under simulated concurrent writes,
  rather than asserting it from comments alone.
- **What it caught and fixed during testing:** an initial version of
  `seed.js` used `pg-copy-streams`'s `to()` export (meant for `COPY TO
  STDOUT`, i.e. exporting data) instead of `from()` (for `COPY FROM
  STDIN`, importing data) — a one-line but easy-to-miss bug that the
  end-to-end test caught immediately when the COPY stream had no `.write`
  method. It also surfaced that PGlite's wire-protocol test server doesn't
  support the `COPY FROM STDIN` sub-protocol at all (a PGlite-specific
  limitation, confirmed against PGlite's own docs), so the *local test
  harness* (not production code) falls back to batched `INSERT`s for
  verification purposes.
- **What I'd flag in the live round:** I can walk through the index
  design, the cursor encode/decode logic, and why `created_at`-only
  sorting (without the `id` tiebreaker) would be wrong, in detail — these
  were the core design decisions and I want to be able to defend them
  without notes.
