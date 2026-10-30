// Fail-closed secret auth for this MCP server (2026-10-30, Bright Engine
// security law rule 1: no service on a public domain without authentication).
//
// The secret is MCP_API_KEY (at least 32 characters). It is accepted two ways,
// so every MCP client can use it:
//   - Authorization: Bearer <MCP_API_KEY>        (Claude Code, scripts)
//   - the URL path  /k/<MCP_API_KEY>/mcp | /sse  (claude.ai connectors, which
//                                                 cannot send a custom header)
// With MCP_API_KEY unset or too short every MCP route answers 503: the server
// never runs open. Only the static health pages stay public. The comparison is
// constant-time (sha256 of both sides, then timingSafeEqual), and the secret
// is never logged.
import crypto from 'crypto';

export const MIN_KEY_LENGTH = 32;

/** The client's address as Railway's edge forwards it (first hop of X-Forwarded-For). */
export function clientIp(req) {
  const fwd = req.get?.('x-forwarded-for') || '';
  return (fwd.split(',')[0] || req.ip || '').trim() || 'unknown';
}

export function createAuth(key = process.env.MCP_API_KEY) {
  const secret = typeof key === 'string' ? key : '';
  const configured = secret.length >= MIN_KEY_LENGTH;
  const expected = crypto.createHash('sha256').update(secret).digest();

  /** Constant-time check of a presented secret. Never true while unconfigured. */
  function matches(given) {
    if (!configured || typeof given !== 'string' || given.length === 0) return false;
    const h = crypto.createHash('sha256').update(given).digest();
    return crypto.timingSafeEqual(h, expected);
  }

  function refuseUnconfigured(res) {
    res.status(503).json({ error: 'MCP auth is not configured on this server (MCP_API_KEY)' });
  }

  /** Middleware: Authorization: Bearer <key>. */
  function bearer(req, res, next) {
    if (!configured) return refuseUnconfigured(res);
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.get('authorization') || '');
    if (m && matches(m[1])) return next();
    console.warn(`[auth] refused ${req.method} (no or bad bearer) from ${clientIp(req)}`);
    res.status(401).set('WWW-Authenticate', 'Bearer').json({ error: 'unauthorized' });
  }

  /** Middleware for routes mounted at /k/:key. A wrong key is a plain 404 (nothing to discover). */
  function pathKey(req, res, next) {
    if (!configured) return refuseUnconfigured(res);
    if (matches(req.params.key)) return next();
    console.warn(`[auth] refused ${req.method} (bad path key) from ${clientIp(req)}`);
    res.status(404).end();
  }

  return { configured, matches, bearer, pathKey };
}
