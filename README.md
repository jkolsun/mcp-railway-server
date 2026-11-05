# mcp-railway-server
## Authentication (required — fail closed, 2026-10-30)

Every MCP route requires the secret `MCP_API_KEY` (at least 32 characters; `openssl rand -hex 32`). Without it every MCP route answers 503 — the server never runs open. Only the health page is public.

- claude.ai connector URL: `https://<domain>/k/<MCP_API_KEY>/mcp` (or `/k/<MCP_API_KEY>/sse` for the SSE servers)
- any client that can send a header: `Authorization: Bearer <MCP_API_KEY>` on the bare paths

A wrong key in the path is a plain 404; a missing or wrong bearer is also a plain 404 (never a 401, which would make claude.ai try an OAuth login). Every /.well-known/* path is a 404. The key is compared in constant time and never logged; each request logs its JSON-RPC method, tool name and client IP for audits.
