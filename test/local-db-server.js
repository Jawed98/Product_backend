/**
 * Local-only test database server — NOT part of the submitted app.
 *
 * Spins up a real Postgres wire-protocol server (backed by pglite, a
 * Postgres engine compiled to WASM) on a local TCP port, so we can run
 * our actual seed script and Express API against a real `pg.Pool`
 * connection during development/testing, without needing a hosted DB.
 *
 * In production this is replaced entirely by Neon/Supabase — this file
 * is purely a stand-in for local verification.
 */
const { PGlite } = require('@electric-sql/pglite');
const { PGLiteSocketServer } = require('@electric-sql/pglite-socket');

async function main() {
  const db = new PGlite();
  const server = new PGLiteSocketServer({ db, port: 5433, host: '127.0.0.1' });
  await server.start();
  console.log('Local test Postgres (pglite) listening on 127.0.0.1:5433');
}

main().catch((err) => {
  console.error('Failed to start local test DB:', err);
  process.exit(1);
});
