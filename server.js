import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { spawn } from 'child_process';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN;

if (!RAILWAY_TOKEN) {
  console.error('RAILWAY_TOKEN environment variable is required');
  process.exit(1);
}

const sessions = new Map();

app.get('/healthz', (req, res) => {
  res.send('ok');
});

app.get('/sse', (req, res) => {
  const sessionId = crypto.randomUUID();
  console.log(`[${sessionId}] New SSE connection`);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const child = spawn('npx', ['-y', '@railway/mcp-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, RAILWAY_TOKEN },
  });

  let buffer = '';

  child.stdout.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim()) {
        console.log(`[${sessionId}] Child -> SSE: ${line.substring(0, 200)}`);
        res.write(`event: message\ndata: ${line}\n\n`);
      }
    }
  });

  child.stderr.on('data', (data) => {
    console.error(`[${sessionId}] Child stderr: ${data.toString()}`);
  });

  child.on('close', (code) => {
    console.log(`[${sessionId}] Child exited with code ${code}`);
    sessions.delete(sessionId);
  });

  sessions.set(sessionId, { child, res });

  res.write(`event: endpoint\ndata: /message?sessionId=${sessionId}\n\n`);

  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(keepalive); }
  }, 30000);

  req.on('close', () => {
    console.log(`[${sessionId}] SSE connection closed`);
    clearInterval(keepalive);
    child.kill();
    sessions.delete(sessionId);
  });
});

app.post('/message', (req, res) => {
  const sessionId = req.query.sessionId;
  if (!sessionId) return res.status(400).json({ error: 'Missing sessionId' });

  const session = sessions.get(sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const message = JSON.stringify(req.body);
  console.log(`[${sessionId}] SSE -> Child: ${message.substring(0, 200)}`);
  session.child.stdin.write(message + '\n');
  res.status(202).json({ status: 'accepted' });
});

app.listen(PORT, () => {
  console.log(`MCP Railway SSE server listening on port ${PORT}`);
});
