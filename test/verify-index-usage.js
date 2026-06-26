/**
 * Verification harness — NOT part of the submitted app.
 *
 * Confirms the keyset pagination query actually gets planned as an index
 * scan (not a sequential scan) by Postgres. This is what makes pagination
 * stay fast regardless of how deep a user pages into 200k rows — if this
 * ever silently degraded to a seq scan, "fast pagination" would quietly
 * stop being true even though the query still returns correct results.
 */

const { PGlite } = require('@electric-sql/pglite');
const fs = require('fs');
const path = require('path');

async function main() {
  const db = new PGlite();
  const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.exec(schema);

  // Insert enough rows for the planner to have a realistic table to reason about.
  const N = 20000;
  const batchSize = 2000;
  for (let start = 0; start < N; start += batchSize) {
    const values = [];
    for (let i = start; i < start + batchSize; i++) {
      const createdAt = new Date(Date.now() - i * 1000).toISOString();
      values.push(`('Product ${i}', 'Category${i % 5}', ${(i % 100) + 1}, '${createdAt}', '${createdAt}')`);
    }
    await db.exec(`INSERT INTO products (name, category, price, created_at, updated_at) VALUES ${values.join(',')}`);
  }
  await db.exec('ANALYZE products');
  console.log(`[OK] inserted and analyzed ${N} rows`);

  // Plan 1: first page, no filter
  const plan1 = await db.query(`
    EXPLAIN (FORMAT TEXT)
    SELECT id, created_at FROM products
    ORDER BY created_at DESC, id DESC
    LIMIT 20
  `);
  console.log('\n--- Plan: first page, no filter ---');
  console.log(plan1.rows.map(r => r['QUERY PLAN']).join('\n'));

  // Plan 2: deep page (simulating cursor far into the dataset)
  const midpoint = await db.query(`SELECT created_at, id FROM products ORDER BY created_at DESC, id DESC LIMIT 1 OFFSET 10000`);
  const cursor = midpoint.rows[0];
  const plan2 = await db.query(
    `EXPLAIN (FORMAT TEXT)
     SELECT id, created_at FROM products
     WHERE (created_at, id) < ($1, $2)
     ORDER BY created_at DESC, id DESC
     LIMIT 20`,
    [cursor.created_at, cursor.id]
  );
  console.log('\n--- Plan: deep page via cursor (10,000 rows in) ---');
  console.log(plan2.rows.map(r => r['QUERY PLAN']).join('\n'));

  // Plan 3: category filter + cursor
  const plan3 = await db.query(
    `EXPLAIN (FORMAT TEXT)
     SELECT id, created_at FROM products
     WHERE category = $1 AND (created_at, id) < ($2, $3)
     ORDER BY created_at DESC, id DESC
     LIMIT 20`,
    ['Category2', cursor.created_at, cursor.id]
  );
  console.log('\n--- Plan: category filter + deep cursor ---');
  console.log(plan3.rows.map(r => r['QUERY PLAN']).join('\n'));

  const allPlans = [plan1, plan2, plan3].map(p => p.rows.map(r => r['QUERY PLAN']).join('\n'));
  const usesIndex = allPlans.every(p => /Index/i.test(p));
  const usesSeqScan = allPlans.some(p => /Seq Scan/i.test(p));

  console.log(`\n[${usesIndex ? 'OK' : 'FAIL'}] all plans use an Index Scan`);
  console.log(`[${!usesSeqScan ? 'OK' : 'FAIL'}] no plan falls back to a full Seq Scan`);

  await db.close();
}

main().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
