# SESCLICK v2 — design spec

- Date: 2026-10-12
- Status: draft (architectural path, approach B approved, sections 1–6 accepted)
- Source task: kanban #1643 — «Форк chrome-annotation под v2: клик по элементу с выбором сессии»
- Upstream: https://github.com/JodusNodus/opencode-chrome-annotation (GPL-3.0-only, dead since 04.2026 — port as-is NOT wanted)
- Donor of features: `eagleeyejack/opencode-chrome-annotation` (`npm: opencode-annotate@1.2.2`) — side panel, all chats grouped, chat locking, queue, cropped screenshots, session close, CORS fix
- Target runtime: `opencode v2.0.27`, `openchamber 2.2.0`
- Transport decision: via **OpenCode V2 plugin API** (`ctx.*`), NOT via OpenChamber API
- Repo shape: **mono-repo** (like upstream: `src/` + `extension-src/` in one repo), new public repo (name TBD: `sesclick` / `sesclick-v2` / `opencode-annotate-v2`)
- Docs rule (user): README links upstream and states **v2-only (>= 2.0.27); for v1 use the upstream repo**
- License: **GPL-3.0-only** inherited from upstream, credit to JodusNodus + mention of eagle fork as feature donor

## 1. Purpose

V2-native analog of chrome-annotation: click an element on a page → screenshot + element metadata + user instruction delivered to the **chosen** OpenCode session (not only the active one), more stable than the original.

Non-goals: porting V1 code as-is; OpenChamber-API transport; two-repo layout; Chrome Web Store release in MVP.

## 2. Success criteria

- Plugin loads in `opencode 2.0.27` as V2 plugin (`Plugin.define({ id: "sesclick", setup })`), appears in active plugin list.
- Unpacked extension connects a tab to a user-picked session (Linked badge), lists **all** open chats grouped by project with relative `updatedAt`.
- Queue 2+ annotations → Send all → prompt arrives **only** in the picked session, with cropped screenshot file path + metadata + comment.
- `/status` reports v2 + `lastAnnotation { ok: true, transport: "session.prompt" }`.
- Negative cases behave: placeholder `plugin:*` rejected with «reconnect and pick a specific chat»; subagent target rejected (no hijack); CORS from `https://` origin denied.
- `tsc --noEmit`, `bun run build`, `build:extension`, `check:extension` all green.

## 3. Architecture (§1 approved)

```
Chrome extension (side panel primary + in-page fallback)
  │  HTTP 127.0.0.1:39240-39260, CORS: chrome-extension:// only
  ▼
SESCLICK V2 plugin (Plugin.define id="sesclick")
  ├─ Node http server: GET /status /sessions · POST /claim /annotation /unclaim /session/close
  ├─ sessions-mapper (V2 shape: projectID / location.directory / time.updated)
  ├─ claim-store (tabId → sessionId, TTL 5 min, ctx.storage-backed)
  ├─ screenshot-saver (dataUrl → ANNOTATION_DIR file)
  ├─ prompt-sender: ctx.session.prompt({ sessionID, text }) only (no TUI path)
  ├─ event subscriber: ctx.event.subscribe() for session.created/updated/deleted
  └─ tools: sesclick_status + alias chrome_status (ctx.tool.transform)
State: ctx.storage (claims/titles/dirs, survives reload) + ANNOTATION_DIR files + chrome.storage.session queue (extension).
```

Frozen HTTP contract (extension logic untouched): request/response shapes of all 6 endpoints stay byte-compatible with eagle donor (plus `/status` adds `api: "v2"` + caps for feature-detect).

## 4. Components (§2 approved)

