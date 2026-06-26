const express = require('express');
const pool = require('./db');
const { encodeCursor, decodeCursor } = require('./cursor');

const router = express.Router();

const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

/**
 * GET /products
 *
 * Query params:
 *   category   (optional) — filter to a single category, exact match
 *   cursor     (optional) — opaque cursor from a previous response's
 *                            `nextCursor`. Omit for the first page.
 *   limit      (optional) — page size, default 20, max 100
 *
 * Returns newest-first (by created_at), paginated via keyset/cursor
 * pagination rather than OFFSET, so:
 *   - performance does not degrade as the user pages deeper into 200k rows
 *   - pagination stays correct (no duplicates, no skipped rows) even if
 *     products are added or updated while the user is mid-pagination
 *     (see db/schema.sql for the full reasoning)
 */
router.get('/products', async (req, res) => {
  const { category, cursor } = req.query;

  let limit = parseInt(req.query.limit, 10);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_PAGE_SIZE;
  limit = Math.min(limit, MAX_PAGE_SIZE);

  let decodedCursor = null;
  if (cursor) {
    decodedCursor = decodeCursor(cursor);
    if (!decodedCursor) {
      return res.status(400).json({ error: 'Invalid cursor' });
    }
  }

  // Build the query dynamically but safely (parameterized, never string-
  // interpolated) based on whether a category filter and/or cursor is present.
  const conditions = [];
  const params = [];

  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }

  if (decodedCursor) {
    params.push(decodedCursor.createdAt);
    params.push(decodedCursor.id);
    conditions.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Fetch one extra row beyond `limit` so we can tell whether there's a
  // next page without a separate COUNT query (which would be slow on 200k rows).
  params.push(limit + 1);
  const limitParamIndex = params.length;

  const query = `
    SELECT id, name, category, price, created_at, updated_at
    FROM products
    ${whereClause}
    ORDER BY created_at DESC, id DESC
    LIMIT $${limitParamIndex}
  `;

  try {
    const { rows } = await pool.query(query, params);

    const hasNextPage = rows.length > limit;
    const pageRows = hasNextPage ? rows.slice(0, limit) : rows;

    const nextCursor = hasNextPage
      ? encodeCursor(pageRows[pageRows.length - 1].created_at, pageRows[pageRows.length - 1].id)
      : null;

    res.json({
      data: pageRows.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        price: Number(row.price),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      nextCursor,
      hasNextPage,
    });
  } catch (err) {
    console.error('GET /products failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /categories
 *
 * Returns the distinct list of categories, for populating a filter
 * dropdown in the UI. Cheap because there are only ~10 distinct values,
 * even though the underlying table has 200k rows.
 */
router.get('/categories', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT DISTINCT category FROM products ORDER BY category');
    res.json({ categories: rows.map((r) => r.category) });
  } catch (err) {
    console.error('GET /categories failed:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
