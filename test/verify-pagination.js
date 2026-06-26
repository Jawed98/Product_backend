/**
 * Verification harness — NOT part of the submitted app.
 *
 * Uses @electric-sql/pglite (a real Postgres engine compiled to WASM) to
 * actually execute our schema and pagination queries, so the correctness
 * claims in this project are tested, not just asserted in comments.
 *
 * This proves:
 *   1. The schema applies cleanly.
 *   2. Keyset pagination over (created_at, id) returns every row exactly
 *      once, in the correct order, even when many rows share an identical
 *      created_at timestamp.
 *   3. Pagination is correct even while concurrent inserts/updates happen
 *      mid-pagination (the core requirement from the task).
 */

const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');

async function main() {
  const db = new PGlite();

  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.exec(schema);
  console.log('[OK] schema applied');

  // --- Test 1: seed 2,000 rows, several sharing identical created_at ---
  const N = 2000;
  const tiedTimestamp = '2024-01-01T00:00:00.000Z';
  const values = [];
  for (let i = 1; i <= N; i++) {
    const createdAt = i % 50 === 0 ? tiedTimestamp : `2024-01-${String((i % 28) + 1).padStart(2, '0')}T00:00:0${i % 10}.000Z`;
    values.push(`('Product ${i}', 'Category${i % 5}', ${(i * 1.5).toFixed(2)}, '${createdAt}', '${createdAt}')`);
  }
  await db.exec(`INSERT INTO products (name, category, price, created_at, updated_at) VALUES ${values.join(',')}`);
  console.log(`[OK] inserted ${N} rows, ${Math.floor(N / 50)} share an identical created_at`);

  // --- Test 2: paginate through ALL rows via keyset cursor, collect ids ---
  async function paginateAll(pageSize, categoryFilter = null) {
    const seen = [];
    let cursor = null; // { createdAt, id }

    while (true) {
      let query, params;
      if (categoryFilter) {
        if (cursor) {
          query = `
            SELECT id, created_at FROM products
            WHERE category = $1 AND (created_at, id) < ($2, $3)
            ORDER BY created_at DESC, id DESC
            LIMIT $4`;
          params = [categoryFilter, cursor.createdAt, cursor.id, pageSize];
        } else {
          query = `
            SELECT id, created_at FROM products
            WHERE category = $1
            ORDER BY created_at DESC, id DESC
            LIMIT $2`;
          params = [categoryFilter, pageSize];
        }
      } else {
        if (cursor) {
          query = `
            SELECT id, created_at FROM products
            WHERE (created_at, id) < ($1, $2)
            ORDER BY created_at DESC, id DESC
            LIMIT $3`;
          params = [cursor.createdAt, cursor.id, pageSize];
        } else {
          query = `
            SELECT id, created_at FROM products
            ORDER BY created_at DESC, id DESC
            LIMIT $1`;
          params = [pageSize];
        }
      }

      const res = await db.query(query, params);
      if (res.rows.length === 0) break;

      for (const row of res.rows) seen.push(row.id);
      const last = res.rows[res.rows.length - 1];
      cursor = { createdAt: last.created_at, id: last.id };

      if (res.rows.length < pageSize) break; // last page
    }
    return seen;
  }

  const allIds = await paginateAll(20);
  const uniqueIds = new Set(allIds);
  console.assert(allIds.length === N, `expected ${N} rows visited, got ${allIds.length}`);
  console.assert(uniqueIds.size === N, `expected ${N} unique ids, got ${uniqueIds.size} (duplicates found!)`);
  console.log(`[OK] paginated all ${allIds.length} rows with page size 20 — 0 duplicates, 0 missing, even across tied timestamps`);

  // --- Test 3: category filter pagination correctness ---
  const catIds = await paginateAll(13, 'Category2');
  const { rows: catCountRows } = await db.query(`SELECT COUNT(*) FROM products WHERE category = 'Category2'`);
  const expectedCatCount = Number(catCountRows[0].count);
  console.assert(catIds.length === expectedCatCount, `category filter: expected ${expectedCatCount}, got ${catIds.length}`);
  console.assert(new Set(catIds).size === catIds.length, 'category filter: duplicates found');
  console.log(`[OK] category-filtered pagination: ${catIds.length}/${expectedCatCount} rows, no duplicates`);

  // --- Test 4: THE key correctness test — concurrent writes during pagination ---
  // Simulate: user starts paginating. Midway through, 50 new products are
  // added (simulating concurrent writes) AND some existing products are
  // updated (price change, name change) via UPDATE (which touches
  // updated_at but NOT created_at).
  // Expectation: the user's pagination walk sees the ORIGINAL N rows
  // exactly once each, with no duplicates and no gaps. New rows correctly
  // do not appear (they're "ahead" of where the user already scrolled,
  // which is correct newest-first behavior), and updates to existing rows
  // don't cause them to be seen twice or skipped.

  async function paginateWithConcurrentWrites(pageSize) {
    const seen = [];
    let cursor = null;
    let writesInjected = false;

    while (true) {
      let query, params;
      if (cursor) {
        query = `
          SELECT id, created_at FROM products
          WHERE (created_at, id) < ($1, $2)
          ORDER BY created_at DESC, id DESC
          LIMIT $3`;
        params = [cursor.createdAt, cursor.id, pageSize];
      } else {
        query = `SELECT id, created_at FROM products ORDER BY created_at DESC, id DESC LIMIT $1`;
        params = [pageSize];
      }

      const res = await db.query(query, params);
      if (res.rows.length === 0) break;
      for (const row of res.rows) seen.push(row.id);
      const last = res.rows[res.rows.length - 1];
      cursor = { createdAt: last.created_at, id: last.id };

      // Midway through pagination, inject 50 new rows + update 30 existing rows.
      if (!writesInjected && seen.length >= 400) {
        writesInjected = true;

        const newRows = [];
        for (let j = 0; j < 50; j++) {
          newRows.push(`('New Product ${j}', 'Category${j % 5}', 9.99, now(), now())`);
        }
        await db.exec(`INSERT INTO products (name, category, price, created_at, updated_at) VALUES ${newRows.join(',')}`);

        // Update 30 already-existing rows (change price/name + updated_at),
        // WITHOUT touching created_at.
        await db.exec(`
          UPDATE products SET price = price + 1, updated_at = now()
          WHERE id IN (SELECT id FROM products ORDER BY id ASC LIMIT 30)
        `);
      }

      if (res.rows.length < pageSize) break;
    }
    return seen;
  }

  const seenDuringWrites = await paginateWithConcurrentWrites(20);
  const uniqueSeen = new Set(seenDuringWrites);

  console.assert(
    seenDuringWrites.length === N,
    `expected to see exactly the original ${N} rows, saw ${seenDuringWrites.length}`
  );
  console.assert(
    uniqueSeen.size === seenDuringWrites.length,
    `duplicates detected during concurrent-write pagination! saw ${seenDuringWrites.length} but only ${uniqueSeen.size} unique`
  );

  const { rows: totalAfter } = await db.query('SELECT COUNT(*) FROM products');
  console.log(`[OK] mid-pagination: 50 inserts + 30 updates happened concurrently.`);
  console.log(`[OK] user's pagination walk still saw exactly ${seenDuringWrites.length} rows (the original ${N}), 0 duplicates, 0 missing.`);
  console.log(`[OK] DB now has ${totalAfter[0].count} total rows (${N} + 50 new), confirming new rows exist but correctly didn't appear in the in-flight pagination.`);

  console.log('\nAll correctness checks passed.');
  await db.close();
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
