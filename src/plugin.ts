import { Plugin } from "@opencode/plugin";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join } from "path";
import { createServer, type Server } from "http";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_JSON_PATH = join(__dirname, "..", "package.json");

const BASE_DIR = getRuntimeBaseDir();
const LOG_PATH = join(BASE_DIR, "plugin.log");
const ANNOTATION_DIR = join(BASE_DIR, "annotations");
const PORT_START = 39240;
const PORT_END = 39260;
const LISTEN_HOST = "127.0.0.1";
const APP_ID = "opencode-chrome-annotation";
const PLUGIN_ID = "sesclick";
const INSTANCE_SESSION_PREFIX = "plugin:";
const CLAIM_TTL_MS = 5 * 60 * 1000;
const STORAGE_REGISTRY_KEY = "sesclick:registry";
const PERSIST_DEBOUNCE_MS = 200;

type PluginContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];

let cachedVersion: string | null = null;
let processSessionId = `${INSTANCE_SESSION_PREFIX}${Math.random().toString(36).slice(2)}`;
let pluginCtx: PluginContext | null = null;
let pluginDirectory = process.cwd();
let pluginSessionLabel = buildSessionLabel(pluginDirectory);
let listeningPort: number | null = null;
let httpServer: Server | null = null;
let serverStartupStatus: "not-started" | "starting" | "listening" | "failed" = "not-started";
let serverStartupError: string | null = null;
const bindFailures: Array<{ port: number; code?: string; message: string }> = [];
let lastAnnotationStatus: Record<string, any> | null = null;
let activeOpencodeSessionId: string | null = null;
let lastExtensionVersion: string | null = null;
const sessionTitles = new Map<string, string>();
const sessionDirectories = new Map<string, string | null>();
const sessionUpdatedAt = new Map<string, number>();
const subagentSessionIds = new Set<string>();
const subagentChecks = new Map<string, boolean>();
const claims = new Map<number, { sessionId: string; claimedAt: string; lastSeenAt: string; extensionVersion?: string }>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function fallbackSession(): { id: string; title: string; directory: string; status: string; updatedAt: number } {
  return {
    id: processSessionId,
    title: pluginSessionLabel,
    directory: pluginDirectory,
    status: "open",
    updatedAt: 0,
  };
}

function getRuntimeBaseDir(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const candidates = [
    process.env.XDG_RUNTIME_DIR ? join(process.env.XDG_RUNTIME_DIR, "sesclick") : null,
    join(tmpdir(), `sesclick-${uid ?? "user"}`),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      mkdirSync(candidate, { recursive: true, mode: 0o700 });
      return candidate;
    } catch {
      // Try the next location.
    }
  }

  return join(tmpdir(), `sesclick-${uid ?? "user"}`);
}

function getPackageVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE_JSON_PATH, "utf8"));
    if (typeof pkg?.version === "string") {
      cachedVersion = pkg.version;
      return pkg.version;
    }
  } catch {
    // ignore
  }
  cachedVersion = "unknown";
  return cachedVersion;
}

