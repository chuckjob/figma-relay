// Relay plugin sandbox.
//
// Responsibility: receive tool-call requests from the UI iframe, execute them
// with direct figma.* access, post results back. Network and LLM calls live
// in ui.html (sandbox can't fetch).

figma.showUI(__html__, { width: 420, height: 520, title: 'Relay' });

// Tool whitelist: per /Users/chuck.job/projects/relay/DESIGN.md.
// Each handler returns a JSON-serializable result. Errors are caught at the
// dispatch layer below and forwarded back to the UI as { ok: false, error }.
const tools = {
  async 'figma.search_components'({ query, limit = 20 }) {
    await figma.loadAllPagesAsync();
    const out = [];
    const seen = new Set();
    const needle = String(query || '').toLowerCase();
    for (const page of figma.root.children) {
      const matches = page.findAll((n) =>
        (n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') &&
        (!needle || n.name.toLowerCase().includes(needle))
      );
      for (const n of matches) {
        if (seen.has(n.id)) continue;
        seen.add(n.id);
        out.push({ id: n.id, name: n.name, type: n.type, page: page.name });
        if (out.length >= limit) return { components: out };
      }
    }
    return { components: out };
  },

  async 'figma.find_node'({ id }) {
    const n = await figma.getNodeByIdAsync(id);
    if (!n) return { found: false };
    return {
      found: true,
      id: n.id,
      name: n.name,
      type: n.type,
      width: 'width' in n ? n.width : null,
      height: 'height' in n ? n.height : null,
      childCount: 'children' in n ? n.children.length : 0,
    };
  },

  async 'figma.export_node'({ id, format = 'PNG', scale = 1 }) {
    const n = await figma.getNodeByIdAsync(id);
    if (!n || !('exportAsync' in n)) return { error: 'node not exportable' };
    const bytes = await n.exportAsync({ format, constraint: { type: 'SCALE', value: scale } });
    // Return base64 — UI iframe forwards to relay or to user as needed.
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return { format, base64: btoa(bin), byteLength: bytes.length };
  },

  async 'figma.set_text'({ id, text }) {
    const n = await figma.getNodeByIdAsync(id);
    if (!n || n.type !== 'TEXT') return { error: 'node is not TEXT' };
    await figma.loadFontAsync(n.fontName);
    n.characters = String(text);
    return { ok: true };
  },

  async 'figma.set_fills'({ id, fills }) {
    const n = await figma.getNodeByIdAsync(id);
    if (!n || !('fills' in n)) return { error: 'node has no fills' };
    n.fills = fills;
    return { ok: true };
  },

  async 'figma.set_strokes'({ id, strokes }) {
    const n = await figma.getNodeByIdAsync(id);
    if (!n || !('strokes' in n)) return { error: 'node has no strokes' };
    n.strokes = strokes;
    return { ok: true };
  },

  async 'figma.set_instance_properties'({ id, properties }) {
    const n = await figma.getNodeByIdAsync(id);
    if (!n || n.type !== 'INSTANCE') return { error: 'node is not INSTANCE' };
    n.setProperties(properties);
    return { ok: true };
  },

  // Escape hatch: run arbitrary plugin-API code. Use sparingly — the whole
  // point of Relay is to avoid this for routine work.
  async 'figma.execute'({ code }) {
    const fn = new Function('figma', `return (async () => { ${code} })();`);
    const result = await fn(figma);
    return { result: serialize(result) };
  },
};

function serialize(v) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v;
  if (Array.isArray(v)) return v.map(serialize);
  if (typeof v === 'object') {
    try { return JSON.parse(JSON.stringify(v)); } catch (e) { return String(v); }
  }
  return String(v);
}

figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.kind === 'resize') {
    const w = Math.max(320, Math.min(1200, Number(msg.width) || 480));
    const h = Math.max(320, Math.min(1600, Number(msg.height) || 720));
    figma.ui.resize(w, h);
    return;
  }

  if (msg.kind === 'storage_get') {
    const { callId, key } = msg;
    try {
      const value = await figma.clientStorage.getAsync(key);
      figma.ui.postMessage({ kind: 'storage_result', callId, ok: true, value });
    } catch (err) {
      figma.ui.postMessage({ kind: 'storage_result', callId, ok: false, error: err.message || String(err) });
    }
    return;
  }

  if (msg.kind === 'storage_set') {
    const { callId, key, value } = msg;
    try {
      await figma.clientStorage.setAsync(key, value);
      figma.ui.postMessage({ kind: 'storage_result', callId, ok: true });
    } catch (err) {
      figma.ui.postMessage({ kind: 'storage_result', callId, ok: false, error: err.message || String(err) });
    }
    return;
  }

  if (msg.kind === 'storage_delete') {
    const { callId, key } = msg;
    try {
      await figma.clientStorage.deleteAsync(key);
      figma.ui.postMessage({ kind: 'storage_result', callId, ok: true });
    } catch (err) {
      figma.ui.postMessage({ kind: 'storage_result', callId, ok: false, error: err.message || String(err) });
    }
    return;
  }

  if (msg.kind === 'tool_call') {
    const { callId, name, input } = msg;
    const handler = tools[name];
    if (!handler) {
      figma.ui.postMessage({ kind: 'tool_result', callId, ok: false, error: `unknown tool: ${name}` });
      return;
    }
    try {
      const result = await handler(input || {});
      figma.ui.postMessage({ kind: 'tool_result', callId, ok: true, result });
    } catch (err) {
      figma.ui.postMessage({ kind: 'tool_result', callId, ok: false, error: err.message || String(err) });
    }
    return;
  }
};
