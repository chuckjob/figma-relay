// Relay server: tiny localhost task queue.
//
// Two task shapes:
//   { instruction: string }           — natural-language; plugin runs it through its in-plugin Haiku agent
//   { tool: string, input: object }   — direct figma.* tool invocation; plugin executes without an LLM
//
// Endpoints:
//   POST   /tasks?wait=true&timeout=ms   submit a new task; ?wait blocks until terminal state
//   GET    /tasks/next?timeout=ms        long-poll for the next queued task (Figma plugin worker)
//   POST   /tasks/:id/result             worker reports result
//   POST   /tasks/:id/cancel             cancel a queued/running task
//   GET    /tasks/:id                    fetch one task
//   GET    /tasks                        list all tasks
//   GET    /config                       returns ANTHROPIC_API_KEY + model defaults to the plugin
//   GET    /health                       server status

import http from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = process.env.RELAY_PORT ? Number(process.env.RELAY_PORT) : 9226;
const HOST = '127.0.0.1';
const DEFAULT_LONG_POLL_MS = 25_000;
const MAX_TASKS = 500; // ring-buffer cap to keep memory bounded

const tasks = new Map();
const order = []; // insertion order for cleanup
const waiters = []; // pending GET /tasks/next responses

const now = () => new Date().toISOString();

function evictIfNeeded() {
  while (order.length > MAX_TASKS) {
    const oldId = order.shift();
    tasks.delete(oldId);
  }
}

function createTask(fields) {
  const id = randomUUID();
  const task = {
    id,
    kind: fields.kind, // 'instruction' | 'tool'
    instruction: fields.instruction ?? null,
    tool: fields.tool ?? null,
    input: fields.input ?? null,
    meta: fields.meta ?? {},
    status: 'queued',
    createdAt: now(),
    startedAt: null,
    finishedAt: null,
    result: null,
    error: null,
  };
  tasks.set(id, task);
  order.push(id);
  evictIfNeeded();
  return task;
}

// Per-task wait queues for ?wait=true on POST /tasks. Kept off the task object
// so the cached/serialized task shape stays clean.
const taskWaiters = new Map(); // id -> [{ res, timer }]

function addTaskWaiter(id, res, timeoutMs) {
  const w = { res, timer: null };
  w.timer = setTimeout(() => removeTaskWaiter(id, w, true), timeoutMs);
  let list = taskWaiters.get(id);
  if (!list) { list = []; taskWaiters.set(id, list); }
  list.push(w);
}

function removeTaskWaiter(id, w, expired) {
  const list = taskWaiters.get(id);
  if (!list) return;
  const idx = list.indexOf(w);
  if (idx >= 0) list.splice(idx, 1);
  if (list.length === 0) taskWaiters.delete(id);
  if (expired && !w.res.writableEnded) {
    sendJSON(w.res, 408, { error: 'wait timeout', taskId: id });
  }
}

function notifyTaskWaiters(task) {
  const list = taskWaiters.get(task.id);
  if (!list || list.length === 0) return;
  taskWaiters.delete(task.id);
  for (const w of list) {
    clearTimeout(w.timer);
    if (w.res.writableEnded) continue;
    sendJSON(w.res, 200, task);
  }
}

function nextQueuedTask() {
  for (const id of order) {
    const t = tasks.get(id);
    if (t && t.status === 'queued') return t;
  }
  return null;
}

function deliverToWaiter(task) {
  while (waiters.length > 0) {
    const w = waiters.shift();
    clearTimeout(w.timer);
    if (w.res.writableEnded) continue;
    task.status = 'running';
    task.startedAt = now();
    sendJSON(w.res, 200, task);
    return true;
  }
  return false;
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function sendJSON(res, code, body) {
  if (res.writableEnded) return;
  res.writeHead(code, { 'Content-Type': 'application/json', ...CORS_HEADERS });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 1_000_000) throw new Error('payload too large');
  }
  if (!data) return {};
  return JSON.parse(data);
}

function logLine(...args) {
  process.stdout.write(`[${now()}] ${args.join(' ')}\n`);
}