Plugin (`src/`):
- `server.ts` — port scan 39240→39260 on 127.0.0.1, JSON body limit 10 MB, CORS allow only `chrome-extension://` / `moz-extension://`, cleanup closes server.
- `sessions.ts` — NO `ctx.session.list` in V2 plugin API (proven: `SessionDomain = Pick<SessionApi, "create"|"get"|"remove"|…|"context">` — `list` absent in `@opencode/plugin@2.0.27`, while server/client API HAS `session.list`). Therefore NO direct list call from plugin. Instead **event-sourced registry**: `ctx.event.subscribe()` collects `session.created/updated` (data: `{ sessionID, projectID, location, parentID }`) + `session.deleted` drops; enrich via `ctx.session.get({ sessionID })`; track active via `ctx.session.hook("prompt")`; persist registry in `ctx.storage` (survives reload). Map V2 shape: `{ id, title ← title ?? short(id), directory ← location.directory, updatedAt ← time.updated }`; filter `time.archived`; skip subagents (`parentID` known → remember + skip); if registry empty, fallback placeholder only.
- `claims.ts` — `rememberClaim(tabId, sessionId, extVersion)`, `pruneStaleClaims()` (CLAIM_TTL_MS = 5 min), `listClaims()` sorted.
- `screenshots.ts` — `decodeDataUrl()` (must be base64 data URL), `sanitizeFileStem()` (≤80 chars), ext by mime (jpg/webp/png), `writeFileSync` into `ANNOTATION_DIR` (mkdir recursive).
- `prompt.ts` — `buildAnnotationPrompt(annotation)` (comment, page title/URL/tabId, viewport w/h/dpr, selector/tag/role/text/aria/rect, «inspect screenshot… then make the code change»); append `\n\nScreenshot: <filePath>`; send via `ctx.session.prompt`; record `lastAnnotation`.
- `events.ts` — subscribe: `session.created/updated` → `applySessionTitle`; `session.deleted` → drop title + clear active if needed.
- `tools.ts` — `sesclick_status` (full `buildStatus()`: app, version, runtime, instanceId, directory, runtimeBaseDir, annotationDir, logPath, server {status,host,port,startupError,bindFailures}, claims, lastAnnotation) + alias `chrome_status` for muscle memory.
- `tui-gone` — explicit: NO `tui.appendPrompt/submitPrompt` in V2 server plugin; collapsed to direct prompt (simpler + matches V2 docs).

Extension (`extension-src/`, logic carried from donor):
- `background.ts`, `session-picker.ts` (group by project, Linked badge, updatedAt relative, close with 2-click confirm → `POST /session/close`), `annotation-picker.ts`, `annotation-queue-store.ts` (batch, survives SW restart), `claims-store.ts`, `connection-monitor.ts`, `server-api.ts` (+ `api: v2` check), `ui-overlays.ts` + in-page fallback for browsers without Side Panel API, `injected/dom.ts` (selector/tag/role/text/aria/rect + viewport), `manifest.json`, `constants.ts`, `types.ts`, `logger.ts`, `tabs.ts`, `globals.d.ts`.

## 5. Data flow (§3 approved)

1. User opens side panel → `GET /sessions` → picks session → `POST /claim { tabId, sessionId, extensionVersion }` → badge Linked.
2. Clicks Select element → clicks element on page → `injected/dom` captures `{ selector, tag, role, text, ariaLabel, rect }` + `page { title, url }` + `viewport` → user writes instruction → Add to queue (screenshot cropped from `captureVisibleTab` by rect, stored as dataUrl in queue).
3. Send all → per item `POST /annotation { tabId, sessionId, extensionVersion, annotation }` → plugin re-validates claim → saves screenshot file → builds prompt text → `ctx.session.prompt({ sessionID, text })` → `200 { ok: true, sessionId }` + `lastAnnotation ok:true`.
4. `GET /status` anytime for diagnostics (`chrome_status` / `sesclick_status` tool returns same JSON).

## 6. Error handling (§4 approved)

| Case | Behavior |
|---|---|
| Placeholder `plugin:*` as target | `400` «linked to a placeholder session, not a real chat. Reconnect and pick a specific chat.» + `lastAnnotation ok:false` |
| Subagent session as target | reject clearly (cannot hijack routing); list hides subagents |
| `ctx.session.prompt` throws / returns false | `lastAnnotation { ok:false, phase, error }`, error text to extension |
| No prompt transport | `500` «No OpenCode prompt transport is available» |
| Ports 39240–39260 all busy | `server.status: "failed"`, `startupError` set, `bindFailures[]` kept, logged |
| CORS origin not `chrome-extension://` / `moz-extension://` | no `Access-Control-Allow-Origin`, browser blocks |
| Invalid JSON / body > 10 MB | `400 { ok:false, error }` |
| Unknown path | `404 { ok:false, error: "Not found" }` |
| Session deleted | drop cached title; clear active + label fallback |

## 7. Testing (§5 approved)

