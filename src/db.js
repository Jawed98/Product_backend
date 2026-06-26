const { Pool } = require('pg');

// A single shared connection pool for the whole app. pg's Pool handles
// connection reuse for us — we don't want to open a new TCP/TLS connection
// to Postgres on every request, especially against a hosted DB like Neon
// or Supabase where connection setup has real latency.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Most free-tier hosted Postgres (Neon, Supabase) require SSL.
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  // Idle clients in the pool can occasionally error out (e.g. the hosted
  // DB closing an idle connection); log it but don't crash the process.
  console.error('Unexpected error on idle Postgres client', err);
});

module.exports = pool;
