# AGENTS.md - SESCLICK v2

Guidelines for AI agents working on this codebase.

## Project Overview

SESCLICK v2 is a V2-native (`Plugin.define({ id: "sesclick", setup })`, `@opencode/plugin@2.0.27`) port of the browser-annotation tool: it sends browser annotations into OpenCode via an OpenCode **plugin**, backed by a Chrome/Chromium **extension**.

Transport is ONLY `ctx.session.prompt`. Sessions come from an event-sourced registry (`session.created/updated/deleted` via `ctx.event.subscribe()`, enriched with `ctx.session.get`, persisted in `ctx.storage`). There is NO `ctx.session.list` in the V2 plugin API — do not reintroduce it.

Architecture:

```
Chrome Extension <-> Local HTTP server in each OpenCode Plugin instance
```

Components:

1. **Plugin** (`src/plugin.ts`) - OpenCode V2 plugin that serves local HTTP endpoints for status/session/claim/annotation
2. **Extension** (`extension-src/` built to `extension/`) - discovers plugin instances on localhost ports and sends annotation payloads

Agent-facing diagnostic tools: `sesclick_status` (primary) + alias `chrome_status`.

## Build & Run Commands

```bash
# Install dependencies
bun install

# Typecheck
bun run typecheck   # tsc --noEmit

# Build the plugin
bun run build       # bun build src/plugin.ts --target=node --outfile=dist/plugin.js

# Build the extension (extension-src/ -> extension/)
bun run build:extension

# Validate the built extension
npm run check:extension
```

## Testing Changes

E2E on a fresh `opencode` (v2.0.27+):

1. Load the unpacked `extension/` in `chrome://extensions`.
2. Link a tab to a picked session (Linked badge).
3. Queue 2 annotations, hit Send all.
4. Verify arrival in the picked session only, cropped screenshot files exist, and `lastAnnotation ok:true` in `/status`.

Negative cases: placeholder-session target rejected (reconnect + pick a real chat), subagent target rejected (no hijack), CORS from an `https://` origin denied.

## Code Style Guidelines

### TypeScript (src/)

- 2-space indentation
- Double quotes
- Semicolons required

### JavaScript (extension/)

- 2-space indentation
- Double quotes
- No semicolons

## Important Notes

- Plugin binds local HTTP on `127.0.0.1` over a bounded port range (`39240-39260`).
- Extension discovers active instances by probing `/status` and routes annotation requests directly to the selected instance.
- HTTP contract is frozen for the prebuilt extension: do not change paths, methods, or response shapes without bumping `api` in `/status`.
- V1 plugin code does not run on v2.
