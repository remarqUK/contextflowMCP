import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { parsePositiveEnvInt, sanitizeDisplayText } from "./lib/common.mjs";

const SERVER_NAME = "ContextFlowMCP";
const SERVER_VERSION = "0.1.0";
const NO_SESSION_BUCKET = "(no-session-id)";
const DEFAULT_PROJECT = process.env.MCP_SHARED_CONTEXT_PROJECT || "shared";
const configuredContextFolder = normalizeResolvedPath(process.env.MCP_SHARED_CONTEXT_FOLDER);
const contextFileSelection = resolveContextFileSelection();
const configuredActiveSessionPath = expandHomePath(process.env.MCP_SHARED_CONTEXT_ACTIVE_SESSION_FILE);
const CONTEXT_FILE = contextFileSelection.path;
const CONTEXT_FILE_SOURCE = contextFileSelection.source;
const CONTEXT_FILE_DISCOVERY = contextFileSelection.discovery || null;
const LOCK_FILE = `${CONTEXT_FILE}.lock`;
const SESSION_INDEX_FILE = `${CONTEXT_FILE}.sessions-index.json`;
const ACTIVE_SESSION_FILE = path.resolve(
  configuredActiveSessionPath || path.join(path.dirname(CONTEXT_FILE), "active-session.txt"),
);
const MAX_LOCK_WAIT_MS = 5000;
const STALE_LOCK_MS = 30000;
const SESSION_INDEX_VERSION = 1;
const DEFAULT_NEW_SESSION_PREFIX = process.env.MCP_SHARED_CONTEXT_NEW_SESSION_PREFIX || "session";
const MAX_PROMPT_SESSIONS = 50;
const PROMPT_NEW_SESSION = "new_session";
const PROMPT_RESUME_BY_ID = "resume_by_id";
const PROMPT_RESUME_PREFIX = "resume_";
const MAX_CONTEXT_FILE_BYTES = parsePositiveEnvInt("MCP_SHARED_CONTEXT_MAX_CONTEXT_FILE_BYTES", 50 * 1024 * 1024);
const MAX_INBOUND_FRAME_BYTES = parsePositiveEnvInt("MCP_SHARED_CONTEXT_MAX_INBOUND_FRAME_BYTES", 2 * 1024 * 1024);
const MAX_INBOUND_LINE_BYTES = parsePositiveEnvInt("MCP_SHARED_CONTEXT_MAX_INBOUND_LINE_BYTES", 2 * 1024 * 1024);
const MAX_INPUT_BUFFER_BYTES = parsePositiveEnvInt("MCP_SHARED_CONTEXT_MAX_INPUT_BUFFER_BYTES", 4 * 1024 * 1024);
const MAX_NOTE_TEXT_CHARS = parsePositiveEnvInt("MCP_SHARED_CONTEXT_MAX_NOTE_TEXT_CHARS", 20000);
const MAX_HANDOFF_SUMMARY_CHARS = parsePositiveEnvInt("MCP_SHARED_CONTEXT_MAX_HANDOFF_SUMMARY_CHARS", 20000);
const MAX_ARRAY_ITEMS = parsePositiveEnvInt("MCP_SHARED_CONTEXT_MAX_ARRAY_ITEMS", 200);
const MAX_ARRAY_ITEM_CHARS = parsePositiveEnvInt("MCP_SHARED_CONTEXT_MAX_ARRAY_ITEM_CHARS", 1000);

const state = {
  initialized: false,
  clientProtocolVersion: null,
  transportMode: null,
};

const contextCache = {
  signature: null,
  raw: "",
  entries: [],
  parseErrors: [],
};

const sessionIndexCache = {
  contextSignature: null,
  index: null,
};

function expandHomePath(value) {
  if (typeof value !== "string" || !value) {
    return value;
  }
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function normalizeResolvedPath(value, baseDir = process.cwd()) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const expanded = expandHomePath(trimmed);
  if (!expanded || typeof expanded !== "string") {
    return null;
  }
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded));
}

