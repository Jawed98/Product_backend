/**
 * Keyset pagination cursor encoding.
 *
 * The cursor represents "the last row the client saw": its created_at and
 * id. We base64-encode it into a single opaque string so:
 *   - the client doesn't need to know/care about our internal pagination
 *     mechanics, it just passes back whatever `nextCursor` we gave it.
 *   - we're free to change the cursor's internal shape later without
 *     breaking API compatibility (it's an opaque token, not a documented
 *     parameter format).
 */

function encodeCursor(createdAt, id) {
  const payload = JSON.stringify({ createdAt: new Date(createdAt).toISOString(), id: Number(id) });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function decodeCursor(cursorStr) {
  try {
    const json = Buffer.from(cursorStr, 'base64url').toString('utf8');
    const { createdAt, id } = JSON.parse(json);
    if (!createdAt || !Number.isFinite(id)) return null;
    return { createdAt, id };
  } catch {
    return null; // malformed cursor — caller should treat as a bad request
  }
}

module.exports = { encodeCursor, decodeCursor };
