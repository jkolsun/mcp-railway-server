import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN;
// Optional — required only for the get-logs tool, which resolves services by
// name within a single pre-configured project. All other tools take explicit
// projectId/serviceId/environmentId args and don't need these.
const RAILWAY_PROJECT_ID = process.env.RAILWAY_PROJECT_ID || null;
const RAILWAY_ENVIRONMENT_NAME = process.env.RAILWAY_ENVIRONMENT_NAME || 'production';

if (!RAILWAY_TOKEN) {
  console.error('RAILWAY_TOKEN environment variable is required');
  process.exit(1);
}

const RAILWAY_API = 'https://backboard.railway.com/graphql/v2';

async function railwayQuery(query, variables = {}) {
  const res = await fetch(RAILWAY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${RAILWAY_TOKEN}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) {
    console.error('GraphQL errors:', JSON.stringify(data.errors));
  }
  return data;
}

// Parse a duration like "15m", "30m", "1h", "6h", "24h" into an ISO start date.
function parseTimeRange(s) {
  const m = typeof s === 'string' && s.match(/^(\d+)(m|h)$/i);
  if (!m) {
    throw new Error(`Invalid time_range "${s}". Examples: "15m", "30m", "1h", "6h", "24h"`);
  }
  const n = parseInt(m[1], 10);
  const unitMs = m[2].toLowerCase() === 'm' ? 60_000 : 3_600_000;
  return new Date(Date.now() - n * unitMs).toISOString();
}

// Cache project context for 60s. The list of services rarely changes; this
// saves one GraphQL round-trip on every get-logs call after the first.
let projectCache = null;
let projectCacheAt = 0;
const PROJECT_CACHE_TTL_MS = 60_000;

async function getProjectContext() {
  const now = Date.now();
  if (projectCache && (now - projectCacheAt) < PROJECT_CACHE_TTL_MS) return projectCache;
  if (!RAILWAY_PROJECT_ID) {
    throw new Error(
      'RAILWAY_PROJECT_ID env var is not set. The get-logs tool resolves services by name within a single project — set RAILWAY_PROJECT_ID on the MCP server deployment to the project you want to query.'
    );
  }
  const data = await railwayQuery(
    `query project($id: String!) { project(id: $id) { id name services { edges { node { id name } } } environments { edges { node { id name } } } } }`,
    { id: RAILWAY_PROJECT_ID }
  );
  if (data.errors) throw new Error(`Railway API error: ${JSON.stringify(data.errors)}`);
  if (!data?.data?.project) throw new Error(`Project "${RAILWAY_PROJECT_ID}" not found`);
  const p = data.data.project;
  const services = p.services?.edges?.map(e => e.node) || [];
  const environments = p.environments?.edges?.map(e => e.node) || [];
  const environment =
    environments.find(e => e.name.toLowerCase() === RAILWAY_ENVIRONMENT_NAME.toLowerCase()) ||
    environments[0];
  if (!environment) throw new Error(`No environment found in project "${p.name}"`);
  projectCache = { project: p, services, environment };
  projectCacheAt = now;
  return projectCache;
}

async function resolveServiceByName(name) {
  const ctx = await getProjectContext();
  const svc = ctx.services.find(s => s.name.toLowerCase() === String(name).toLowerCase());
  if (!svc) {
    const available = ctx.services.map(s => s.name).join(', ') || '(none)';
    throw new Error(`Service "${name}" not found in project "${ctx.project.name}". Available: ${available}`);
  }
  return { service: svc, environment: ctx.environment };
}

async function getActiveDeployment(serviceId, environmentId) {
  const data = await railwayQuery(
    `query deployments($input: DeploymentListInput!) { deployments(input: $input, first: 5) { edges { node { id status createdAt } } } }`,
    { input: { serviceId, environmentId } }
  );
  if (data.errors) throw new Error(`Railway API error: ${JSON.stringify(data.errors)}`);
  const deps = data?.data?.deployments?.edges?.map(e => e.node) || [];
  if (deps.length === 0) throw new Error('Service has no deployments');
  // Newest first — Railway usually returns that order but sort defensively.
  deps.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return deps[0];
}

