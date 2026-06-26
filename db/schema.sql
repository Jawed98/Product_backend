-- Schema for the products catalog.
--
-- Design notes (read this before touching the index):
--
-- 1. We sort "newest first" by created_at, and ALWAYS break ties with id.
--    created_at alone is not safe to sort/paginate on because bulk-inserted
--    rows can share the exact same timestamp (down to the microsecond).
--    Without a tiebreaker, a page boundary that lands inside a group of
--    tied timestamps can skip or duplicate rows.
--
-- 2. The composite index (created_at DESC, id DESC) lets Postgres answer
--    "give me the next page after (created_at, id)" with an index seek,
--    not a scan. Pagination stays fast (effectively O(1) per page)
--    regardless of how deep you've paged in 200k rows.
--
-- 3. category has its own index since we filter on it. Combined with the
--    cursor index below, "filter by category + paginate newest-first"
--    also stays an index-driven query (see schema for the composite
--    category+cursor index).
--
-- 4. updated_at is tracked but deliberately NOT part of the sort order.
--    If we sorted by updated_at, editing an existing product would move
--    it to the top of the feed, which could cause a product a user has
--    already scrolled past to jump back into view (or vice versa) while
--    they're mid-pagination. Sorting by created_at (immutable once set)
--    means a product's position in the "newest first" list never changes
--    after creation, so concurrent edits can't cause skips/duplicates.
--    Concurrent ADDS also can't cause problems: new rows get created_at =
--    now(), so they appear above whatever page the user is currently on,
--    never inserted into a page they've already passed.

CREATE TABLE IF NOT EXISTS products (
    id          BIGSERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    category    TEXT NOT NULL,
    price       NUMERIC(10, 2) NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Powers: "give me everything newest-first, page after cursor (created_at, id)"
CREATE INDEX IF NOT EXISTS idx_products_created_id
    ON products (created_at DESC, id DESC);

-- Powers: "give me everything in category X, newest-first, page after cursor"
-- This composite index lets Postgres filter on category AND apply the
-- keyset condition using a single index, instead of filtering by category
-- then sorting separately.
CREATE INDEX IF NOT EXISTS idx_products_category_created_id
    ON products (category, created_at DESC, id DESC);
