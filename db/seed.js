/**
 * Seed script: generates 200,000 products and loads them into Postgres.
 *
 * Why this is fast:
 * Doing 200,000 individual `INSERT INTO ... VALUES (...)` calls is slow
 * because every single one is a network round-trip to the DB, plus
 * Postgres has to parse/plan/commit each one separately. That alone can
 * take many minutes.
 *
 * Instead we stream the rows using Postgres's COPY protocol (via the
 * pg-copy-streams package), which is the fastest way to bulk-load data
 * into Postgres — it's the same mechanism `pg_dump`/`pg_restore` use.
 * 200k rows load in a few seconds this way.
 *
 * created_at is deliberately spread out over the past ~6 months (not all
 * set to "now") so that newest-first pagination, filtering, etc. all have
 * realistic, varied data to work with. A handful of rows are intentionally
 * given IDENTICAL created_at timestamps (down to the second) to mimic a
 * burst import and to give the (created_at, id) tiebreaker something
 * real to do — this is what would break naive cursor pagination that
 * only used created_at.
 */

require('dotenv').config();
const { Pool } = require('pg');
const { from: copyFrom } = require('pg-copy-streams');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');

const TOTAL_PRODUCTS = 200_000;

const CATEGORIES = [
  'Electronics',
  'Home & Kitchen',
  'Books',
  'Clothing',
  'Toys & Games',
  'Sports & Outdoors',
  'Beauty & Personal Care',
  'Office Supplies',
  'Pet Supplies',
  'Automotive',
];

const ADJECTIVES = [
  'Premium', 'Compact', 'Deluxe', 'Portable', 'Wireless', 'Eco-Friendly',
  'Heavy-Duty', 'Classic', 'Smart', 'Lightweight', 'Professional', 'Vintage',
];

const NOUNS = [
  'Widget', 'Gadget', 'Organizer', 'Speaker', 'Backpack', 'Lamp', 'Chair',
  'Bottle', 'Charger', 'Notebook', 'Blender', 'Headphones', 'Mat', 'Toolkit',
];

function randomChoice(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomPrice() {
  // Between 5.00 and 999.99
  return (Math.random() * 994.99 + 5).toFixed(2);
}

// Spread created_at over the last ~180 days, but force ~0.1% of rows into
// a handful of exact duplicate timestamps to simulate a burst import.
const NOW = Date.now();
const SIX_MONTHS_MS = 180 * 24 * 60 * 60 * 1000;
const DUPLICATE_TIMESTAMP_POOL = Array.from({ length: 20 }, () =>
  new Date(NOW - Math.random() * SIX_MONTHS_MS)
);

function randomCreatedAt(i) {
  if (i % 1000 === 0) {
    // force a tie with another row to exercise the (created_at, id) tiebreaker
    return randomChoice(DUPLICATE_TIMESTAMP_POOL);
  }
  return new Date(NOW - Math.random() * SIX_MONTHS_MS);
}

function escapeCopyField(value) {
  // COPY TEXT format: escape backslashes and tabs/newlines.
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

// Generator that yields rows in Postgres COPY TEXT format, in chunks,
// without ever materializing all 200k rows as one giant string in memory.
async function* generateRows() {
  const CHUNK_SIZE = 5000;
  let buffer = '';

  for (let i = 1; i <= TOTAL_PRODUCTS; i++) {
    const name = `${randomChoice(ADJECTIVES)} ${randomChoice(NOUNS)}`;
    const category = randomChoice(CATEGORIES);
    const price = randomPrice();
    const createdAt = randomCreatedAt(i).toISOString();
    // updated_at == created_at at seed time; nothing has been "updated" yet
    const updatedAt = createdAt;

    buffer += [
      escapeCopyField(name),
      escapeCopyField(category),
      escapeCopyField(price),
      escapeCopyField(createdAt),
      escapeCopyField(updatedAt),
    ].join('\t') + '\n';

    if (i % CHUNK_SIZE === 0) {
      yield buffer;
      buffer = '';
    }
  }
  if (buffer) yield buffer;
}

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  console.log(`Seeding ${TOTAL_PRODUCTS.toLocaleString()} products...`);
  const start = Date.now();

  const client = await pool.connect();
  try {
    // Clear existing data first so re-running this script is idempotent.
    await client.query('TRUNCATE TABLE products RESTART IDENTITY');

    const copyStream = client.query(
      copyFrom('COPY products (name, category, price, created_at, updated_at) FROM STDIN')
    );
    const sourceStream = Readable.from(generateRows());

    await pipeline(sourceStream, copyStream);

    const { rows } = await client.query('SELECT COUNT(*) FROM products');
    const elapsedSeconds = ((Date.now() - start) / 1000).toFixed(2);
    console.log(`Done. ${rows[0].count} rows inserted in ${elapsedSeconds}s.`);
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}

module.exports = { generateRows, TOTAL_PRODUCTS, escapeCopyField };