const TOOLS = [
  {
    name: 'list-projects',
    description: 'List all Railway projects for the authenticated account',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get-project',
    description: 'Get a project by ID with its services and environments',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Railway project ID' } },
      required: ['projectId'],
    },
  },
  {
    name: 'list-deployments',
    description: 'List recent deployments for a service in an environment',
    inputSchema: {
      type: 'object',
      properties: {
        serviceId: { type: 'string', description: 'Service ID' },
        environmentId: { type: 'string', description: 'Environment ID' },
      },
      required: ['serviceId', 'environmentId'],
    },
  },
  {
    name: 'get-deployment-logs',
    description: 'Get logs for a specific deployment',
    inputSchema: {
      type: 'object',
      properties: {
        deploymentId: { type: 'string', description: 'Deployment ID' },
        limit: { type: 'number', description: 'Number of log lines (default 100)' },
      },
      required: ['deploymentId'],
    },
  },
  {
    name: 'get-variables',
    description: 'List environment variables for a service (values masked)',
    inputSchema: {
      type: 'object',
      properties: {
        projectId: { type: 'string', description: 'Project ID' },
        environmentId: { type: 'string', description: 'Environment ID' },
        serviceId: { type: 'string', description: 'Service ID' },
      },
      required: ['projectId', 'environmentId', 'serviceId'],
    },
  },
  {
    name: 'get-logs',
    description: 'Pull recent logs for a service by name (e.g. "worker", "bright_engine") without needing a deployment ID. Resolves the current active deployment in the configured RAILWAY_PROJECT_ID + environment, then filters by time range, optional grep substring, and optional lead_id. Use this when investigating a live incident — prefer it over get-deployment-logs.',
    inputSchema: {
      type: 'object',
      properties: {
        service: { type: 'string', description: 'Service name on Railway (case-insensitive, matched exactly).' },
        time_range: { type: 'string', description: 'How far back to look. Format: "15m", "30m", "1h", "6h", "24h". Default "1h".' },
        grep: { type: 'string', description: 'Case-insensitive substring filter. Only log lines containing this string are returned.' },
        lead_id: { type: 'string', description: 'Additional filter ANDed with grep — only lines containing this lead ID are returned. Useful for tracing one lead through the system.' },
        limit: { type: 'number', description: 'Max lines returned. Default 500, hard cap 2000.' },
      },
      required: ['service'],
    },
  },
];

