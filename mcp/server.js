#!/usr/bin/env node
// MCP server: exposes Relay's figma.* tools to Claude Code over stdio.
//
// Each tool call here translates to:
//   POST {RELAY_URL}/tasks?wait=true&timeout=60000
//   { tool: 'figma.search_components', input: { ... } }
// The Relay server queues the task, the Figma plugin worker picks it up,
// executes via the Plugin API, and reports the result back. We block until
// terminal state, then return the result to Claude Code.
//
// Configure in ~/.claude/mcp.json (or a project's .claude/mcp.json):
//   {
//     "mcpServers": {
//       "relay": { "command": "node", "args": ["/path/to/relay/mcp/server.js"] }
//     }
//   }

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const RELAY_URL = process.env.RELAY_URL || 'http://127.0.0.1:9226';
const WAIT_TIMEOUT_MS = Number(process.env.RELAY_WAIT_TIMEOUT_MS) || 60_000;

const TOOLS = [
  {
    name: 'figma_search_components',
    description:
      'Search COMPONENT and COMPONENT_SET nodes in the currently-open Figma file by name. ' +
      'Use this to find atoms (Button, Chip, etc.) before inspecting or editing them.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to match against component names (case-insensitive). Empty matches all.' },
        limit: { type: 'integer', description: 'Max number of results to return (default 20).', minimum: 1, maximum: 200 },
      },
      required: ['query'],
    },
    figmaName: 'figma.search_components',
  },
  {
    name: 'figma_find_node',
    description: 'Look up a single node by its Figma node id. Returns name, type, dimensions, and child count.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Figma node id, e.g. "123:45".' } },
      required: ['id'],
    },
    figmaName: 'figma.find_node',
  },
  {
    name: 'figma_export_node',
    description: 'Export a node to PNG/JPG/SVG/PDF. Returns base64-encoded bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Node id to export.' },
        format: { type: 'string', enum: ['PNG', 'JPG', 'SVG', 'PDF'], description: 'Export format (default PNG).' },
        scale: { type: 'number', description: 'Pixel scale multiplier (default 1).', minimum: 0.1, maximum: 4 },
      },
      required: ['id'],
    },
    figmaName: 'figma.export_node',
  },
  {
    name: 'figma_set_text',
    description: 'Replace the characters of a TEXT node. Loads the required font automatically.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'TEXT node id.' },
        text: { type: 'string', description: 'New character content.' },
      },
      required: ['id', 'text'],
    },
    figmaName: 'figma.set_text',
  },
  {
    name: 'figma_set_fills',
    description: 'Set the fills array on a node (any node type with a fills property).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        fills: { type: 'array', description: 'Figma Paint[] (e.g. [{ type: "SOLID", color: { r: 1, g: 0, b: 0 } }]).' },
      },
      required: ['id', 'fills'],
    },
    figmaName: 'figma.set_fills',
  },
  {
    name: 'figma_set_strokes',
    description: 'Set the strokes array on a node (any node type with a strokes property).',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        strokes: { type: 'array', description: 'Figma Paint[].' },
      },
      required: ['id', 'strokes'],
    },
    figmaName: 'figma.set_strokes',
  },
  {
    name: 'figma_set_instance_properties',
    description: 'Set component-instance properties (variant, boolean, text, instance-swap) on an INSTANCE node.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'INSTANCE node id.' },
        properties: { type: 'object', description: 'Map of property name → value. Property names must match the component definition.' },
      },
      required: ['id', 'properties'],
    },
    figmaName: 'figma.set_instance_properties',
  },
  {
    name: 'figma_execute',
    description:
      'Escape hatch: run an arbitrary async snippet inside the Figma plugin sandbox. ' +
      'The snippet has access to the global `figma` object. Use only when no specific tool fits.',
    inputSchema: {
      type: 'object',
      properties: {
        code: { type: 'string', description: 'Async function body. Must `return` a JSON-serializable value.' },
      },
      required: ['code'],
    },
    figmaName: 'figma.execute',
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

async function dispatchToRelay(figmaName, input) {
  const url = `${RELAY_URL}/tasks?wait=true&timeout=${WAIT_TIMEOUT_MS}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: figmaName, input }),
    });
  } catch (err) {
    throw new Error(`Relay unreachable at ${RELAY_URL}: ${err.message}`);
  }

  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }

  if (res.status === 408) {
    throw new Error(`Timed out waiting ${WAIT_TIMEOUT_MS}ms for the Figma plugin to execute "${figmaName}". Is the plugin open and worker mode on?`);
  }
  if (!res.ok) {
    throw new Error(`Relay ${res.status}: ${body.error || text}`);
  }
  if (body.status === 'failed') {
    throw new Error(`Plugin reported failure: ${body.error || 'unknown'}`);
  }
  if (body.status === 'cancelled') {
    throw new Error('Task was cancelled before completion.');
  }
  return body.result;
}

const server = new Server(
  { name: 'relay', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS_BY_NAME.get(req.params.name);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }],
    };
  }
  try {
    const result = await dispatchToRelay(tool.figmaName, req.params.arguments || {});
    return {
      content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: 'text', text: err.message || String(err) }],
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