const DEFAULT_MODEL = process.env.RELAY_MODEL || 'claude-haiku-4-5-20251001';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const routes = [
  {
    method: 'GET',
    match: (p) => p === '/config',
    handler: (req, res) => {
      // Loopback-only server, so it's safe to hand the key to the plugin UI
      // iframe (which can't reach process.env on its own).
      if (!ANTHROPIC_API_KEY) {
        return sendJSON(res, 500, { error: 'ANTHROPIC_API_KEY not set in relay server env' });
      }
      sendJSON(res, 200, {
        apiKey: ANTHROPIC_API_KEY,
        model: DEFAULT_MODEL,
        anthropicVersion: '2023-06-01',
      });
    },
  },
  {
    method: 'GET',
    match: (p) => p === '/health',
    handler: (req, res) => {
      sendJSON(res, 200, {
        ok: true,
        port: PORT,
        tasks: tasks.size,
        queued: order.filter((id) => tasks.get(id)?.status === 'queued').length,
        running: order.filter((id) => tasks.get(id)?.status === 'running').length,
        waiters: waiters.length,
      });
    },
  },
  {
    method: 'POST',
    match: (p) => p === '/tasks',
    handler: async (req, res, url) => {
      const body = await readBody(req);
      let fields;
      if (typeof body.tool === 'string' && body.tool.trim()) {
        fields = {
          kind: 'tool',
          tool: body.tool.trim(),
          input: body.input ?? {},
          meta: body.meta,
        };
      } else if (typeof body.instruction === 'string' && body.instruction.trim()) {
        fields = {
          kind: 'instruction',
          instruction: body.instruction.trim(),
          meta: body.meta,
        };
      } else {
        return sendJSON(res, 400, { error: 'either tool (string) + input, or instruction (string), required' });
      }

      const task = createTask(fields);
      const summary = task.kind === 'tool'
        ? `${task.tool} ${JSON.stringify(task.input).slice(0, 80)}`
        : JSON.stringify(task.instruction.slice(0, 80));
      logLine('task.created', task.id, task.kind, summary);

      if (deliverToWaiter(task)) {
        logLine('task.delivered', task.id);
      }

      // ?wait=true → block until the task reaches a terminal state, with a
      // bounded timeout. Useful for MCP-style synchronous tool calls.
      const waitParam = url.searchParams.get('wait');
      if (waitParam === 'true' || waitParam === '1') {
        const timeoutParam = Number(url.searchParams.get('timeout'));
        const timeout = Number.isFinite(timeoutParam) && timeoutParam > 0
          ? Math.min(timeoutParam, 120_000)
          : 60_000;

        // If the task already finished (very fast worker), reply immediately.
        if (['done', 'failed', 'cancelled'].includes(task.status)) {
          return sendJSON(res, 200, task);
        }
        addTaskWaiter(task.id, res, timeout);
        req.on('close', () => {
          if (!res.writableEnded) {
            const list = taskWaiters.get(task.id);
            if (list) {
              const idx = list.findIndex((w) => w.res === res);
              if (idx >= 0) {
                clearTimeout(list[idx].timer);
                list.splice(idx, 1);
                if (list.length === 0) taskWaiters.delete(task.id);
              }
            }
          }
        });
        return;
      }

      sendJSON(res, 201, task);
    },
  },
  {
    method: 'GET',
    match: (p) => p === '/tasks',
    handler: (req, res) => {
      sendJSON(res, 200, {
        tasks: order.map((id) => tasks.get(id)).filter(Boolean),
      });
    },
  },
  {
    method: 'GET',
    match: (p) => p === '/tasks/next',
    handler: (req, res, url) => {
      const timeoutParam = Number(url.searchParams.get('timeout'));
      const timeout = Number.isFinite(timeoutParam) && timeoutParam >= 0
        ? Math.min(timeoutParam, 60_000)
        : DEFAULT_LONG_POLL_MS;

      const queued = nextQueuedTask();
      if (queued) {
        queued.status = 'running';
        queued.startedAt = now();
        logLine('task.taken', queued.id);
        return sendJSON(res, 200, queued);
      }

      if (timeout === 0) return sendJSON(res, 204, {});

      const waiter = { res, timer: null };
      waiter.timer = setTimeout(() => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) waiters.splice(idx, 1);
        sendJSON(res, 204, {});
      }, timeout);
      waiters.push(waiter);

      req.on('close', () => {
        const idx = waiters.indexOf(waiter);
        if (idx >= 0) {
          clearTimeout(waiter.timer);
          waiters.splice(idx, 1);
        }
      });
    },
  },
  {
    method: 'POST',
    match: (p) => /^\/tasks\/[^/]+\/result$/.test(p),
    handler: async (req, res, url) => {
      const id = url.pathname.split('/')[2];
      const task = tasks.get(id);
      if (!task) return sendJSON(res, 404, { error: 'task not found' });
      const body = await readBody(req);
      if (!['done', 'failed'].includes(body.status)) {
        return sendJSON(res, 400, { error: "status must be 'done' or 'failed'" });
      }
      task.status = body.status;
      task.result = body.result ?? null;
      task.error = body.error ?? null;
      task.finishedAt = now();
      logLine('task.result', id, body.status);
      notifyTaskWaiters(task);
      sendJSON(res, 200, task);
    },
  },
  {
    method: 'POST',
    match: (p) => /^\/tasks\/[^/]+\/cancel$/.test(p),
    handler: (req, res, url) => {
      const id = url.pathname.split('/')[2];
      const task = tasks.get(id);
      if (!task) return sendJSON(res, 404, { error: 'task not found' });
      if (task.status === 'done' || task.status === 'failed' || task.status === 'cancelled') {
        return sendJSON(res, 200, task);
      }
      task.status = 'cancelled';
      task.finishedAt = now();
      logLine('task.cancelled', id);
      notifyTaskWaiters(task);
      sendJSON(res, 200, task);
    },
  },
  {
    method: 'GET',
    match: (p) => /^\/tasks\/[^/]+$/.test(p),
    handler: (req, res, url) => {
      const id = url.pathname.split('/')[2];
      const task = tasks.get(id);
      if (!task) return sendJSON(res, 404, { error: 'task not found' });
      sendJSON(res, 200, task);
    },
  },
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS_HEADERS);
    return res.end();
  }
  const route = routes.find((r) => r.method === req.method && r.match(url.pathname));
  if (!route) return sendJSON(res, 404, { error: 'not found' });
  try {
    await route.handler(req, res, url);
  } catch (err) {
    logLine('error', err.message);
    sendJSON(res, 500, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  logLine(`Relay server listening on http://${HOST}:${PORT}`);
});

const shutdown = (sig) => {
  logLine('shutdown', sig);
  for (const w of waiters) {
    clearTimeout(w.timer);
    sendJSON(w.res, 204, {});
  }
  server.close(() => process.exit(0));
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