async function handleToolCall(name, args) {
  switch (name) {
    case 'list-projects': {
      const data = await railwayQuery(`query { projects { edges { node { id name updatedAt environments { edges { node { id name } } } } } } }`);
      if (data.errors) return JSON.stringify({ error: data.errors }, null, 2);
      const projects = data?.data?.projects?.edges?.map(e => ({
        id: e.node.id,
        name: e.node.name,
        updatedAt: e.node.updatedAt,
        environments: e.node.environments?.edges?.map(env => ({ id: env.node.id, name: env.node.name })),
      })) || [];
      return JSON.stringify(projects, null, 2);
    }
    case 'get-project': {
      const data = await railwayQuery(
        `query project($id: String!) { project(id: $id) { id name services { edges { node { id name } } } environments { edges { node { id name } } } } }`,
        { id: args.projectId }
      );
      if (data.errors) return JSON.stringify({ error: data.errors }, null, 2);
      const p = data?.data?.project;
      if (!p) return JSON.stringify({ error: 'Project not found' });
      return JSON.stringify({
        id: p.id,
        name: p.name,
        services: p.services?.edges?.map(e => ({ id: e.node.id, name: e.node.name })) || [],
        environments: p.environments?.edges?.map(e => ({ id: e.node.id, name: e.node.name })) || [],
      }, null, 2);
    }
    case 'list-deployments': {
      const data = await railwayQuery(
        `query deployments($input: DeploymentListInput!) { deployments(input: $input, first: 10) { edges { node { id status createdAt } } } }`,
        { input: { serviceId: args.serviceId, environmentId: args.environmentId } }
      );
      if (data.errors) return JSON.stringify({ error: data.errors }, null, 2);
      const deps = data?.data?.deployments?.edges?.map(e => e.node) || [];
      return JSON.stringify(deps, null, 2);
    }
    case 'get-deployment-logs': {
      const data = await railwayQuery(
        `query deploymentLogs($deploymentId: String!, $limit: Int) { deploymentLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity } }`,
        { deploymentId: args.deploymentId, limit: args.limit || 100 }
      );
      if (data.errors) return JSON.stringify({ error: data.errors }, null, 2);
      const logs = data?.data?.deploymentLogs || [];
      if (logs.length === 0) return 'No logs found for this deployment.';
      return logs.map(l => `[${l.severity || 'INFO'}] ${l.timestamp} ${l.message}`).join('\n');
    }
    case 'get-variables': {
      const data = await railwayQuery(
        `query variables($projectId: String!, $environmentId: String!, $serviceId: String) { variables(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) }`,
        { projectId: args.projectId, environmentId: args.environmentId, serviceId: args.serviceId }
      );
      if (data.errors) return JSON.stringify({ error: data.errors }, null, 2);
      const vars = data?.data?.variables || {};
      const masked = Object.fromEntries(
        Object.entries(vars).map(([k, v]) => [k, typeof v === 'string' && v.length > 8 ? v.slice(0, 4) + '****' : v])
      );
      return JSON.stringify(masked, null, 2);
    }
    case 'get-logs': {
      const service = args.service;
      const time_range = args.time_range || '1h';
      const grep = args.grep;
      const lead_id = args.lead_id;
      const limit = Math.min(Math.max(1, parseInt(args.limit, 10) || 500), 2000);

      if (!service || typeof service !== 'string') {
        return JSON.stringify({ error: 'service is required' }, null, 2);
      }

      let startDateIso;
      try { startDateIso = parseTimeRange(time_range); }
      catch (e) { return JSON.stringify({ error: e.message }, null, 2); }

      let resolved;
      try { resolved = await resolveServiceByName(service); }
      catch (e) { return JSON.stringify({ error: e.message }, null, 2); }

      let deployment;
      try { deployment = await getActiveDeployment(resolved.service.id, resolved.environment.id); }
      catch (e) { return JSON.stringify({ error: `Service "${service}" has no active deployment: ${e.message}` }, null, 2); }

      // Fetch a generous window and filter client-side so we don't depend on
      // server-side time-range args the GraphQL schema may or may not expose.
      // 5000 is Railway's practical cap for deploymentLogs.
      const FETCH_LIMIT = 5000;
      const logData = await railwayQuery(
        `query deploymentLogs($deploymentId: String!, $limit: Int) { deploymentLogs(deploymentId: $deploymentId, limit: $limit) { timestamp message severity } }`,
        { deploymentId: deployment.id, limit: FETCH_LIMIT }
      );
      if (logData.errors) {
        const rateLimited = logData.errors.some(e => /rate limit|429|too many requests/i.test(e?.message || ''));
        if (rateLimited) {
          return JSON.stringify({ error: 'Railway API rate limit exceeded — back off and retry in a few seconds.' }, null, 2);
        }
        return JSON.stringify({ error: `Railway API error: ${JSON.stringify(logData.errors)}` }, null, 2);
      }

      const raw = logData?.data?.deploymentLogs || [];
      const startMs = new Date(startDateIso).getTime();

      // Filter by time window + grep + lead_id. All filters are case-insensitive.
      const grepLower = grep ? String(grep).toLowerCase() : null;
      const leadLower = lead_id ? String(lead_id).toLowerCase() : null;
      const filtered = [];
      for (const l of raw) {
        const tsMs = new Date(l.timestamp).getTime();
        if (Number.isFinite(tsMs) && tsMs < startMs) continue;
        const msg = (l.message || '');
        if (grepLower && !msg.toLowerCase().includes(grepLower)) continue;
        if (leadLower && !msg.toLowerCase().includes(leadLower)) continue;
        filtered.push(l);
      }

      // Sort ascending by timestamp.
      filtered.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

      const truncated = filtered.length > limit;
      // When truncating, prefer the most recent lines — they're the ones most
      // likely to matter when investigating an incident.
      const capped = truncated ? filtered.slice(-limit) : filtered;

      const lines = capped.map(l => ({
        timestamp: l.timestamp,
        level: (l.severity || 'info').toLowerCase(),
        message: l.message,
      }));

      return JSON.stringify({
        service,
        time_range,
        matched: lines.length,
        truncated,
        lines,
      }, null, 2);
    }
    default:
      return JSON.stringify({ error: `Unknown tool: ${name}` });
  }
}

const sessions = new Map();

app.get('/healthz', (req, res) => res.send('ok'));

app.get('/sse', (req, res) => {
  const sessionId = crypto.randomUUID();
  console.log(`[${sessionId}] New SSE connection`);
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  sessions.set(sessionId, { res, initialized: false });
  res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(keepalive); }
  }, 30000);
  req.on('close', () => {
    console.log(`[${sessionId}] SSE connection closed`);
    clearInterval(keepalive);
    sessions.delete(sessionId);
  });
});

app.post('/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const msg = req.body;
  console.log(`[${sessionId}] Received: ${msg.method} id=${msg.id}`);
  let response;

  if (msg.method === 'initialize') {
    session.initialized = true;
    response = {
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'railway-graphql-mcp', version: '1.0.0' },
      },
    };
  } else if (msg.method === 'notifications/initialized') {
    return res.status(202).json({ status: 'accepted' });
  } else if (msg.method === 'tools/list') {
    response = { jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } };
  } else if (msg.method === 'tools/call') {
    try {
      const result = await handleToolCall(msg.params?.name, msg.params?.arguments || {});
      response = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: result }], isError: false } };
    } catch (err) {
      response = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true } };
    }
  } else {
    response = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }

  if (response) {
    session.res.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
  }
  res.status(202).json({ status: 'accepted' });
});

app.listen(PORT, () => console.log(`MCP Railway GraphQL server listening on port ${PORT}`));