function logDebug(message: string): void {
  try {
    appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${message}\n`, "utf8");
  } catch {
    // ignore
  }
}

function buildSessionLabel(directory: string): string {
  const name = basename(directory || process.cwd());
  return name ? `OpenCode: ${name}` : "OpenCode";
}

function decodeDataUrl(dataUrl: string): { mime: string; bytes: Buffer } {
  const match = String(dataUrl).match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match) throw new Error("Annotation screenshot must be a base64 data URL");
  return {
    mime: match[1] || "application/octet-stream",
    bytes: Buffer.from(match[2], "base64"),
  };
}

function sanitizeFileStem(value: string): string {
  return String(value || "annotation")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "annotation";
}

function buildAnnotationPrompt(annotation: any): string {
  const comment = typeof annotation?.comment === "string" ? annotation.comment.trim() : "";
  const page = annotation?.page || {};
  const element = annotation?.element || {};
  const rect = element?.rect || {};
  const viewport = annotation?.viewport || {};

  return [
    "Browser annotation from Chrome",
    "",
    "User comment:",
    comment || "(no comment provided)",
    "",
    "Page:",
    `Title: ${page.title || ""}`,
    `URL: ${page.url || ""}`,
    typeof annotation?.tabId === "number" ? `Tab ID: ${annotation.tabId}` : "Tab ID: ",
    `Viewport: width=${viewport.width ?? ""} height=${viewport.height ?? ""} devicePixelRatio=${viewport.devicePixelRatio ?? ""}`,
    "",
    "Selected element:",
    `Selector: ${element.selector || ""}`,
    `Tag: ${element.tag || ""}`,
    `Role: ${element.role || ""}`,
    `Text: ${element.text || ""}`,
    `Aria label: ${element.ariaLabel || ""}`,
    `Rect: x=${rect.x ?? ""} y=${rect.y ?? ""} width=${rect.width ?? ""} height=${rect.height ?? ""}`,
    "",
    "Please inspect the screenshot and selected element metadata, then make the appropriate code change.",
  ].join("\n");
}

function isExplicitFalse(value: any): boolean {
  return value === false || value?.data === false;
}

function setLastAnnotationStatus(status: Record<string, any>): void {
  lastAnnotationStatus = { ...status, time: new Date().toISOString() };
}

function applySessionTitle(sessionId: string, title: string): void {
  const next = String(title || "").trim();
  if (!sessionId || !next) return;
  sessionTitles.set(sessionId, next);
  if (activeOpencodeSessionId === sessionId) {
    pluginSessionLabel = next;
  }
  schedulePersist();
}

function parseSessionTitle(response: any): { id: string; title: string } | null {
  const info = response?.data || response;
  if (!info || typeof info !== "object") return null;
  if (typeof info.id !== "string" || typeof info.title !== "string") return null;
  return { id: info.id, title: info.title };
}

function dropSession(sessionId: string): void {
  sessionTitles.delete(sessionId);
  sessionDirectories.delete(sessionId);
  sessionUpdatedAt.delete(sessionId);
  subagentSessionIds.delete(sessionId);
  subagentChecks.delete(sessionId);
  for (const [tabId, claim] of claims) {
    if (claim.sessionId === sessionId) claims.delete(tabId);
  }
  schedulePersist();
}

function rememberClaim(tabId: number, sessionId: string, extensionVersion?: string): void {
  const key = Number(tabId);
  const now = new Date().toISOString();
  const prior = claims.get(key);
  const cleanVersion = cleanExtensionVersion(extensionVersion);
  if (cleanVersion) lastExtensionVersion = cleanVersion;
  claims.set(key, {
    sessionId,
    claimedAt: prior?.claimedAt || now,
    lastSeenAt: now,
    extensionVersion: cleanVersion || prior?.extensionVersion,
  });
  schedulePersist();
}

function cleanExtensionVersion(value: any): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function pruneStaleClaims(): void {
  const cutoff = Date.now() - CLAIM_TTL_MS;
  for (const [tabId, claim] of claims.entries()) {
    const lastSeen = Date.parse(claim.lastSeenAt);
    if (!Number.isFinite(lastSeen) || lastSeen < cutoff) {
      claims.delete(tabId);
    }
  }
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void persistRegistry();
  }, PERSIST_DEBOUNCE_MS);
  if (typeof persistTimer === "object" && persistTimer !== null && typeof (persistTimer as any).unref === "function") {
    (persistTimer as any).unref();
  }
}

async function persistRegistry(): Promise<void> {
  if (!pluginCtx) return;
  const payload = {
    titles: Object.fromEntries(sessionTitles),
    directories: Object.fromEntries(sessionDirectories),
    updated: Object.fromEntries(sessionUpdatedAt),
    claims: Object.fromEntries(claims),
    subagents: Array.from(subagentSessionIds),
    active: activeOpencodeSessionId,
    extver: lastExtensionVersion,
  };
  try {
    await pluginCtx.storage.set(STORAGE_REGISTRY_KEY, payload as any);
  } catch (error) {
    logDebug(`registry persist failed error=${error instanceof Error ? error.message : String(error)}`);
  }
}

async function loadRegistry(): Promise<void> {
  if (!pluginCtx) return;
  let raw: unknown = undefined;
  try {
    raw = await pluginCtx.storage.get(STORAGE_REGISTRY_KEY);
  } catch (error) {
    logDebug(`registry load failed error=${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return;
  const data = raw as Record<string, unknown>;
  if (data.titles && typeof data.titles === "object") {
    for (const [id, title] of Object.entries(data.titles as Record<string, unknown>)) {
      if (typeof title === "string" && title.trim()) sessionTitles.set(id, title.trim());
    }
  }
  if (data.directories && typeof data.directories === "object") {
    for (const [id, dir] of Object.entries(data.directories as Record<string, unknown>)) {
      if (typeof dir === "string") sessionDirectories.set(id, dir);
      else if (dir === null) sessionDirectories.set(id, null);
    }
  }
  if (data.updated && typeof data.updated === "object") {
    for (const [id, ts] of Object.entries(data.updated as Record<string, unknown>)) {
      if (typeof ts === "number" && Number.isFinite(ts)) sessionUpdatedAt.set(id, ts);
    }
  }
  if (data.claims && typeof data.claims === "object") {
    for (const [tabId, claim] of Object.entries(data.claims as Record<string, unknown>)) {
      const key = Number(tabId);
      if (!Number.isFinite(key)) continue;
      const c = claim as Record<string, unknown>;
      if (c && typeof c.sessionId === "string" && typeof c.claimedAt === "string" && typeof c.lastSeenAt === "string") {
        claims.set(key, {
          sessionId: c.sessionId,
          claimedAt: c.claimedAt,
          lastSeenAt: c.lastSeenAt,
          extensionVersion: typeof c.extensionVersion === "string" ? c.extensionVersion : undefined,
        });
      }
    }
    pruneStaleClaims();
  }
  if (Array.isArray(data.subagents)) {
    for (const id of data.subagents) {
      if (typeof id === "string") subagentSessionIds.add(id);
    }
  }
  if (typeof data.active === "string") {
    activeOpencodeSessionId = data.active;
    const title = sessionTitles.get(data.active);
    if (title) pluginSessionLabel = title;
  }
  if (typeof data.extver === "string") lastExtensionVersion = data.extver;
  logDebug(
    `registry loaded titles=${sessionTitles.size} dirs=${sessionDirectories.size} claims=${claims.size} subagents=${subagentSessionIds.size}`
  );
}

async function isSubagentSession(sessionId: string): Promise<boolean> {
  if (subagentSessionIds.has(sessionId)) return true;
  if (subagentChecks.has(sessionId)) return subagentChecks.get(sessionId) as boolean;
  let isSubagent = false;
  try {
    const info = await pluginCtx?.session.get({ sessionID: sessionId });
    const detail = (info as any)?.data ?? info;
    isSubagent = Boolean((detail as any)?.parentID);
  } catch {
    // ignore
  }
  if (isSubagent) subagentSessionIds.add(sessionId);
  subagentChecks.set(sessionId, isSubagent);
  schedulePersist();
  return isSubagent;
}

async function ensureSessionTitle(sessionId: string): Promise<void> {
  if (!sessionId || sessionTitles.has(sessionId) || !pluginCtx) return;
  try {
    const info = await pluginCtx.session.get({ sessionID: sessionId });
    const parsed = parseSessionTitle(info);
    if (parsed) applySessionTitle(parsed.id, parsed.title);
    const detail = (info as any)?.data ?? info;
    if (detail && typeof detail === "object") {
      if (typeof (detail as any)?.location?.directory === "string") {
        sessionDirectories.set(sessionId, (detail as any).location.directory);
      }
      if (typeof (detail as any)?.time?.updated === "number") {
        sessionUpdatedAt.set(sessionId, (detail as any).time.updated);
      }
      schedulePersist();
    }
  } catch {
    // ignore
  }
}

async function listOpenCodeSessions(): Promise<Array<{ id: string; title: string; directory?: string; status: string; updatedAt: number }>> {
  const knownIds = new Set<string>([...sessionTitles.keys(), ...sessionDirectories.keys()]);
  if (activeOpencodeSessionId) knownIds.add(activeOpencodeSessionId);

  const sessions: Array<{ id: string; title: string; directory: string; status: string; updatedAt: number }> = [];
  for (const id of knownIds) {
    if (id.startsWith(INSTANCE_SESSION_PREFIX)) continue;
    if (subagentSessionIds.has(id)) continue;

    let detail: any = null;
    try {
      const info = await pluginCtx?.session.get({ sessionID: id });
      detail = (info as any)?.data ?? info;
    } catch {
      // keep cached entry
    }

    if (detail && typeof detail === "object" && typeof (detail as any).id === "string") {
      if ((detail as any)?.time?.archived) {
        dropSession(id);
        continue;
      }
      if ((detail as any)?.parentID && knownIds.has((detail as any).parentID)) {
        subagentSessionIds.add(id);
        schedulePersist();
        continue;
      }
      const title =
        typeof (detail as any)?.title === "string" && (detail as any).title.trim()
          ? (detail as any).title.trim()
          : sessionTitles.get(id) || `Session ${id.slice(0, 8)}`;
      applySessionTitle(id, title);
      const directory =
        typeof (detail as any)?.location?.directory === "string"
          ? (detail as any).location.directory
          : sessionDirectories.get(id) || pluginDirectory;
      sessionDirectories.set(id, directory);
      const updatedAt = Number((detail as any)?.time?.updated ?? (detail as any)?.time?.created) || sessionUpdatedAt.get(id) || 0;
      sessionUpdatedAt.set(id, updatedAt);
      sessions.push({ id, title, directory, status: "open", updatedAt });
    } else {
      const title = sessionTitles.get(id);
      if (!title) continue;
      const directory = sessionDirectories.get(id) || pluginDirectory;
      sessions.push({ id, title, directory, status: "open", updatedAt: sessionUpdatedAt.get(id) || 0 });
    }
  }
  logDebug(`sessions registry ids=${knownIds.size} rows=${sessions.length}`);

  if (!sessions.length) return [fallbackSession()];

  if (activeOpencodeSessionId && !subagentSessionIds.has(activeOpencodeSessionId) && !sessions.some((session: { id: string }) => session.id === activeOpencodeSessionId)) {
    const activeTitle = sessionTitles.get(activeOpencodeSessionId);
    if (activeTitle) {
      sessions.unshift({
        id: activeOpencodeSessionId,
        title: activeTitle,
        directory: sessionDirectories.get(activeOpencodeSessionId) || pluginDirectory,
        status: "open",
        updatedAt: Number.MAX_SAFE_INTEGER,
      });
    }
  }

  sessions.sort((a: { updatedAt: number }, b: { updatedAt: number }) => b.updatedAt - a.updatedAt);
  schedulePersist();
  return sessions;
}

function json(res: any, statusCode: number, body: any, origin?: string): void {
  if (origin) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.statusCode = statusCode;
  res.end(JSON.stringify(body));
}

function allowedCorsOrigin(req: any): string | null {
  const origin = req.headers?.origin;
  if (typeof origin !== "string" || !origin) return null;
  if (/^chrome-extension:\/\//.test(origin) || /^moz-extension:\/\//.test(origin)) return origin;
  return null;
}

async function readJsonBody(req: any): Promise<any> {
  return await new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk.toString("utf8");
      if (data.length > 10 * 1024 * 1024) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function listClaims(): Array<Record<string, any>> {
  pruneStaleClaims();
  return Array.from(claims.entries())
    .map(([tabId, info]) => ({ tabId, ...info }))
    .sort((a, b) => a.tabId - b.tabId);
}

async function queueAnnotationPrompt(sessionId: string, annotation: any): Promise<string> {
  if (typeof sessionId === "string" && sessionId.startsWith(INSTANCE_SESSION_PREFIX)) {
    setLastAnnotationStatus({ ok: false, sessionId, error: "Tab is linked to a placeholder session, not a real chat" });
    throw new Error("This tab is linked to a placeholder session, not a real chat. Reconnect and pick a specific chat.");
  }
  if (!pluginCtx) {
    setLastAnnotationStatus({ ok: false, sessionId, error: "No OpenCode client is available" });
    throw new Error("No OpenCode client is available");
  }
  if (await isSubagentSession(sessionId)) {
    setLastAnnotationStatus({ ok: false, sessionId, error: "Target is a subagent session, not a top-level chat" });
    throw new Error("Cannot send annotation to a subagent session. Pick a top-level chat instead.");
  }

  setLastAnnotationStatus({
    ok: null,
    sessionId,
    phase: "received",
    commentLength: typeof annotation?.comment === "string" ? annotation.comment.length : 0,
  });

  let promptText = buildAnnotationPrompt(annotation);
  const screenshot = annotation?.screenshot;
  if (screenshot?.dataUrl) {
    mkdirSync(ANNOTATION_DIR, { recursive: true });
    const { mime, bytes } = decodeDataUrl(screenshot.dataUrl);
    const ext = mime === "image/jpeg" ? "jpg" : mime === "image/webp" ? "webp" : "png";
    const stem = sanitizeFileStem(annotation?.page?.title || annotation?.element?.tag || "annotation");
    const filePath = join(ANNOTATION_DIR, `${Date.now()}-${stem}.${ext}`);
    writeFileSync(filePath, bytes);
    promptText += `\n\nScreenshot: ${filePath}`;
  }

  let result: unknown;
  try {
    result = await pluginCtx.session.prompt({ sessionID: sessionId, text: promptText });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setLastAnnotationStatus({ ok: false, sessionId, phase: "prompt-failed", transport: "session.prompt", error: message });
    throw new Error(message);
  }
  if (isExplicitFalse(result)) {
    setLastAnnotationStatus({ ok: false, sessionId, phase: "prompt-failed", transport: "session.prompt", error: "OpenCode rejected session prompt submission" });
    throw new Error("OpenCode rejected session prompt submission");
  }
  setLastAnnotationStatus({ ok: true, sessionId, transport: "session.prompt", response: result ?? null });
  return "session.prompt";
}

function buildStatus(): Record<string, any> {
  return {
    app: APP_ID,
    api: "v2",
    plugin: PLUGIN_ID,
    transports: ["session.prompt"],
    version: getPackageVersion(),
    runtime: {
      platform: process.platform,
      node: process.version,
      tmpdir: tmpdir(),
      xdgRuntimeDir: Boolean(process.env.XDG_RUNTIME_DIR),
      uid: typeof process.getuid === "function" ? process.getuid() : null,
    },
    instanceId: processSessionId,
    sessionId: processSessionId,
    opencodeSessionId: activeOpencodeSessionId,
    label: pluginSessionLabel,
    directory: pluginDirectory,
    runtimeBaseDir: BASE_DIR,
    annotationDir: ANNOTATION_DIR,
    logPath: LOG_PATH,
    server: {
      status: serverStartupStatus,
      host: LISTEN_HOST,
      port: listeningPort,
      startupError: serverStartupError,
      bindFailures,
    },
    port: listeningPort,
    lastExtensionVersion,
    claimTtlMs: CLAIM_TTL_MS,
    claims: listClaims(),
    lastAnnotation: lastAnnotationStatus,
  };
}

async function startServer(): Promise<void> {
  if (listeningPort) return;
  serverStartupStatus = "starting";
  serverStartupError = null;
  bindFailures.length = 0;

  for (let port = PORT_START; port <= PORT_END; port++) {
    const server = createServer(async (req, res) => {
      const origin = allowedCorsOrigin(req) || undefined;
      if (req.method === "OPTIONS") {
        json(res, 200, { ok: true }, origin);
        return;
      }

      try {
        const url = new URL(req.url || "/", `http://${LISTEN_HOST}:${port}`);
        if (req.method === "GET" && url.pathname === "/status") {
          json(res, 200, buildStatus(), origin);
          return;
        }

        if (req.method === "GET" && url.pathname === "/sessions") {
          const sessions = await listOpenCodeSessions();
          json(
            res,
            200,
            {
              sessions,
            },
            origin
          );
          return;
        }

        if (req.method === "POST" && url.pathname === "/claim") {
          const body = await readJsonBody(req);
          const tabId = body?.tabId;
          const sessionId = body?.sessionId;
          const extensionVersion = body?.extensionVersion;
          if (!Number.isFinite(tabId)) throw new Error("tabId is required");
          if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId is required");
          if (sessionId.startsWith(INSTANCE_SESSION_PREFIX)) {
            throw new Error("Cannot link to the placeholder session. Restart OpenCode in your project and pick a real chat.");
          }
          await ensureSessionTitle(sessionId);
          rememberClaim(Number(tabId), sessionId, extensionVersion);
          json(res, 200, { ok: true, sessionId }, origin);
          return;
        }

        if (req.method === "POST" && url.pathname === "/annotation") {
          const body = await readJsonBody(req);
          const tabId = body?.tabId;
          const sessionId = body?.sessionId;
          const extensionVersion = body?.extensionVersion;
          const annotation = body?.annotation;
          if (!Number.isFinite(tabId)) throw new Error("tabId is required");
          if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId is required");
          if (!annotation || typeof annotation !== "object") throw new Error("annotation is required");

          rememberClaim(Number(tabId), sessionId, extensionVersion);

          const transport = await queueAnnotationPrompt(sessionId, { ...annotation, tabId: Number(tabId) });
          json(res, 200, { ok: true, sessionId, transport }, origin);
          return;
        }

        if (req.method === "POST" && url.pathname === "/unclaim") {
          const body = await readJsonBody(req);
          const tabId = body?.tabId;
          const extensionVersion = body?.extensionVersion;
          const cleanVersion = cleanExtensionVersion(extensionVersion);
          if (cleanVersion) lastExtensionVersion = cleanVersion;
          if (!Number.isFinite(tabId)) throw new Error("tabId is required");
          claims.delete(Number(tabId));
          schedulePersist();
          json(res, 200, { ok: true }, origin);
          return;
        }

        if (req.method === "POST" && url.pathname === "/session/close") {
          const body = await readJsonBody(req);
          const sessionId = body?.sessionId;
          if (typeof sessionId !== "string" || !sessionId) throw new Error("sessionId is required");
          if (sessionId.startsWith(INSTANCE_SESSION_PREFIX)) {
            throw new Error("Cannot close the placeholder session");
          }
          if (!/^[A-Za-z0-9:_-]+$/.test(sessionId)) throw new Error("Invalid sessionId");
          if (!pluginCtx) throw new Error("OpenCode client is unavailable");
          await pluginCtx.session.remove({ sessionID: sessionId });
          dropSession(sessionId);
          logDebug(`session closed id=${sessionId}`);
          json(res, 200, { ok: true, sessionId }, origin);
          return;
        }

        json(res, 404, { ok: false, error: "Not found" }, origin);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logDebug(`http error path=${req.url || ""} error=${message}`);
        json(res, 400, { ok: false, error: message }, origin);
      }
    });

    const started = await new Promise<boolean>((resolve) => {
      server.once("error", (error: NodeJS.ErrnoException) => {
        const failure = {
          port,
          code: error.code,
          message: error.message,
        };
        bindFailures.push(failure);
        logDebug(`http bind failed port=${port} code=${failure.code || ""} error=${failure.message}`);
        resolve(false);
      });
      server.listen(port, LISTEN_HOST, () => resolve(true));
    });

    if (!started) continue;
    httpServer = server;
    listeningPort = port;
    serverStartupStatus = "listening";
    logDebug(`http server listening port=${port} session=${processSessionId} label=${JSON.stringify(pluginSessionLabel)}`);
    return;
  }

  serverStartupStatus = "failed";
  serverStartupError = `Could not bind OpenCode annotation server on ${LISTEN_HOST} ports ${PORT_START}-${PORT_END}`;
  throw new Error(serverStartupError);
}

function closeServer(): void {
  try {
    httpServer?.close();
  } catch (error) {
    logDebug(`http server close failed error=${error instanceof Error ? error.message : String(error)}`);
  }
  httpServer = null;
  listeningPort = null;
  serverStartupStatus = "not-started";
}

function handleEvent(event: any): void {
  const type = (event as any)?.type;
  const data = (event as any)?.data;
  if (!type || !data || typeof data !== "object") return;

  if (type === "session.created") {
    const id = data.sessionID;
    if (typeof id !== "string" || !id) return;
    if (id.startsWith(INSTANCE_SESSION_PREFIX)) return;
    if (data.parentID) {
      subagentSessionIds.add(id);
    } else {
      if (typeof data.title === "string" && data.title.trim()) applySessionTitle(id, data.title);
      const dir = (data.location as any)?.directory;
      if (typeof dir === "string") sessionDirectories.set(id, dir);
    }
    schedulePersist();
    return;
  }

  if (type === "session.renamed") {
    const id = data.sessionID;
    if (typeof id === "string" && typeof data.title === "string") applySessionTitle(id, data.title);
    return;
  }

  if (type === "session.moved") {
    const id = data.sessionID;
    const dir = (data.location as any)?.directory;
    if (typeof id === "string" && typeof dir === "string") {
      sessionDirectories.set(id, dir);
      schedulePersist();
    }
    return;
  }

  if (type === "session.deleted") {
    const id = data.sessionID;
    if (typeof id !== "string" || !id) return;
    dropSession(id);
    if (activeOpencodeSessionId === id) {
      activeOpencodeSessionId = null;
      pluginSessionLabel = buildSessionLabel(pluginDirectory);
      schedulePersist();
    }
  }
}

async function runEventLoop(): Promise<void> {
  if (!pluginCtx) return;
  try {
    for await (const event of pluginCtx.event.subscribe()) {
      try {
        handleEvent(event);
      } catch (error) {
        logDebug(`event handle failed error=${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    logDebug(`event subscribe failed error=${error instanceof Error ? error.message : String(error)}`);
  }
}

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    pluginCtx = ctx as unknown as PluginContext;
    pluginDirectory = ctx.location?.directory || ctx.location?.project?.directory || process.cwd();
    pluginSessionLabel = buildSessionLabel(pluginDirectory);

    await loadRegistry();

    startServer().catch((error) => {
      serverStartupStatus = "failed";
      serverStartupError = error instanceof Error ? error.message : String(error);
      logDebug(`server startup failed error=${serverStartupError}`);
    });

    void runEventLoop();

    await ctx.session.hook("prompt", async (input) => {
      try {
        const sessionID = (input as { sessionID?: unknown }).sessionID;
        if (typeof sessionID !== "string" || !sessionID || sessionID.startsWith(INSTANCE_SESSION_PREFIX)) return;
        if (subagentSessionIds.has(sessionID)) return;
        activeOpencodeSessionId = sessionID;
        if (sessionTitles.has(sessionID)) {
          pluginSessionLabel = sessionTitles.get(sessionID) as string;
          schedulePersist();
          return;
        }
        await ensureSessionTitle(sessionID);
        schedulePersist();
      } catch (error) {
        logDebug(`prompt hook failed error=${error instanceof Error ? error.message : String(error)}`);
      }
    });

    await ctx.tool.transform((editor) => {
      const execute = async () => ({ content: JSON.stringify(buildStatus(), null, 2) });
      editor.add({
        name: "sesclick_status",
        description: "Report SESCLICK v2 local server, session registry, tab claims, and last annotation status.",
        input: { type: "object", properties: {} },
        execute,
      });
      editor.add({
        name: "chrome_status",
        description: "Alias of sesclick_status. Report SESCLICK v2 local server, session registry, tab claims, and last annotation status.",
        input: { type: "object", properties: {} },
        execute,
      });
    });

    return () => {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
      }
      void persistRegistry();
      closeServer();
      pluginCtx = null;
    };
  },
});