function isRegularFile(filePath) {
  try {
    return fsSync.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function extractContextPathFromConfigText(text) {
  if (typeof text !== "string" || !text.trim()) {
    return null;
  }

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith("//") || line.startsWith(";")) {
      continue;
    }

    const patterns = [
      /^["']MCP_SHARED_CONTEXT_FILE["']\s*:\s*["']([^"']+)["']/i,
      /^\bMCP_SHARED_CONTEXT_FILE\b\s*=\s*["']([^"']+)["']/i,
      /^\bMCP_SHARED_CONTEXT_FILE\b\s*=\s*([^\s#;]+)/i,
    ];

    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match && typeof match[1] === "string" && match[1].trim()) {
        return match[1].trim();
      }
    }
  }
  return null;
}

function buildClientConfigCandidates() {
  const home = os.homedir();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const candidates = [];
  const seen = new Set();

  function add(client, filePath) {
    const normalized = normalizeResolvedPath(filePath);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push({ client, filePath: normalized });
  }

  add("codex", path.join(home, ".codex", "config.toml"));
  add("codex", path.join(home, ".codex", "config.json"));
  add("claude", path.join(home, ".claude", "config.json"));
  add("claude", path.join(home, ".claude", "settings.json"));
  add("claude", path.join(home, ".claude", "claude_desktop_config.json"));
  add("gemini", path.join(home, ".gemini", "config.json"));
  add("gemini", path.join(home, ".gemini", "settings.json"));

  if (xdgConfigHome) {
    add("codex", path.join(xdgConfigHome, "codex", "config.toml"));
    add("codex", path.join(xdgConfigHome, "codex", "config.json"));
    add("claude", path.join(xdgConfigHome, "claude", "config.json"));
    add("claude", path.join(xdgConfigHome, "claude", "settings.json"));
    add("claude", path.join(xdgConfigHome, "claude", "claude_desktop_config.json"));
    add("gemini", path.join(xdgConfigHome, "gemini", "config.json"));
    add("gemini", path.join(xdgConfigHome, "gemini", "settings.json"));
  }

  if (appData) {
    add("codex", path.join(appData, "Codex", "config.toml"));
    add("codex", path.join(appData, "Codex", "config.json"));
    add("claude", path.join(appData, "Claude", "config.json"));
    add("claude", path.join(appData, "Claude", "settings.json"));
    add("claude", path.join(appData, "Claude", "claude_desktop_config.json"));
    add("gemini", path.join(appData, "Gemini", "config.json"));
    add("gemini", path.join(appData, "Gemini", "settings.json"));
  }

  if (localAppData) {
    add("codex", path.join(localAppData, "Codex", "config.toml"));
    add("codex", path.join(localAppData, "Codex", "config.json"));
    add("claude", path.join(localAppData, "Claude", "config.json"));
    add("claude", path.join(localAppData, "Claude", "settings.json"));
    add("gemini", path.join(localAppData, "Gemini", "config.json"));
    add("gemini", path.join(localAppData, "Gemini", "settings.json"));
  }

  return candidates;
}

function discoverContextFileFromClientConfigs() {
  const candidates = buildClientConfigCandidates();
  for (const candidate of candidates) {
    if (!isRegularFile(candidate.filePath)) {
      continue;
    }
    let raw;
    try {
      raw = fsSync.readFileSync(candidate.filePath, "utf8");
    } catch {
      continue;
    }
    const extractedPath = extractContextPathFromConfigText(raw);
    if (!extractedPath) {
      continue;
    }
    const resolvedPath = normalizeResolvedPath(extractedPath, path.dirname(candidate.filePath));
    if (!resolvedPath) {
      continue;
    }
    return {
      path: resolvedPath,
      source: "auto-discovered-config",
      discovery: {
        client: candidate.client,
        configFile: candidate.filePath,
      },
    };
  }
  return null;
}

function buildCommonContextDirectories() {
  const home = os.homedir();
  const xdgConfigHome = process.env.XDG_CONFIG_HOME;
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const directories = [];
  const seen = new Set();

  function add(dirPath) {
    const normalized = normalizeResolvedPath(dirPath);
    if (!normalized || seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    directories.push(normalized);
  }

  add(home);
  add(path.join(home, ".codex"));
  add(path.join(home, ".claude"));
  add(path.join(home, ".gemini"));
  add(path.join(home, ".config", "codex"));
  add(path.join(home, ".config", "claude"));
  add(path.join(home, ".config", "gemini"));

  if (xdgConfigHome) {
    add(path.join(xdgConfigHome, "codex"));
    add(path.join(xdgConfigHome, "claude"));
    add(path.join(xdgConfigHome, "gemini"));
  }

  if (appData) {
    add(path.join(appData, "Codex"));
    add(path.join(appData, "Claude"));
    add(path.join(appData, "Gemini"));
  }

  if (localAppData) {
    add(path.join(localAppData, "Codex"));
    add(path.join(localAppData, "Claude"));
    add(path.join(localAppData, "Gemini"));
  }

  return directories;
}

function discoverContextFileFromCommonLocations() {
  const commonDirectories = buildCommonContextDirectories();
  const contextFileNames = [
    ".mcp-shared-context.jsonl",
    "shared-context.jsonl",
    "agent-context.jsonl",
    "contextflow-context.jsonl",
    "contextflow-shared-context.jsonl",
  ];

  for (const directory of commonDirectories) {
    for (const fileName of contextFileNames) {
      const candidatePath = path.join(directory, fileName);
      if (!isRegularFile(candidatePath)) {
        continue;
      }
      return {
        path: candidatePath,
        source: "auto-discovered-file",
        discovery: {
          directory,
          fileName,
        },
      };
    }
  }

  return null;
}

function resolveContextFileSelection() {
  const explicitFromEnv = normalizeResolvedPath(process.env.MCP_SHARED_CONTEXT_FILE);
  if (explicitFromEnv) {
    return {
      path: explicitFromEnv,
      source: "env",
      discovery: null,
    };
  }

  if (configuredContextFolder) {
    const contextFileName = ".mcp-shared-context.jsonl";
    return {
      path: path.join(configuredContextFolder, contextFileName),
      source: "env-folder",
      discovery: {
        folder: configuredContextFolder,
        fileName: contextFileName,
      },
    };
  }

  const fromConfig = discoverContextFileFromClientConfigs();
  if (fromConfig) {
    return fromConfig;
  }

  const fromCommonLocations = discoverContextFileFromCommonLocations();
  if (fromCommonLocations) {
    return fromCommonLocations;
  }

  const homeDefault = path.resolve(path.join(os.homedir(), ".mcp-shared-context.jsonl"));
  return {
    path: homeDefault,
    source: "home-default",
    discovery: null,
  };
}

const tools = [
  {
    name: "read_shared_context",
    description:
      "Read recent shared context entries (notes + handoffs) from the common file so another assistant can resume work.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project key. Defaults to MCP_SHARED_CONTEXT_PROJECT or 'shared'." },
        agent: { type: "string", description: "Optional filter by agent name (e.g. claude, codex, gemini)." },
        session_id: { type: "string", description: "Optional filter by session/task thread id." },
        kind: { type: "string", enum: ["note", "handoff"], description: "Optional filter by entry type." },
        since: { type: "string", description: "Optional ISO-8601 timestamp. Only entries at/after this time are returned." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "How many recent entries to return. Default 20.",
        },
        format: {
          type: "string",
          enum: ["text", "json"],
          description: "Return a human-readable transcript (`text`) or raw JSON entries (`json`). Default text.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "append_shared_note",
    description: "Append a progress note to the shared context file while you are working.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent name writing the note (e.g. codex, claude, gemini)." },
        text: { type: "string", description: "The note text to append. Provide this or `content`." },
        content: {
          type: "string",
          description: "Alias for `text` for client compatibility. Provide this or `text`.",
        },
        project: { type: "string", description: "Project key. Defaults to MCP_SHARED_CONTEXT_PROJECT or 'shared'." },
        session_id: { type: "string", description: "Optional session/thread/task id." },
        task: { type: "string", description: "Optional current task title." },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for filtering later.",
        },
      },
      required: ["agent"],
      additionalProperties: false,
    },
  },
  {
    name: "write_shared_handoff",
    description: "Write a structured handoff entry so another assistant can continue where you left off.",
    inputSchema: {
      type: "object",
      properties: {
        agent: { type: "string", description: "Agent creating the handoff." },
        summary: { type: "string", description: "What was completed and current state." },
        next_steps: {
          type: "array",
          items: { type: "string" },
          description: "Ordered next actions for the next assistant.",
        },
        open_questions: {
          type: "array",
          items: { type: "string" },
          description: "Unknowns/blockers/questions.",
        },
        files: {
          type: "array",
          items: { type: "string" },
          description: "Relevant files or paths touched.",
        },
        project: { type: "string", description: "Project key. Defaults to MCP_SHARED_CONTEXT_PROJECT or 'shared'." },
        session_id: { type: "string", description: "Optional session/thread/task id." },
        task: { type: "string", description: "Optional task title." },
      },
      required: ["agent", "summary"],
      additionalProperties: false,
    },
  },
  {
    name: "get_latest_handoff",
    description: "Get the most recent handoff entry, optionally filtered by project/agent/session.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project key filter." },
        agent: { type: "string", description: "Optional filter by handoff author." },
        session_id: { type: "string", description: "Optional filter by session/thread id." },
        format: { type: "string", enum: ["text", "json"], description: "Return text (default) or raw JSON." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "list_sessions",
    description:
      "List resumable work sessions in the shared context file (grouped by session_id), similar to a resume picker.",
    inputSchema: {
      type: "object",
      properties: {
        project: { type: "string", description: "Project key filter. Defaults to MCP_SHARED_CONTEXT_PROJECT/'shared'." },
        agent: { type: "string", description: "Optional filter: include only sessions with entries by this agent." },
        since: { type: "string", description: "Optional ISO-8601 timestamp. Only include sessions active at/after this time." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Max sessions to return, newest first. Default 20.",
        },
        include_unsessioned: {
          type: "boolean",
          description: "Include entries with no session_id grouped under a synthetic '(no-session-id)' bucket. Default false.",
        },
        format: {
          type: "string",
          enum: ["text", "json"],
          description: "Return text (default) or JSON.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "choose_session",
    description:
      "Choose a session from the current session list by index or session_id and return the selected session with a ready-to-use resume_session payload.",
    inputSchema: {
      type: "object",
      properties: {
        index: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "1-based index from list_sessions output (within the same filters/limit).",
        },
        session_id: { type: "string", description: "Choose directly by session_id instead of index." },
        project: { type: "string", description: "Project key filter. Defaults to MCP_SHARED_CONTEXT_PROJECT/'shared'." },
        agent: { type: "string", description: "Optional filter: include only sessions with entries by this agent." },
        since: { type: "string", description: "Optional ISO-8601 timestamp. Only choose from sessions active at/after this time." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "Same list limit behavior as list_sessions. Default 20.",
        },
        include_unsessioned: {
          type: "boolean",
          description: "Include the synthetic no-session bucket in the candidate list. Default false.",
        },
        format: {
          type: "string",
          enum: ["text", "json"],
          description: "Return text (default) or JSON.",
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "resume_session",
    description:
      "Return the latest handoff and recent entries for a specific session_id so an assistant can resume the exact work item.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session/task id to resume." },
        project: { type: "string", description: "Project key filter. Defaults to MCP_SHARED_CONTEXT_PROJECT/'shared'." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 200,
          description: "How many recent entries from this session to include. Default 20.",
        },
        format: {
          type: "string",
          enum: ["text", "json"],
          description: "Return text (default) or JSON.",
        },
      },
      additionalProperties: false,
    },
  },
];

function logErr(message, error) {
  const line = error ? `${message}: ${error?.stack || error}` : message;
  process.stderr.write(`${line}\n`);
}

function jsonRpcResult(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id, code, message, data) {
  const error = data === undefined ? { code, message } : { code, message, data };
  return { jsonrpc: "2.0", id: id ?? null, error };
}

function sendMessage(message) {
  if (state.transportMode === "line") {
    process.stdout.write(`${JSON.stringify(message)}\n`);
    return;
  }
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(
    `Content-Length: ${payload.length}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
    "utf8",
  );
  process.stdout.write(header);
  process.stdout.write(payload);
}

function sendResult(id, result) {
  sendMessage(jsonRpcResult(id, result));
}

function sendError(id, code, message, data) {
  sendMessage(jsonRpcError(id, code, message, data));
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asString(value, name, { required = false, trim = true } = {}) {
  if (value === undefined || value === null) {
    if (required) {
      throw new Error(`Missing required string: ${name}`);
    }
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`Expected string for ${name}`);
  }
  const out = trim ? value.trim() : value;
  if (required && out.length === 0) {
    throw new Error(`String cannot be empty: ${name}`);
  }
  return out;
}

function asStringArray(value, name) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`Expected array of strings for ${name}`);
  }
  const out = value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`Expected string at ${name}[${index}]`);
    }
    const trimmed = item.trim();
    if (!trimmed) {
      throw new Error(`Empty string not allowed at ${name}[${index}]`);
    }
    return trimmed;
  });
  return out;
}

function enforceStringMaxLength(value, name, maxChars) {
  if (value === undefined) {
    return undefined;
  }
  if (value.length > maxChars) {
    throw new Error(`${name} exceeds max length (${maxChars} chars)`);
  }
  return value;
}

function enforceStringArrayLimits(values, name, { maxItems = MAX_ARRAY_ITEMS, maxItemChars = MAX_ARRAY_ITEM_CHARS } = {}) {
  if (values === undefined) {
    return undefined;
  }
  if (values.length > maxItems) {
    throw new Error(`${name} exceeds max items (${maxItems})`);
  }
  values.forEach((item, index) => {
    if (item.length > maxItemChars) {
      throw new Error(`${name}[${index}] exceeds max length (${maxItemChars} chars)`);
    }
  });
  return values;
}

function resolveNoteTextInput(args) {
  const text = asString(args.text, "text", { trim: false });
  const content = asString(args.content, "content", { trim: false });
  const candidate = (typeof text === "string" && text.length > 0 ? text : undefined)
    ?? (typeof content === "string" && content.length > 0 ? content : undefined);
  if (!candidate) {
    throw new Error("Missing required string: text (or content)");
  }
  return candidate;
}

function asPositiveInt(value, name, fallback, min = 1, max = 200) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Number.isInteger(value)) {
    throw new Error(`Expected integer for ${name}`);
  }
  if (value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function asIsoDateOrUndefined(value, name) {
  const text = asString(value, name);
  if (!text) {
    return undefined;
  }
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) {
    throw new Error(`Invalid date for ${name}; expected ISO-8601`);
  }
  return new Date(ms).toISOString();
}

function normalizeProject(project) {
  return project?.trim() || DEFAULT_PROJECT;
}

function normalizeFormat(value) {
  const fmt = (value ?? "text");
  if (fmt !== "text" && fmt !== "json") {
    throw new Error("format must be 'text' or 'json'");
  }
  return fmt;
}

function normalizeSessionId(value) {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Expected string for session_id");
  }
  const out = value.trim();
  return out || undefined;
}

function sanitizeSessionId(value) {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = trimmed
    .replace(/[^\w./-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || undefined;
}

function execFileAsync(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function getGitBranchName(cwd = process.cwd()) {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd,
      windowsHide: true,
      timeout: 1500,
    });
    const branch = String(stdout || "").trim();
    return branch || undefined;
  } catch {
    return undefined;
  }
}

function makeTimestampSessionId(prefix) {
  const now = new Date();
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
    "-",
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  return `${prefix}-${stamp}-${randomUUID().slice(0, 6)}`;
}

async function makeSuggestedSessionId() {
  const branch = sanitizeSessionId(await getGitBranchName(process.cwd()));
  if (branch) {
    return branch;
  }
  return makeTimestampSessionId(DEFAULT_NEW_SESSION_PREFIX);
}

async function readActiveSessionId() {
  const envSessionId = normalizeSessionId(process.env.MCP_SHARED_CONTEXT_ACTIVE_SESSION);
  if (envSessionId) {
    return envSessionId;
  }

  try {
    const text = await fs.readFile(ACTIVE_SESSION_FILE, "utf8");
    return normalizeSessionId(text);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function writeActiveSessionId(sessionId) {
  const normalized = normalizeSessionId(sessionId);
  if (!normalized) {
    throw new Error("Cannot persist empty session_id");
  }
  await fs.mkdir(path.dirname(ACTIVE_SESSION_FILE), { recursive: true });
  await fs.writeFile(ACTIVE_SESSION_FILE, `${normalized}\n`, "utf8");
}

async function resolveSessionIdInput(value, { required = false } = {}) {
  const explicit = normalizeSessionId(value);
  if (explicit) {
    return explicit;
  }
  const active = await readActiveSessionId();
  if (active) {
    return active;
  }
  if (required) {
    throw new Error(
      "Missing session_id. Choose one with list_sessions/choose_session (or run pick-session.mjs) and try again.",
    );
  }
  return undefined;
}

function makeFileSignature(stat) {
  if (!stat) {
    return null;
  }
  return `${stat.size}:${Math.trunc(stat.mtimeMs)}`;
}

async function statContextFile() {
  try {
    return await fs.stat(CONTEXT_FILE);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function invalidateContextCache() {
  contextCache.signature = null;
  contextCache.raw = "";
  contextCache.entries = [];
  contextCache.parseErrors = [];
}

function invalidateSessionIndexCache() {
  sessionIndexCache.contextSignature = null;
  sessionIndexCache.index = null;
}

async function ensureContextDirectory() {
  await fs.mkdir(path.dirname(CONTEXT_FILE), { recursive: true });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeBreakStaleLock() {
  try {
    const stat = await fs.stat(LOCK_FILE);
    if (Date.now() - stat.mtimeMs > STALE_LOCK_MS) {
      await fs.unlink(LOCK_FILE).catch(() => {});
    }
  } catch (error) {
    if (error && error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function withWriteLock(fn) {
  const start = Date.now();
  while (true) {
    let handle;
    try {
      handle = await fs.open(LOCK_FILE, "wx");
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          host: os.hostname(),
          created_at: new Date().toISOString(),
        }),
        "utf8",
      );
      try {
        return await fn();
      } finally {
        await handle.close().catch(() => {});
        await fs.unlink(LOCK_FILE).catch(() => {});
      }
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => {});
      }
      if (error && error.code === "EEXIST") {
        if (Date.now() - start > MAX_LOCK_WAIT_MS) {
          throw new Error(`Timed out waiting for context lock (${LOCK_FILE})`);
        }
        await maybeBreakStaleLock();
        await sleep(40 + Math.floor(Math.random() * 60));
        continue;
      }
      throw error;
    }
  }
}

async function appendEntry(entry) {
  await ensureContextDirectory();
  const line = `${JSON.stringify(entry)}\n`;
  await withWriteLock(async () => {
    const beforeStat = await statContextFile();
    const beforeSignature = makeFileSignature(beforeStat);
    await fs.appendFile(CONTEXT_FILE, line, "utf8");
    const afterStat = await statContextFile();
    const afterSignature = makeFileSignature(afterStat);
    await tryUpdateSessionIndexOnAppend(entry, { beforeSignature, afterSignature }).catch(() => {
      invalidateSessionIndexCache();
    });
  });
  invalidateContextCache();
}

async function readRawContextFile() {
  try {
    const stat = await fs.stat(CONTEXT_FILE);
    if (stat.size > MAX_CONTEXT_FILE_BYTES) {
      throw new Error(
        `Context file exceeds configured max size (${MAX_CONTEXT_FILE_BYTES} bytes): ${CONTEXT_FILE}`,
      );
    }
    return await fs.readFile(CONTEXT_FILE, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function parseEntries(rawText) {
  const entries = [];
  const parseErrors = [];
  const lines = rawText.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      if (!isObject(parsed)) {
        throw new Error("line is not a JSON object");
      }
      entries.push(parsed);
    } catch (error) {
      parseErrors.push({ line: i + 1, error: String(error) });
    }
  }
  return { entries, parseErrors };
}

async function readEntries() {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const beforeStat = await statContextFile();
    const beforeSignature = makeFileSignature(beforeStat);

    if (beforeSignature && contextCache.signature === beforeSignature) {
      return {
        raw: contextCache.raw,
        entries: contextCache.entries,
        parseErrors: contextCache.parseErrors,
        signature: contextCache.signature,
      };
    }

    if (!beforeStat) {
      invalidateContextCache();
      return { raw: "", entries: [], parseErrors: [], signature: null };
    }

    if (beforeStat.size > MAX_CONTEXT_FILE_BYTES) {
      throw new Error(
        `Context file exceeds configured max size (${MAX_CONTEXT_FILE_BYTES} bytes): ${CONTEXT_FILE}`,
      );
    }

    const raw = await fs.readFile(CONTEXT_FILE, "utf8");
    const afterStat = await statContextFile();
    const afterSignature = makeFileSignature(afterStat);

    // Avoid caching torn reads if another process appends while we are reading.
    if (beforeSignature && afterSignature && beforeSignature !== afterSignature && attempt === 0) {
      continue;
    }

    const { entries, parseErrors } = parseEntries(raw);
    if (afterSignature && beforeSignature && beforeSignature === afterSignature) {
      contextCache.signature = afterSignature;
      contextCache.raw = raw;
      contextCache.entries = entries;
      contextCache.parseErrors = parseErrors;
    } else {
      invalidateContextCache();
    }
    return { raw, entries, parseErrors, signature: beforeSignature && beforeSignature === afterSignature ? afterSignature : null };
  }

  const raw = await readRawContextFile();
  const { entries, parseErrors } = parseEntries(raw);
  return { raw, entries, parseErrors, signature: null };
}

function makeSessionIndexSkeleton(contextSignature = null) {
  return {
    version: SESSION_INDEX_VERSION,
    context_signature: contextSignature,
    next_file_index: 0,
    projects: {},
  };
}

function normalizeSessionIndex(raw) {
  if (!isObject(raw)) {
    return null;
  }
  if (raw.version !== SESSION_INDEX_VERSION) {
    return null;
  }
  const contextSignature = typeof raw.context_signature === "string" ? raw.context_signature : null;
  const nextFileIndex =
    Number.isInteger(raw.next_file_index) && raw.next_file_index >= 0 ? raw.next_file_index : 0;
  const projects = {};
  if (isObject(raw.projects)) {
    Object.entries(raw.projects).forEach(([projectName, bucketRaw]) => {
      if (!projectName || !isObject(bucketRaw)) {
        return;
      }
      const bucket = {};
      Object.entries(bucketRaw).forEach(([sessionIdKey, summaryRaw]) => {
        if (!sessionIdKey || !isObject(summaryRaw)) {
          return;
        }
        const sessionId =
          (typeof summaryRaw.session_id === "string" && summaryRaw.session_id.trim()) || sessionIdKey.trim();
        if (!sessionId) {
          return;
        }
        const summary = makeSessionSummary(sessionId, projectName);
        summary.entry_count =
          Number.isInteger(summaryRaw.entry_count) && summaryRaw.entry_count >= 0 ? summaryRaw.entry_count : 0;
        summary.note_count =
          Number.isInteger(summaryRaw.note_count) && summaryRaw.note_count >= 0 ? summaryRaw.note_count : 0;
        summary.handoff_count =
          Number.isInteger(summaryRaw.handoff_count) && summaryRaw.handoff_count >= 0 ? summaryRaw.handoff_count : 0;
        summary.latest_ts = typeof summaryRaw.latest_ts === "string" && summaryRaw.latest_ts ? summaryRaw.latest_ts : undefined;
        summary.latest_ts_ms =
          typeof summaryRaw.latest_ts_ms === "number" && Number.isFinite(summaryRaw.latest_ts_ms)
            ? summaryRaw.latest_ts_ms
            : null;
        summary.latest_file_index =
          Number.isInteger(summaryRaw.latest_file_index) && summaryRaw.latest_file_index >= -1
            ? summaryRaw.latest_file_index
            : -1;
        summary.last_entry_kind =
          summaryRaw.last_entry_kind === "note" || summaryRaw.last_entry_kind === "handoff"
            ? summaryRaw.last_entry_kind
            : undefined;
        summary.task = typeof summaryRaw.task === "string" && summaryRaw.task.trim() ? summaryRaw.task.trim() : undefined;
        summary.latest_handoff_summary =
          typeof summaryRaw.latest_handoff_summary === "string" && summaryRaw.latest_handoff_summary.trim()
            ? summaryRaw.latest_handoff_summary.trim()
            : undefined;
        if (Array.isArray(summaryRaw.agents)) {
          summaryRaw.agents.forEach((agent) => pushUniqueString(summary.agents, agent));
          summary.agents.sort();
        }
        bucket[sessionId] = summary;
      });
      projects[projectName] = bucket;
    });
  }
  return {
    version: SESSION_INDEX_VERSION,
    context_signature: contextSignature,
    next_file_index: nextFileIndex,
    projects,
  };
}

async function readSessionIndexFile() {
  try {
    const text = await fs.readFile(SESSION_INDEX_FILE, "utf8");
    const parsed = JSON.parse(text);
    return normalizeSessionIndex(parsed);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    return null;
  }
}

async function writeSessionIndexFile(index) {
  await ensureContextDirectory();
  const tmpPath = `${SESSION_INDEX_FILE}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(index)}\n`, "utf8");
  await fs.rename(tmpPath, SESSION_INDEX_FILE);
}

async function loadSessionIndex(expectedContextSignature) {
  if (!expectedContextSignature) {
    return null;
  }
  if (
    sessionIndexCache.contextSignature === expectedContextSignature &&
    sessionIndexCache.index &&
    sessionIndexCache.index.context_signature === expectedContextSignature
  ) {
    return sessionIndexCache.index;
  }

  const index = await readSessionIndexFile();
  if (!index || index.context_signature !== expectedContextSignature) {
    invalidateSessionIndexCache();
    return null;
  }
  sessionIndexCache.contextSignature = expectedContextSignature;
  sessionIndexCache.index = index;
  return index;
}

async function persistSessionIndex(index) {
  try {
    await writeSessionIndexFile(index);
    sessionIndexCache.contextSignature = index.context_signature;
    sessionIndexCache.index = index;
  } catch {
    invalidateSessionIndexCache();
  }
}

function getSessionProject(entry) {
  if (typeof entry.project === "string" && entry.project.trim()) {
    return entry.project.trim();
  }
  return DEFAULT_PROJECT;
}

function applyEntryToSessionIndex(index, entry, fileIndex) {
  if (!isObject(index.projects)) {
    index.projects = {};
  }
  if (Number.isInteger(fileIndex) && fileIndex >= 0) {
    index.next_file_index = Math.max(index.next_file_index || 0, fileIndex + 1);
  }

  const sessionId = normalizeSessionId(entry.session_id);
  if (!sessionId) {
    return;
  }
  const project = getSessionProject(entry);
  if (!isObject(index.projects[project])) {
    index.projects[project] = {};
  }
  if (!isObject(index.projects[project][sessionId])) {
    index.projects[project][sessionId] = makeSessionSummary(sessionId, project);
  }
  applyEntryToSessionSummary(index.projects[project][sessionId], entry, fileIndex);
  index.projects[project][sessionId].agents.sort();
}

function buildSessionIndexFromEntries(entries, contextSignature) {
  const index = makeSessionIndexSkeleton(contextSignature);
  entries.forEach((entry, fileIndex) => {
    applyEntryToSessionIndex(index, entry, fileIndex);
  });
  if (!Number.isInteger(index.next_file_index) || index.next_file_index < entries.length) {
    index.next_file_index = entries.length;
  }
  return index;
}

function listProjectSessionsFromIndex(index, project) {
  if (!index || !isObject(index.projects)) {
    return [];
  }
  const bucket = index.projects[project];
  if (!isObject(bucket)) {
    return [];
  }
  const summaries = Object.values(bucket).map((summary) => ({
    ...summary,
    agents: Array.isArray(summary.agents) ? [...summary.agents].sort() : [],
  }));
  return sortSessionSummaries(summaries);
}

async function tryUpdateSessionIndexOnAppend(entry, { beforeSignature, afterSignature }) {
  if (!afterSignature) {
    invalidateSessionIndexCache();
    return;
  }

  let index = null;
  if (!beforeSignature) {
    index = makeSessionIndexSkeleton(afterSignature);
  } else {
    index = await loadSessionIndex(beforeSignature);
    if (!index) {
      invalidateSessionIndexCache();
      return;
    }
    index.context_signature = afterSignature;
  }

  const fileIndex =
    Number.isInteger(index.next_file_index) && index.next_file_index >= 0 ? index.next_file_index : 0;
  applyEntryToSessionIndex(index, entry, fileIndex);
  if (index.next_file_index < fileIndex + 1) {
    index.next_file_index = fileIndex + 1;
  }
  await persistSessionIndex(index);
}

function filterEntries(entries, filters = {}) {
  const {
    project,
    agent,
    session_id,
    kind,
    since,
  } = filters;
  const sinceMs = since ? Date.parse(since) : null;
  return entries.filter((entry) => {
    if (project && entry.project !== project) return false;
    if (agent && entry.agent !== agent) return false;
    if (session_id && entry.session_id !== session_id) return false;
    if (kind && entry.kind !== kind) return false;
    if (sinceMs !== null) {
      const entryMs = Date.parse(entry.ts || "");
      if (Number.isNaN(entryMs) || entryMs < sinceMs) return false;
    }
    return true;
  });
}

function selectRecent(entries, limit) {
  if (entries.length <= limit) {
    return entries;
  }
  return entries.slice(entries.length - limit);
}

function asBoolean(value, name, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new Error(`Expected boolean for ${name}`);
  }
  return value;
}

function truncateText(value, maxLength = 120) {
  if (typeof value !== "string") {
    return undefined;
  }
  const text = sanitizeDisplayText(value, { singleLine: true }).trim();
  if (!text) {
    return undefined;
  }
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}

function makeSessionSummary(sessionId, project) {
  return {
    session_id: sessionId,
    project: project || undefined,
    entry_count: 0,
    note_count: 0,
    handoff_count: 0,
    latest_ts: undefined,
    latest_ts_ms: null,
    latest_file_index: -1,
    last_entry_kind: undefined,
    task: undefined,
    agents: [],
    latest_handoff_summary: undefined,
  };
}

function pushUniqueString(target, value) {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return;
  }
  if (!target.includes(trimmed)) {
    target.push(trimmed);
  }
}

function applyEntryToSessionSummary(summary, entry, fileIndex) {
  summary.entry_count += 1;
  if (entry.kind === "note") summary.note_count += 1;
  if (entry.kind === "handoff") summary.handoff_count += 1;
  summary.last_entry_kind = entry.kind || summary.last_entry_kind;
  if (Number.isInteger(fileIndex)) {
    summary.latest_file_index = fileIndex;
  }
  if (!summary.project && entry.project) {
    summary.project = entry.project;
  }
  if (typeof entry.task === "string" && entry.task.trim()) {
    summary.task = entry.task.trim();
  }
  pushUniqueString(summary.agents, entry.agent);
  if (entry.kind === "handoff") {
    const handoffSummary = truncateText(entry.summary, 180);
    if (handoffSummary) {
      summary.latest_handoff_summary = handoffSummary;
    }
  }

  const entryTs = typeof entry.ts === "string" ? entry.ts : undefined;
  const entryTsMs = entryTs ? Date.parse(entryTs) : Number.NaN;
  if (Number.isFinite(entryTsMs)) {
    if (summary.latest_ts_ms === null || entryTsMs >= summary.latest_ts_ms) {
      summary.latest_ts_ms = entryTsMs;
      summary.latest_ts = new Date(entryTsMs).toISOString();
      if (Number.isInteger(fileIndex)) {
        summary.latest_file_index = fileIndex;
      }
    }
  } else if (!summary.latest_ts && entryTs) {
    summary.latest_ts = entryTs;
  }
}

function getSummaryLatestTsMs(summary) {
  if (typeof summary.latest_ts_ms === "number" && Number.isFinite(summary.latest_ts_ms)) {
    return summary.latest_ts_ms;
  }
  if (typeof summary.latest_ts === "string" && summary.latest_ts) {
    const parsed = Date.parse(summary.latest_ts);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Number.NEGATIVE_INFINITY;
}

function sortSessionSummaries(summaries) {
  return summaries.sort((a, b) => {
    const aTs = getSummaryLatestTsMs(a);
    const bTs = getSummaryLatestTsMs(b);
    if (bTs !== aTs) return bTs - aTs;
    const aIndex = Number.isInteger(a.latest_file_index) ? a.latest_file_index : -1;
    const bIndex = Number.isInteger(b.latest_file_index) ? b.latest_file_index : -1;
    if (bIndex !== aIndex) return bIndex - aIndex;
    return String(a.session_id).localeCompare(String(b.session_id));
  });
}

function buildSessionSummaries(entries, { includeUnsessioned = false } = {}) {
  const sessions = new Map();

  entries.forEach((entry, fileIndex) => {
    const rawSessionId = typeof entry.session_id === "string" ? entry.session_id.trim() : "";
    const sessionId = rawSessionId || (includeUnsessioned ? NO_SESSION_BUCKET : "");
    if (!sessionId) {
      return;
    }

    let summary = sessions.get(sessionId);
    if (!summary) {
      summary = makeSessionSummary(sessionId, entry.project);
      sessions.set(sessionId, summary);
    }
    applyEntryToSessionSummary(summary, entry, fileIndex);
  });

  return sortSessionSummaries(
    [...sessions.values()].map((summary) => ({
      ...summary,
      agents: [...summary.agents].sort(),
    })),
  );
}

function formatSessionSummary(summary, index) {
  const safeSessionId = sanitizeDisplayText(summary.session_id, { singleLine: true }) || "(missing)";
  const lineParts = [
    `[${index + 1}] session=${safeSessionId}`,
    `entries=${summary.entry_count}`,
    `handoffs=${summary.handoff_count}`,
  ];
  if (summary.latest_ts) lineParts.push(`last=${summary.latest_ts}`);
  if (summary.task) lineParts.push(`task=${sanitizeDisplayText(summary.task, { singleLine: true })}`);

  const body = [];
  if (summary.agents?.length) body.push(`agents: ${summary.agents.map((a) => sanitizeDisplayText(a, { singleLine: true })).join(", ")}`);
  if (summary.latest_handoff_summary) {
    body.push(`latest_handoff: ${sanitizeDisplayText(summary.latest_handoff_summary, { singleLine: true })}`);
  }

  return body.length ? `${lineParts.join(" | ")}\n${body.join("\n")}` : lineParts.join(" | ");
}

function summarizeSessionsText(summaries, filePath, { project, parseErrors }) {
  if (!summaries.length) {
    const parseNote = parseErrors.length ? ` (${parseErrors.length} malformed line(s) skipped)` : "";
    return `No resumable sessions found in ${filePath} for project=${project}.${parseNote}`;
  }
  const header = `Shared sessions: ${summaries.length} for project=${project} from ${filePath}`;
  const errorLine = parseErrors.length ? `\nNote: skipped ${parseErrors.length} malformed JSONL line(s).` : "";
  const body = summaries.map((summary, idx) => formatSessionSummary(summary, idx)).join("\n\n");
  return `${header}${errorLine}\n\n${body}`;
}

function parseSessionListOptions(args) {
  return {
    project: normalizeProject(asString(args.project, "project")),
    agent: asString(args.agent, "agent"),
    since: asIsoDateOrUndefined(args.since, "since"),
    limit: asPositiveInt(args.limit, "limit", 20, 1, 200),
    includeUnsessioned: asBoolean(args.include_unsessioned, "include_unsessioned", false),
    format: normalizeFormat(args.format),
  };
}

async function buildSessionListResult(options) {
  const canUseIndex =
    !options.agent &&
    !options.since &&
    !options.includeUnsessioned;

  if (canUseIndex) {
    const stat = await statContextFile();
    const contextSignature = makeFileSignature(stat);
    if (!contextSignature) {
      return { parseErrors: [], allSessions: [], visibleSessions: [] };
    }

    const indexed = await loadSessionIndex(contextSignature);
    if (indexed) {
      const allSessions = listProjectSessionsFromIndex(indexed, options.project);
      return {
        parseErrors: [],
        allSessions,
        visibleSessions: allSessions.slice(0, options.limit),
      };
    }

    const { entries, parseErrors, signature } = await readEntries();
    const filtered = filterEntries(entries, {
      project: options.project,
      agent: options.agent,
      since: options.since,
    });
    const allSessions = buildSessionSummaries(filtered, {
      includeUnsessioned: options.includeUnsessioned,
    });
    const indexSignature = signature || contextSignature;
    if (indexSignature) {
      const rebuiltIndex = buildSessionIndexFromEntries(entries, indexSignature);
      await persistSessionIndex(rebuiltIndex);
    }
    return {
      parseErrors,
      allSessions,
      visibleSessions: allSessions.slice(0, options.limit),
    };
  }

  const { entries, parseErrors } = await readEntries();
  const filtered = filterEntries(entries, {
    project: options.project,
    agent: options.agent,
    since: options.since,
  });
  const allSessions = buildSessionSummaries(filtered, {
    includeUnsessioned: options.includeUnsessioned,
  });
  return {
    parseErrors,
    allSessions,
    visibleSessions: allSessions.slice(0, options.limit),
  };
}

function shortIsoForPrompt(value) {
  if (!value || typeof value !== "string") {
    return "unknown";
  }
  return value.replace("T", " ").replace("Z", "").replace(/\.\d+$/, "");
}

function parsePromptResumeIndex(name) {
  if (!name.startsWith(PROMPT_RESUME_PREFIX)) {
    return undefined;
  }
  const token = name.slice(PROMPT_RESUME_PREFIX.length);
  if (!/^\d+$/.test(token)) {
    return undefined;
  }
  const idx = Number(token) - 1;
  if (!Number.isInteger(idx) || idx < 0) {
    return undefined;
  }
  return idx;
}

async function buildPromptSessionList(project) {
  const options = {
    project,
    agent: undefined,
    since: undefined,
    limit: MAX_PROMPT_SESSIONS,
    includeUnsessioned: false,
    format: "text",
  };
  const { parseErrors, visibleSessions } = await buildSessionListResult(options);
  return { parseErrors, sessions: visibleSessions };
}

function hasSessionId(entry) {
  return typeof entry.session_id === "string" && entry.session_id.trim().length > 0;
}

function getSessionEntries(entries, { project, session_id }) {
  if (session_id === NO_SESSION_BUCKET) {
    return entries.filter((entry) => (project ? entry.project === project : true) && !hasSessionId(entry));
  }
  return filterEntries(entries, { project, session_id });
}

function buildResumeSessionData(entries, parseErrors, { project, session_id, limit }) {
  const sessionEntries = getSessionEntries(entries, { project, session_id });
  if (!sessionEntries.length) {
    return null;
  }
  const summary = buildSessionSummaries(sessionEntries, {
    includeUnsessioned: session_id === NO_SESSION_BUCKET,
  })[0];
  const latestHandoffs = sessionEntries.filter((entry) => entry.kind === "handoff");
  const latestHandoff = latestHandoffs.length ? latestHandoffs[latestHandoffs.length - 1] : null;
  const recentEntries = selectRecent(sessionEntries, limit);
  return {
    project,
    session_id,
    parseErrors,
    summary,
    latest_handoff: latestHandoff,
    entries: recentEntries,
  };
}

function formatEntry(entry, index) {
  const parts = [];
  const ordinal = index + 1;
  parts.push(
    `[${ordinal}] ${sanitizeDisplayText(entry.ts || "unknown-time", { singleLine: true })} ${sanitizeDisplayText(entry.kind || "unknown", { singleLine: true })} by ${sanitizeDisplayText(entry.agent || "unknown-agent", { singleLine: true })}`,
  );
  parts.push(`project=${sanitizeDisplayText(entry.project || "unknown", { singleLine: true })}`);
  if (entry.session_id) parts.push(`session=${sanitizeDisplayText(entry.session_id, { singleLine: true })}`);
  if (entry.task) parts.push(`task=${sanitizeDisplayText(entry.task, { singleLine: true })}`);
  let line = parts.join(" | ");

  const body = [];
  if (entry.kind === "note") {
    body.push(sanitizeDisplayText(entry.text || ""));
  } else if (entry.kind === "handoff") {
    body.push(`summary: ${sanitizeDisplayText(entry.summary || "")}`);
    if (Array.isArray(entry.next_steps) && entry.next_steps.length) {
      body.push(
        `next_steps: ${entry.next_steps.map((s, i) => `${i + 1}. ${sanitizeDisplayText(s, { singleLine: true })}`).join(" | ")}`,
      );
    }
    if (Array.isArray(entry.open_questions) && entry.open_questions.length) {
      body.push(`open_questions: ${entry.open_questions.map((s) => sanitizeDisplayText(s, { singleLine: true })).join(" | ")}`);
    }
    if (Array.isArray(entry.files) && entry.files.length) {
      body.push(`files: ${entry.files.map((s) => sanitizeDisplayText(s, { singleLine: true })).join(", ")}`);
    }
  } else {
    body.push(JSON.stringify(entry));
  }
  if (Array.isArray(entry.tags) && entry.tags.length) {
    body.push(`tags: ${entry.tags.map((s) => sanitizeDisplayText(s, { singleLine: true })).join(", ")}`);
  }
  return `${line}\n${body.join("\n")}`;
}

function summarizeRead(entries, parseErrors, filePath) {
  if (!entries.length) {
    const parseNote = parseErrors.length ? ` (${parseErrors.length} malformed line(s) skipped)` : "";
    return `No matching entries in ${filePath}.${parseNote}`;
  }
  const header = `Shared context: ${entries.length} entr${entries.length === 1 ? "y" : "ies"} from ${filePath}`;
  const errorLine = parseErrors.length ? `\nNote: skipped ${parseErrors.length} malformed JSONL line(s).` : "";
  const body = entries.map((entry, idx) => formatEntry(entry, idx)).join("\n\n");
  return `${header}${errorLine}\n\n${body}`;
}

function toolText(text, isError = false) {
  const result = {
    content: [{ type: "text", text: sanitizeDisplayText(text) }],
  };
  if (isError) {
    result.isError = true;
  }
  return result;
}

function toolJson(obj) {
  return {
    content: [{ type: "text", text: JSON.stringify(obj, null, 2) }],
  };
}

function makeEntryBase(kind, args) {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    kind,
    project: normalizeProject(args.project),
    agent: asString(args.agent, "agent", { required: true }),
    session_id: asString(args.session_id, "session_id"),
    task: asString(args.task, "task"),
  };
}

async function callTool(name, rawArgs) {
  const args = isObject(rawArgs) ? rawArgs : {};

  if (name === "append_shared_note") {
    const resolvedSessionId = await resolveSessionIdInput(args.session_id);
    const text = enforceStringMaxLength(
      resolveNoteTextInput(args),
      "text",
      MAX_NOTE_TEXT_CHARS,
    );
    const tags = enforceStringArrayLimits(asStringArray(args.tags, "tags"), "tags");
    const entry = {
      ...makeEntryBase("note", { ...args, session_id: resolvedSessionId }),
      text,
      tags,
    };
    await appendEntry(entry);
    return toolText(
      `Appended note ${entry.id} to ${CONTEXT_FILE}\nproject=${entry.project}\nagent=${entry.agent}\nts=${entry.ts}`,
    );
  }

  if (name === "write_shared_handoff") {
    const resolvedSessionId = await resolveSessionIdInput(args.session_id);
    const summary = enforceStringMaxLength(
      asString(args.summary, "summary", { required: true, trim: false }),
      "summary",
      MAX_HANDOFF_SUMMARY_CHARS,
    );
    const next_steps = enforceStringArrayLimits(asStringArray(args.next_steps, "next_steps"), "next_steps");
    const open_questions = enforceStringArrayLimits(asStringArray(args.open_questions, "open_questions"), "open_questions");
    const files = enforceStringArrayLimits(asStringArray(args.files, "files"), "files");
    const entry = {
      ...makeEntryBase("handoff", { ...args, session_id: resolvedSessionId }),
      summary,
      next_steps,
      open_questions,
      files,
    };
    await appendEntry(entry);
    return toolText(
      `Wrote handoff ${entry.id} to ${CONTEXT_FILE}\nproject=${entry.project}\nagent=${entry.agent}\nts=${entry.ts}`,
    );
  }

  if (name === "read_shared_context") {
    const project = normalizeProject(asString(args.project, "project"));
    const agent = asString(args.agent, "agent");
    const session_id = await resolveSessionIdInput(args.session_id);
    const kind = args.kind === undefined ? undefined : asString(args.kind, "kind");
    if (kind && kind !== "note" && kind !== "handoff") {
      throw new Error("kind must be 'note' or 'handoff'");
    }
    const since = asIsoDateOrUndefined(args.since, "since");
    const limit = asPositiveInt(args.limit, "limit", 20, 1, 200);
    const format = normalizeFormat(args.format);
    const { entries, parseErrors } = await readEntries();
    const filtered = filterEntries(entries, { project, agent, session_id, kind, since });
    const recent = selectRecent(filtered, limit);
    if (format === "json") {
      return toolJson({
        file: CONTEXT_FILE,
        filters: { project, agent, session_id, kind, since, limit },
        count: recent.length,
        parseErrors,
        entries: recent,
      });
    }
    return toolText(summarizeRead(recent, parseErrors, CONTEXT_FILE));
  }

  if (name === "get_latest_handoff") {
    const project = normalizeProject(asString(args.project, "project"));
    const agent = asString(args.agent, "agent");
    const session_id = await resolveSessionIdInput(args.session_id);
    const format = normalizeFormat(args.format);
    const { entries, parseErrors } = await readEntries();
    const handoffs = filterEntries(entries, { project, agent, session_id, kind: "handoff" });
    const latest = handoffs.length ? handoffs[handoffs.length - 1] : null;
    if (!latest) {
      return toolText(`No handoff found in ${CONTEXT_FILE} for project=${project}.`);
    }
    if (format === "json") {
      return toolJson({ file: CONTEXT_FILE, parseErrors, handoff: latest });
    }
    const text = `Latest handoff from ${CONTEXT_FILE}\n${formatEntry(latest, 0)}${
      parseErrors.length ? `\n\nNote: skipped ${parseErrors.length} malformed JSONL line(s).` : ""
    }`;
    return toolText(text);
  }

  if (name === "list_sessions") {
    const options = parseSessionListOptions(args);
    const { project, agent, since, limit, includeUnsessioned, format } = options;
    const { parseErrors, visibleSessions: sessions } = await buildSessionListResult(options);

    if (format === "json") {
      return toolJson({
        file: CONTEXT_FILE,
        project,
        filters: { agent, since, limit, include_unsessioned: includeUnsessioned },
        count: sessions.length,
        parseErrors,
        sessions,
      });
    }

    return toolText(
      summarizeSessionsText(sessions, CONTEXT_FILE, { project, parseErrors }),
    );
  }

  if (name === "choose_session") {
    const options = parseSessionListOptions(args);
    const { project, limit, format } = options;

    const index = asPositiveInt(args.index, "index", undefined, 1, 200);
    const session_id = asString(args.session_id, "session_id");
    const hasIndex = index !== undefined;
    const hasSessionIdArg = session_id !== undefined;
    if (!hasIndex && !hasSessionIdArg) {
      throw new Error("choose_session requires either index or session_id");
    }
    if (hasIndex && hasSessionIdArg) {
      throw new Error("choose_session accepts either index or session_id, not both");
    }

    const { parseErrors, allSessions, visibleSessions } = await buildSessionListResult(options);

    let selected;
    if (hasIndex) {
      selected = visibleSessions[index - 1] || null;
      if (!selected) {
        return toolText(
          `No session at index ${index}. list_sessions returned ${visibleSessions.length} session(s) for project=${project}.`,
          true,
        );
      }
    } else {
      selected = allSessions.find((session) => session.session_id === session_id) || null;
      if (!selected) {
        return toolText(`Session ${session_id} not found in ${CONTEXT_FILE} for project=${project}.`, true);
      }
    }

    const resumeArgs = {
      session_id: selected.session_id,
      project,
      limit: 20,
      format,
    };

    await writeActiveSessionId(selected.session_id);

    if (format === "json") {
      return toolJson({
        file: CONTEXT_FILE,
        project,
        parseErrors,
        selected_session: selected,
        choice: hasIndex ? { index } : { session_id: selected.session_id },
        resume_tool: "resume_session",
        resume_args: resumeArgs,
      });
    }

    const lines = [];
    lines.push(`Selected session from ${CONTEXT_FILE}`);
    lines.push(formatSessionSummary(selected, 0));
    lines.push("");
    lines.push("Next: call resume_session with:");
    lines.push(JSON.stringify(resumeArgs, null, 2));
    if (parseErrors.length) {
      lines.push("");
      lines.push(`Note: skipped ${parseErrors.length} malformed JSONL line(s).`);
    }
    return toolText(lines.join("\n"));
  }

  if (name === "resume_session") {
    const session_id = await resolveSessionIdInput(args.session_id, { required: true });
    const project = normalizeProject(asString(args.project, "project"));
    const limit = asPositiveInt(args.limit, "limit", 20, 1, 200);
    const format = normalizeFormat(args.format);

    const { entries, parseErrors } = await readEntries();
    const resumeData = buildResumeSessionData(entries, parseErrors, { project, session_id, limit });
    if (!resumeData) {
      return toolText(`No entries found for session_id=${session_id} in ${CONTEXT_FILE} (project=${project}).`);
    }

    if (format === "json") {
      return toolJson({ file: CONTEXT_FILE, ...resumeData });
    }

    const lines = [];
    lines.push(`Resume session ${session_id} from ${CONTEXT_FILE}`);
    if (resumeData.summary) {
      lines.push("");
      lines.push(formatSessionSummary(resumeData.summary, 0));
    }
    lines.push("");
    lines.push("latest_handoff:");
    lines.push(resumeData.latest_handoff ? formatEntry(resumeData.latest_handoff, 0) : "(none)");
    lines.push("");
    lines.push("recent_entries:");
    resumeData.entries.forEach((entry, idx) => {
      lines.push(formatEntry(entry, idx));
      if (idx < resumeData.entries.length - 1) lines.push("");
    });
    if (resumeData.parseErrors.length) {
      lines.push("");
      lines.push(`Note: skipped ${resumeData.parseErrors.length} malformed JSONL line(s).`);
    }
    return toolText(lines.join("\n"));
  }

  return toolText(`Unknown tool: ${name}`, true);
}

async function listResources() {
  return {
    resources: [
      {
        uri: "shared-context://raw",
        name: "Raw Shared Context JSONL",
        description: "The raw append-only JSONL file containing notes and handoffs.",
        mimeType: "application/x-ndjson",
      },
      {
        uri: "shared-context://latest",
        name: "Latest Shared Context Handoff",
        description: "Most recent handoff plus a few recent entries, formatted for quick resume.",
        mimeType: "text/plain",
      },
      {
        uri: "shared-context://info",
        name: "Shared Context Server Info",
        description: "Current file path and usage hints.",
        mimeType: "application/json",
      },
    ],
  };
}

async function readResource(uri) {
  if (uri === "shared-context://raw") {
    const raw = await readRawContextFile();
    return {
      contents: [
        {
          uri,
          mimeType: "application/x-ndjson",
          text: raw,
        },
      ],
    };
  }

  if (uri === "shared-context://latest") {
    const { entries, parseErrors } = await readEntries();
    const project = DEFAULT_PROJECT;
    const filtered = filterEntries(entries, { project });
    const latestHandoffs = filtered.filter((e) => e.kind === "handoff");
    const latest = latestHandoffs.length ? latestHandoffs[latestHandoffs.length - 1] : null;
    const recent = selectRecent(filtered, 10);
    const lines = [];
    lines.push(`file: ${CONTEXT_FILE}`);
    lines.push(`default_project: ${DEFAULT_PROJECT}`);
    lines.push("");
    if (latest) {
      lines.push("latest_handoff:");
      lines.push(formatEntry(latest, 0));
      lines.push("");
    } else {
      lines.push("latest_handoff: none");
      lines.push("");
    }
    lines.push("recent_entries:");
    if (!recent.length) {
      lines.push("(none)");
    } else {
      recent.forEach((entry, idx) => {
        lines.push(formatEntry(entry, idx));
        if (idx < recent.length - 1) lines.push("");
      });
    }
    if (parseErrors.length) {
      lines.push("");
      lines.push(`note: skipped ${parseErrors.length} malformed JSONL line(s).`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: "text/plain",
          text: lines.join("\n"),
        },
      ],
    };
  }

  if (uri === "shared-context://info") {
    const activeSessionId = await readActiveSessionId();
    const payload = {
      server: { name: SERVER_NAME, version: SERVER_VERSION },
      file: CONTEXT_FILE,
      lockFile: LOCK_FILE,
      sessionIndexFile: SESSION_INDEX_FILE,
      activeSessionFile: ACTIVE_SESSION_FILE,
      activeSessionId,
      defaultProject: DEFAULT_PROJECT,
      contextFolder: configuredContextFolder,
      contextFileSource: CONTEXT_FILE_SOURCE,
      contextFileDiscovery: CONTEXT_FILE_DISCOVERY,
      tools: tools.map((t) => t.name),
      usage:
        "Use MCP prompt commands for session picking: new_session (first) or resume_#. choose_session/list_sessions are also available. resume_session/read_shared_context/get_latest_handoff can use active session by default if session_id is omitted.",
    };
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
        },
      ],
    };
  }

  throw new Error(`Unknown resource URI: ${uri}`);
}

function promptResponse(description, text) {
  return {
    description: sanitizeDisplayText(description, { singleLine: true }),
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: sanitizeDisplayText(text) }],
      },
    ],
  };
}

function formatPromptSessionDescription(summary) {
  const parts = [
    shortIsoForPrompt(summary.latest_ts),
    `entries:${summary.entry_count}`,
  ];
  if (summary.task) {
    parts.push(`task:${truncateText(summary.task, 36)}`);
  }
  if (summary.latest_handoff_summary) {
    parts.push(`handoff:${truncateText(summary.latest_handoff_summary, 48)}`);
  }
  return parts.join(" | ");
}

async function listPrompts() {
  const project = DEFAULT_PROJECT;
  const { sessions } = await buildPromptSessionList(project);
  const suggestedSessionId = await makeSuggestedSessionId();
  const prompts = [
    {
      name: PROMPT_NEW_SESSION,
      description: `New session (${suggestedSessionId})`,
      arguments: [],
    },
  ];

  sessions.forEach((summary, index) => {
    const ordinal = String(index + 1);
    prompts.push({
      name: `${PROMPT_RESUME_PREFIX}${ordinal}`,
      description: `${sanitizeDisplayText(summary.session_id, { singleLine: true })} - ${formatPromptSessionDescription(summary)}`,
      arguments: [],
    });
  });

  prompts.push({
    name: PROMPT_RESUME_BY_ID,
    description: "Resume a session by explicit session_id",
    arguments: [
      {
        name: "session_id",
        description: "Session id to activate and resume",
        required: true,
      },
    ],
  });

  return { prompts };
}

async function getPrompt(params) {
  const name = asString(params.name, "params.name", { required: true });
  const argumentsObj = isObject(params.arguments) ? params.arguments : {};
  const project = normalizeProject(asString(argumentsObj.project, "project"));

  if (name === PROMPT_NEW_SESSION) {
    const requested = normalizeSessionId(argumentsObj.session_id);
    const sessionId = requested || (await makeSuggestedSessionId());
    await writeActiveSessionId(sessionId);
    const text = [
      `Active session selected: ${sessionId}`,
      `project=${project}`,
      "",
      "Next steps:",
      "1. Call resume_session with no session_id (uses active session).",
      "2. If this is a brand-new session, start working and write notes/handoffs.",
    ].join("\n");
    return promptResponse("Create/select a new active session", text);
  }

  let selectedSessionId;
  if (name === PROMPT_RESUME_BY_ID) {
    selectedSessionId = normalizeSessionId(argumentsObj.session_id);
    if (!selectedSessionId) {
      throw Object.assign(new Error("session_id is required"), { code: -32602 });
    }
  } else if (name.startsWith(PROMPT_RESUME_PREFIX)) {
    const promptIndex = parsePromptResumeIndex(name);
    if (promptIndex === undefined) {
      throw Object.assign(new Error("Invalid prompt session index"), { code: -32602 });
    }
    const { sessions } = await buildPromptSessionList(project);
    const selectedSummary = sessions[promptIndex];
    if (!selectedSummary) {
      throw Object.assign(new Error("Session prompt index out of range"), { code: -32602 });
    }
    selectedSessionId = selectedSummary.session_id;
  } else {
    throw Object.assign(new Error("Prompt not found"), { code: -32602 });
  }

  await writeActiveSessionId(selectedSessionId);
  const { entries, parseErrors } = await readEntries();
  const resumeData = buildResumeSessionData(entries, parseErrors, {
    project,
    session_id: selectedSessionId,
    limit: 8,
  });

  if (!resumeData) {
    const text = [
      `Active session selected: ${selectedSessionId}`,
      `project=${project}`,
      "",
      `No entries found yet for this session in ${CONTEXT_FILE}.`,
      "You can start working and write notes/handoffs.",
    ].join("\n");
    return promptResponse("Select and resume a session", text);
  }

  const lines = [];
  lines.push(`Active session selected: ${selectedSessionId}`);
  lines.push(`project=${project}`);
  if (resumeData.summary) {
    lines.push("");
    lines.push("session_summary:");
    lines.push(formatSessionSummary(resumeData.summary, 0));
  }
  lines.push("");
  lines.push("latest_handoff:");
  lines.push(resumeData.latest_handoff ? formatEntry(resumeData.latest_handoff, 0) : "(none)");
  lines.push("");
  lines.push("next_step:");
  lines.push("Call resume_session with no session_id to load full context.");

  return promptResponse("Select and resume a session", lines.join("\n"));
}

async function handleRequest(message) {
  const { id, method } = message;
  const params = isObject(message.params) ? message.params : {};

  if (method === "initialize") {
    state.initialized = true;
    state.clientProtocolVersion = typeof params.protocolVersion === "string" ? params.protocolVersion : null;
    return {
      protocolVersion: state.clientProtocolVersion || "2024-11-05",
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      instructions:
        "Preferred: use MCP prompts (new_session or resume_#) so the user can pick from a scrollable slash-command list. Then call resume_session (session_id optional if active session is set). During work use append_shared_note and end with write_shared_handoff.",
    };
  }

  if (method === "ping") {
    return {};
  }

  if (method === "notifications/initialized") {
    return null;
  }

  if (method === "notifications/cancelled" || method === "$/cancelRequest") {
    return null;
  }

  if (method === "shutdown") {
    return {};
  }

  if (method === "exit") {
    setImmediate(() => process.exit(0));
    return null;
  }

  if (method === "tools/list") {
    return { tools };
  }

  if (method === "tools/call") {
    const name = asString(params.name, "params.name", { required: true });
    const args = isObject(params.arguments) ? params.arguments : {};
    return await callTool(name, args);
  }

  if (method === "resources/list") {
    return await listResources();
  }

  if (method === "resources/read") {
    const uri = asString(params.uri, "params.uri", { required: true });
    return await readResource(uri);
  }

  if (method === "resources/templates/list") {
    return { resourceTemplates: [] };
  }

  if (method === "prompts/list") {
    return await listPrompts();
  }

  if (method === "prompts/get") {
    return await getPrompt(params);
  }

  if (method === "logging/setLevel") {
    return {};
  }

  throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
}

let inputBuffer = Buffer.alloc(0);
let draining = false;

function findHeaderEnd(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf !== -1) {
    return { index: crlf, separatorLength: 4 };
  }
  const lf = buffer.indexOf("\n\n");
  if (lf !== -1) {
    return { index: lf, separatorLength: 2 };
  }
  return null;
}

function detectIncomingTransportMode() {
  if (!inputBuffer.length) {
    return null;
  }
  let i = 0;
  while (i < inputBuffer.length) {
    const byte = inputBuffer[i];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a) {
      i += 1;
      continue;
    }
    break;
  }
  if (i >= inputBuffer.length) {
    return null;
  }
  const firstByte = inputBuffer[i];
  if (firstByte === 0x7b || firstByte === 0x5b) {
    return "line";
  }
  return "framed";
}

function tryDecodeFrame() {
  const headerEnd = findHeaderEnd(inputBuffer);
  if (!headerEnd) {
    return null;
  }

  const headerText = inputBuffer.slice(0, headerEnd.index).toString("utf8");
  const lengthMatch = headerText.match(/Content-Length:\s*(\d+)/i);
  if (!lengthMatch) {
    throw new Error("Missing Content-Length header");
  }

  const contentLength = Number(lengthMatch[1]);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    throw new Error("Invalid Content-Length");
  }
  if (contentLength > MAX_INBOUND_FRAME_BYTES) {
    throw new Error(
      `Content-Length ${contentLength} exceeds max inbound frame size (${MAX_INBOUND_FRAME_BYTES} bytes)`,
    );
  }

  const bodyStart = headerEnd.index + headerEnd.separatorLength;
  const bodyEnd = bodyStart + contentLength;
  if (inputBuffer.length < bodyEnd) {
    return null;
  }

  const body = inputBuffer.slice(bodyStart, bodyEnd);
  inputBuffer = inputBuffer.slice(bodyEnd);
  if (!state.transportMode) {
    state.transportMode = "framed";
  }
  return body.toString("utf8");
}

function tryDecodeLineDelimitedJson() {
  while (true) {
    const newlineIndex = inputBuffer.indexOf("\n");
    if (newlineIndex === -1) {
      return null;
    }
    const lineBuffer = inputBuffer.slice(0, newlineIndex);
    inputBuffer = inputBuffer.slice(newlineIndex + 1);
    if (lineBuffer.length > MAX_INBOUND_LINE_BYTES) {
      throw new Error(
        `Line-delimited JSON message exceeds max size (${MAX_INBOUND_LINE_BYTES} bytes)`,
      );
    }
    const line = lineBuffer.toString("utf8").trim();
    if (!line) {
      continue;
    }
    if (line.startsWith("{") || line.startsWith("[")) {
      if (!state.transportMode) {
        state.transportMode = "line";
      }
      return line;
    }
    throw new Error("Expected line-delimited JSON-RPC message");
  }
}

function tryDecodeIncomingMessage() {
  if (!state.transportMode) {
    const detectedMode = detectIncomingTransportMode();
    if (!detectedMode) {
      return null;
    }
    state.transportMode = detectedMode;
  }
  if (state.transportMode === "line") {
    return tryDecodeLineDelimitedJson();
  }
  return tryDecodeFrame();
}

async function drainInput() {
  if (draining) return;
  draining = true;
  try {
    while (true) {
      let frame;
      try {
        frame = tryDecodeIncomingMessage();
      } catch (error) {
        logErr("Transport decode error", error);
        sendError(null, -32700, "Parse error", { detail: String(error) });
        inputBuffer = Buffer.alloc(0);
        return;
      }
      if (frame === null) {
        return;
      }

      let message;
      try {
        message = JSON.parse(frame);
      } catch (error) {
        logErr("JSON parse error", error);
        sendError(null, -32700, "Parse error", { detail: String(error) });
        continue;
      }

      try {
        if (!isObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
          throw Object.assign(new Error("Invalid Request"), { code: -32600 });
        }

        const hasId = Object.prototype.hasOwnProperty.call(message, "id");
        const result = await handleRequest(message);
        if (hasId && result !== null) {
          sendResult(message.id, result);
        }
      } catch (error) {
        const code = Number.isInteger(error?.code) ? error.code : -32603;
        const messageText = code === -32601 ? error.message : error?.message || "Internal error";
        if (Object.prototype.hasOwnProperty.call(message, "id")) {
          sendError(message.id, code, messageText);
        } else {
          logErr("Notification handling error", error);
        }
      }
    }
  } finally {
    draining = false;
  }
}

async function runSelfTest() {
  const tempFile = path.join(os.tmpdir(), `contextflowmcp-selftest-${Date.now()}.jsonl`);
  process.env.MCP_SHARED_CONTEXT_FILE = tempFile;
  const note = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    kind: "note",
    project: "self-test",
    agent: "codex",
    text: "Created self-test note",
  };
  const handoff = {
    id: randomUUID(),
    ts: new Date().toISOString(),
    kind: "handoff",
    project: "self-test",
    agent: "claude",
    summary: "Validated append/read path",
    next_steps: ["Point clients to the same file", "Call get_latest_handoff first"],
  };
  await fs.mkdir(path.dirname(tempFile), { recursive: true });
  await fs.appendFile(tempFile, `${JSON.stringify(note)}\n${JSON.stringify(handoff)}\n`, "utf8");
  const raw = await fs.readFile(tempFile, "utf8");
  const { entries, parseErrors } = parseEntries(raw);
  process.stdout.write(`self-test file: ${tempFile}\n`);
  process.stdout.write(`entries: ${entries.length}\n`);
  process.stdout.write(`parseErrors: ${parseErrors.length}\n`);
  process.stdout.write(`${summarizeRead(entries, parseErrors, tempFile)}\n`);
  await fs.unlink(tempFile).catch(() => {});
}

async function main() {
  if (process.argv.includes("--self-test")) {
    await runSelfTest();
    return;
  }

  process.stdin.on("data", (chunk) => {
    const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (
      incoming.length > MAX_INPUT_BUFFER_BYTES ||
      inputBuffer.length + incoming.length > MAX_INPUT_BUFFER_BYTES
    ) {
      inputBuffer = Buffer.alloc(0);
      sendError(null, -32600, `Incoming MCP message exceeds max buffer size (${MAX_INPUT_BUFFER_BYTES} bytes)`);
      return;
    }
    inputBuffer = Buffer.concat([inputBuffer, incoming]);
    drainInput().catch((error) => logErr("Drain error", error));
  });
  process.stdin.on("error", (error) => logErr("stdin error", error));
  process.stdout.on("error", (error) => logErr("stdout error", error));

  process.on("uncaughtException", (error) => {
    logErr("uncaughtException", error);
  });
  process.on("unhandledRejection", (error) => {
    logErr("unhandledRejection", error);
  });
}

main().catch((error) => {
  logErr("fatal", error);
  process.exitCode = 1;
});
