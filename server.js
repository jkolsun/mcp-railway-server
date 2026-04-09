import express from 'express';
import cors from 'cors';
import crypto from 'crypto';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN;

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
