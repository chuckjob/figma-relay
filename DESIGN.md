# Smart Figma Agent — design sketch

## The problem with today's bridge

The current `claude-bridge-figma` + `figma-console-mcp` stack is a **dumb RPC**: I send `figma_execute({ code: "..." })`, the plugin runs it, returns the result. For any multi-step task that's 10–30 round-trips. Each round-trip has to traverse:

```
Claude Code → MCP server (port 9223) → WebSocket → Figma plugin sandbox → eval → response back
```

Every link is fragile. The plugin iframe wedges. The MCP server gets stale. Two Claude apps spawn duplicate MCP servers and one squats 9223. Recovery means fixing the watchdog, the MCP server, and the plugin in concert.

## The proposal

Keep Claude Code as the orchestrator (full tools, memory, cross-tool knowledge). Replace the dumb-RPC bridge with a **smart in-Figma agent**: I send one high-level instruction, the agent interprets it and runs many `figma.*` operations in-process, returns one summary.

```
Claude Code (Opus, full tools)
  │
  │ task: "Rebind unbound fills on this page to closest
  │        Foundry tokens. Skip pastel diversity art."
  ↓
Figma Plugin Agent (Haiku, narrow tools)
  ├── Claude API client (anthropic-sdk)
  ├── Tool surface: figma.* APIs only
  ├── UI panel: chat log + tasks list
  └── Two-way conversation (agent can ask back)
  ↓ figma.* in-process
Figma Plugin Runtime
```

## Why this beats today

- **One instruction-trip per task instead of N.** Wedge surface area shrinks proportionally.
- **Recovery is "click Run again on the plugin"** — no MCP server dance, no port squatting, no watchdog.
- **Failure isolation.** If the Figma plugin wedges, only Figma work breaks. GitLab, Slack, base-ui, shell still work.
- **Two-way conversation in Figma.** Agent can ask Chuck clarifying questions ("did you mean dark or light mode bindings?"); Chuck can drop instructions directly without going through Claude Code.
- **Cheaper than it looks.** Use Haiku for the in-Figma agent — the work is mechanical (figma.* calls), not strategic. Opus stays as orchestrator.

## What it doesn't fix

Figma still kills plugin iframes. The agent plugin can wedge the same way the Bridge plugin does today. The win is that the failure surface is one plugin instead of three coupled processes, and recovery is local (re-run the plugin) instead of distributed (kill MCP, restart watchdog, force reopen).

## Transport

The plugin sandbox can't open ports — only `fetch()` to a manifest-allowlisted host. So Claude Code runs a tiny HTTP relay (~50 lines of Node or Swift) on `localhost:9224` that:

1. Holds a queue of tasks Claude Code has posted
2. Plugin polls every 2s for new tasks (long-poll OK)
3. Plugin posts results back when each task finishes

Why this is robust: tasks live on the Claude Code side. If the plugin restarts mid-task, it just polls again and picks up where it left off. No tight coupling to a session, no WebSocket handshake to wedge.

## MVP scope

**Plugin UI**
- Chat panel: input box at bottom, scrolling task log above
- Each task shows: instruction, status (queued/running/done/failed), inline summary
- Stop button to cancel the in-flight task

**Agent tool whitelist** (what Haiku can call)
- `figma.search_components(query)`
- `figma.find_node(predicate)`
- `figma.export_node(id)` for Claude to "see" what it just changed
- `figma.set_text`, `figma.set_fills`, `figma.set_strokes`, `figma.set_instance_properties`
- `figma.execute(code)` as the escape hatch for things the typed surface doesn't cover

**Constraints**
- One task at a time (Figma's plugin API isn't reliably concurrent-safe)
- One file at a time (multi-file is v2)
- API key stored in a local config file under `~/.figma-smart-agent/`
- Stack traces captured and returned as part of the task summary

## What we don't build in MVP

- Cross-file work
- Streaming tool calls (batch summaries are fine)
- Auto-update for the plugin (load it as a Development plugin like today)
- Memory sharing with Claude Code (keeps the agent stateless and simple)

## First test task

> "Audit the SearchableSelect (recipes) page: which fills are unbound, bucket them by chrome / inside-atom / decorative, report counts."

If the agent can do that with one instruction-trip — instead of me firing 30 `figma_execute` calls — MVP is proven.

## Open questions

- Does this **replace** `claude-bridge-figma` or **supplement** it? (lean: replace, eventually)
- API key storage: env file vs Figma plugin clientStorage?
- How do we handle the case where the plugin asks back and Chuck is AFK? Time out the task and drop to the inbox?
- Naming: this is no longer "Bridge." Maybe `claude-figma-agent` or `figma-copilot-bridge`.

## Build estimate

- HTTP relay (Node, ~50 lines): half-day
- Plugin scaffold + UI (~150 lines TS + manifest): 1 day
- Anthropic SDK integration + tool whitelist (~100 lines): half-day
- End-to-end test on the first task above: half-day

Total: ~2.5 days for a working MVP that can replace the most painful 80% of today's `figma_execute` round-trips.
