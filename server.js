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
  return res.json();
}

// MCP tool definitions
const TOOLS = [
  {
    name: 'list-projects',
    description: 'List all Railway projects',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'list-services',
    description: 'List all services for a project',
    inputSchema: {
      type: 'object',
      properties: { projectId: { type: 'string', description: 'Railway project ID' } },
      required: ['projectId'],
    },
  },
  {
    name: 'get-deploy-logs',
    description: 'Get recent deployment logs for a service',
    inputSchema: {
      type: 'object',
      properties: {
        deploymentId: { type: 'string', description: 'Deployment ID' },
      },
      required: ['deploymentId'],
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
    name: 'list-variables',
    description: 'List environment variables for a service',
    inputSchema: {
      type: 'object',
      properties: {
        serviceId: { type: 'string', description: 'Service ID' },
        environmentId: { type: 'string', description: 'Environment ID' },
        projectId: { type: 'string', description: 'Project ID' },
      },
      required: ['serviceId', 'environmentId', 'projectId'],
    },
  },
];

async function handleToolCall(name, args) {
  switch (name) {
    case 'list-projects': {
      const data = await railwayQuery(`
        query { me { projects { edges { node { id name updatedAt environments { edges { node { id name } } } } } } } }
      `);
      const projects = data?.data?.me?.projects?.edges?.map(e => ({
        id: e.node.id,
        name: e.node.name,
        updatedAt: e.node.updatedAt,
        environments: e.node.environments?.edges?.map(env => ({ id: env.node.id, name: env.node.name })),
      })) || [];
      return JSON.stringify(projects, null, 2);
    }
    case 'list-services': {
      const data = await railwayQuery(`
        query($projectId: String!) {
          project(id: $projectId) {
            services { edges { node { id name updatedAt } } }
          }
        }
      `, { projectId: args.projectId });
      const services = data?.data?.project?.services?.edges?.map(e => ({
        id: e.node.id,
        name: e.node.name,
        updatedAt: e.node.updatedAt,
      })) || [];
      return JSON.stringify(services, null, 2);
    }
    case 'list-deployments': {
      const data = await railwayQuery(`
        query($serviceId: String!, $environmentId: String!) {
          deployments(first: 10, input: { serviceId: $serviceId, environmentId: $environmentId }) {
            edges { node { id status createdAt updatedAt } }
          }
        }
      `, { serviceId: args.serviceId, environmentId: args.environmentId });
      const deployments = data?.data?.deployments?.edges?.map(e => ({
        id: e.node.id,
        status: e.node.status,
        createdAt: e.node.createdAt,
        updatedAt: e.node.updatedAt,
      })) || [];
      return JSON.stringify(deployments, null, 2);
    }
    case 'get-deploy-logs': {
      const data = await railwayQuery(`
        query($deploymentId: String!) {
          deploymentLogs(deploymentId: $deploymentId, limit: 100) {
            message timestamp severity
          }
        }
      `, { deploymentId: args.deploymentId });
      const logs = data?.data?.deploymentLogs || [];
      return logs.map(l => `[${l.severity}] ${l.timestamp} ${l.message}`).join('\n') || 'No logs found';
    }
    case 'list-variables': {
      const data = await railwayQuery(`
        query($projectId: String!, $serviceId: String!, $environmentId: String!) {
          variables(projectId: $projectId, serviceId: $serviceId, environmentId: $environmentId)
        }
      `, { projectId: args.projectId, serviceId: args.serviceId, environmentId: args.environmentId });
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

// Sessions
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
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'railway-graphql-mcp', version: '1.0.0' },
      },
    };
  } else if (msg.method === 'notifications/initialized') {
    res.status(202).json({ status: 'accepted' });
    return;
  } else if (msg.method === 'tools/list') {
    response = {
      jsonrpc: '2.0',
      id: msg.id,
      result: { tools: TOOLS },
    };
  } else if (msg.method === 'tools/call') {
    const toolName = msg.params?.name;
    const toolArgs = msg.params?.arguments || {};
    try {
      const result = await handleToolCall(toolName, toolArgs);
      response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: result }], isError: false },
      };
    } catch (err) {
      response = {
        jsonrpc: '2.0',
        id: msg.id,
        result: { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true },
      };
    }
  } else {
    response = {
      jsonrpc: '2.0',
      id: msg.id,
      error: { code: -32601, message: `Method not found: ${msg.method}` },
    };
  }

  if (response) {
    const data = JSON.stringify(response);
    console.log(`[${sessionId}] Sending: ${data.substring(0, 200)}`);
    session.res.write(`event: message\ndata: ${data}\n\n`);
  }

  res.status(202).json({ status: 'accepted' });
});

app.listen(PORT, () => {
  console.log(`MCP Railway GraphQL server listening on port ${PORT}`);
});