- `tsc --noEmit` (or `bun run typecheck`), `bun run build`, `bun run build:extension`, `npm run check:extension` (node --check background/injected/dom + manifest JSON parse).
- Manual E2E on `opencode 2.0.27` in `/home/crfox/dev_projects/sesclick`: load unpacked `extension/`; link tab → verify Linked; queue 2 annotations → Send all → verify arrival in picked session only, cropped files exist, `/status` v2 + `lastAnnotation ok:true transport session.prompt`.
- Negative: subagent + placeholder rejected; `curl -H 'Origin: https://evil.test'` gets no ACAO; restart opencode → claims/titles survive via `ctx.storage` (in-memory fallback documented if storage unavailable).
- Compatibility note: V1 clients unsupported by design (README v2-only rule).

## 8. Repo / docs / license (§6 approved)

- New public mono-repo; `LICENSE` = upstream GPL-3.0 text; `package.json` keeps `author: Benjamin Shafii` (upstream) + new `repository/bugs/homepage` pointing at SESCLICK repo; README credits upstream + eagle donor.
- README must contain: link to https://github.com/JodusNodus/opencode-chrome-annotation; «Requires OpenCode >= 2.0.27 (V2 plugin API). For OpenCode v1 use the upstream repo.»; V2 install (`plugins: [...]` object form, NOT V1 `plugin` array); local plugins via `.opencode/plugins/`; extension load from `chrome://extensions` (unpacked `extension/`); local-only statement (127.0.0.1, nothing leaves machine, same-host browser requirement); `chrome_status` troubleshooting (`sesclick_status` primary).
- `PRIVACY_POLICY.md` carried (local-only), `AGENTS.md` updated for V2 commands.
- Git: spec file NOT committed by agent (pipeline commits). Extension build output `extension/` git-ignored; Web Store zip via `build:zip` later (non-MVP).

## 9. Decisions log

- Base = eagle fork `opencode-annotate@1.2.2` (user: «ага»).
- Transport = OpenCode V2 API, not OpenChamber API (user: «лучше через опенкод… да»).
- MVP = full eagle feature port, «не сильно заморочно» confirmed by code measure (plugin 693 lines, extension ~2500 lines; V2 rewrite ≈ 150–200 lines + mapping).
- Shape = mono-repo (user: «моно»).
- Approach = B V2-native core, HTTP contract frozen (user: «делаем по второму варианту»).

## 10. Open items (need owner input when spec reviewed)

- New repo name + GitHub org/user + visibility confirm (public ok per user).
- `id` confirm: `sesclick` (vs `sesclick-v2` / `opencode-annotate-v2`); npm package name if publishing plugin.
- Whether to keep `chrome_status` alias permanently or deprecate after transition.
- Web Store listing (non-MVP): publisher account + privacy review.

## 11. Port checklist (for implementer, V1 → V2)

- [ ] `import type { Plugin } from "@opencode-ai/plugin"` → `import { Plugin } from "@opencode/plugin"`; `export default Plugin.define({ id: "sesclick", async setup(ctx) { …; return () => server.close(); } })`
- [ ] `pluginClient.session.list/get` → V2: NO `ctx.session.list` (verified absent in SDK). Sessions = event-sourced registry (`session.created/updated/deleted` via `ctx.event.subscribe()` + `ctx.session.get({ sessionID })` + `ctx.session.hook("prompt")` for actives, persisted in `ctx.storage`); map V2 shape (`location.directory`, `time.updated/archived`, `parentID`).
- [ ] `promptAsync/prompt({ path:{id}, query:{directory}, body:{parts} })` → `ctx.session.prompt({ sessionID, text })` (+ files/attachments if V2 supports; else path-in-text as today).
- [ ] `tui.appendPrompt/submitPrompt` → DELETE (direct prompt only).
- [ ] `pluginClient.session.delete({ path:{id} })` → `ctx.session.remove({ sessionID })`.
- [ ] `event` + `chat.message` hooks → `ctx.event.subscribe()` (+ `ctx.session.hook("prompt",…)` only if active-tracking still needed).
- [ ] `tool: { chrome_status }` → `ctx.tool.transform(editor.add({ name: "sesclick_status", … }))` + alias add.
- [ ] In-memory `Map`s → `ctx.storage` (get/set/remove/scan) with in-memory fallback.
- [ ] `/status` adds `{ api: "v2", plugin: "sesclick", transports: ["session.prompt"] }`; keep all other shapes.
- [ ] Config docs: V2 `plugins` object form; `.opencode/plugins/` discovery.
