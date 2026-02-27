import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { parsePositiveEnvInt, sanitizeDisplayText } from "./lib/common.mjs";

const NO_SESSION_BUCKET = "(no-session-id)";
const MAX_CONTEXT_FILE_BYTES = parsePositiveEnvInt("MCP_SHARED_CONTEXT_MAX_CONTEXT_FILE_BYTES", 50 * 1024 * 1024);

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

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }
    if (token === "--help") {
      out.help = true;
      continue;
    }
    if (token === "--json") {
      out.json = true;
      continue;
    }
    if (token === "--no-save") {
      out.noSave = true;
      continue;
    }
    if (token === "--non-interactive") {
      out.nonInteractive = true;
      continue;
    }
    const eqIndex = token.indexOf("=");
    if (eqIndex !== -1) {
      out[token.slice(2, eqIndex)] = token.slice(eqIndex + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = true;
    }
  }
  return out;
}

function usage() {
  return [
    "Usage: node pick-session.mjs [options]",
    "",
    "Interactive picker for shared-context sessions.",
    "First option is always 'New session'. Use arrows and Enter.",
    "",
    "Options:",
    "  --file <path>              Shared context JSONL path",
    "  --project <name>           Project filter (default: MCP_SHARED_CONTEXT_PROJECT or cwd name)",
    "  --active-file <path>       Active session file path",
    "  --limit <n>                Max existing sessions shown (default: 50)",
    "  --prefix <text>            Prefix for fallback generated ids when no Git branch is available (default: session)",
    "  --json                     Print JSON output instead of plain session id",
    "  --no-save                  Do not save selection to active session file",
    "  --non-interactive          Non-TTY mode: uses --select",
    "  --select <new|first|index:n|id:session_id>",
    "  --help",
    "",
  ].join("\n");
}

async function readContextFile(contextFile) {
  try {
    const stat = await fs.stat(contextFile);
    if (stat.size > MAX_CONTEXT_FILE_BYTES) {
      throw new Error(
        `Context file exceeds configured max size (${MAX_CONTEXT_FILE_BYTES} bytes): ${contextFile}`,
      );
    }
    return await fs.readFile(contextFile, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

function parseEntries(rawText) {
  const entries = [];
  const lines = rawText.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        entries.push(parsed);
      }
    } catch {
      // Ignore malformed lines in picker mode.
    }
  }
  return entries;
}

function truncate(value, max = 80) {
  if (typeof value !== "string") return undefined;
  const text = sanitizeDisplayText(value, { singleLine: true }).trim();
  if (!text) return undefined;
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function buildSessionSummaries(entries, project, limit) {
  const sessions = new Map();

  entries.forEach((entry, fileIndex) => {
    if (entry.project !== project) return;
    const sessionId = typeof entry.session_id === "string" ? entry.session_id.trim() : "";
    if (!sessionId) return;
    if (sessionId === NO_SESSION_BUCKET) return;

    let summary = sessions.get(sessionId);
    if (!summary) {
      summary = {
        session_id: sessionId,
        task: undefined,
        latest_ts: undefined,
        latest_ts_ms: Number.NEGATIVE_INFINITY,
        latest_file_index: -1,
        entry_count: 0,
        handoff_count: 0,
        latest_handoff_summary: undefined,
      };
      sessions.set(sessionId, summary);
    }

    summary.entry_count += 1;
    if (entry.kind === "handoff") summary.handoff_count += 1;
    summary.latest_file_index = fileIndex;
    if (typeof entry.task === "string" && entry.task.trim()) {
      summary.task = entry.task.trim();
    }
    if (entry.kind === "handoff") {
      const handoff = truncate(entry.summary, 110);
      if (handoff) summary.latest_handoff_summary = handoff;
    }

    const ts = typeof entry.ts === "string" ? entry.ts : undefined;
    const tsMs = ts ? Date.parse(ts) : Number.NaN;
    if (Number.isFinite(tsMs) && tsMs >= summary.latest_ts_ms) {
      summary.latest_ts_ms = tsMs;
      summary.latest_ts = new Date(tsMs).toISOString();
    } else if (!summary.latest_ts && ts) {
      summary.latest_ts = ts;
    }
  });

  return [...sessions.values()]
    .sort((a, b) => {
      const aTs = Number.isFinite(a.latest_ts_ms) ? a.latest_ts_ms : Number.NEGATIVE_INFINITY;
      const bTs = Number.isFinite(b.latest_ts_ms) ? b.latest_ts_ms : Number.NEGATIVE_INFINITY;
      if (bTs !== aTs) return bTs - aTs;
      return b.latest_file_index - a.latest_file_index;
    })
    .slice(0, limit);
}

function shortIso(value) {
  if (!value) return "unknown";
  return value.replace("T", " ").replace("Z", "").replace(/\.\d+$/, "");
}

async function getGitBranchName(cwd) {
  const result = await new Promise((resolve) => {
    execFile(
      "git",
      ["branch", "--show-current"],
      { cwd, windowsHide: true, timeout: 1500 },
      (error, stdout) => {
        if (error) {
          resolve(undefined);
          return;
        }
        const branch = String(stdout || "").trim();
        resolve(branch || undefined);
      },
    );
  });
  return result;
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

async function makeNewSessionId(prefix, cwd) {
  const branchName = sanitizeSessionId(await getGitBranchName(cwd));
  if (branchName) {
    return branchName;
  }

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

function buildOptions(summaries, newSessionId) {
  const safeNewSessionId = sanitizeDisplayText(newSessionId, { singleLine: true });
  const options = [
    {
      kind: "new",
      session_id: newSessionId,
      label: "New session",
      detail: `Create a fresh session id (${safeNewSessionId})`,
    },
  ];
  summaries.forEach((summary) => {
    const safeSessionLabel = sanitizeDisplayText(summary.session_id, { singleLine: true });
    const safeTask = summary.task ? sanitizeDisplayText(summary.task, { singleLine: true }) : "(none)";
    const safeHandoff = summary.latest_handoff_summary
      ? sanitizeDisplayText(summary.latest_handoff_summary, { singleLine: true })
      : "(none)";
    options.push({
      kind: "existing",
      session_id: summary.session_id,
      label: safeSessionLabel || "(missing-session-id)",
      detail: `${shortIso(summary.latest_ts)} | entries: ${summary.entry_count} | task: ${safeTask} | handoff: ${safeHandoff}`,
      summary,
    });
  });
  return options;
}

function renderMenu({ options, selectedIndex, project, contextFile }) {
  const rows = process.stdout.rows || 24;
  const pageSize = Math.max(5, rows - 7);
  let windowStart = Math.max(0, selectedIndex - Math.floor(pageSize / 2));
  if (windowStart + pageSize > options.length) {
    windowStart = Math.max(0, options.length - pageSize);
  }
  const visible = options.slice(windowStart, windowStart + pageSize);

  const lines = [];
  lines.push("ContextFlowMCP Session Picker");
  lines.push(`project: ${sanitizeDisplayText(project, { singleLine: true })}`);
  lines.push(`file: ${sanitizeDisplayText(contextFile, { singleLine: true })}`);
  lines.push("Use Up/Down (or j/k), Enter to select, q or Esc to cancel.");
  lines.push("");

  visible.forEach((option, idx) => {
    const absoluteIndex = windowStart + idx;
    const marker = absoluteIndex === selectedIndex ? ">" : " ";
    lines.push(`${marker} ${absoluteIndex + 1}. ${sanitizeDisplayText(option.label, { singleLine: true })}`);
    lines.push(`  ${sanitizeDisplayText(option.detail, { singleLine: true })}`);
  });

  if (windowStart > 0 || windowStart + visible.length < options.length) {
    lines.push("");
    lines.push(`Showing ${windowStart + 1}-${windowStart + visible.length} of ${options.length}`);
  }

  return lines.join("\n");
}

function clearAndWrite(text) {
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(text);
  process.stdout.write("\n");
}

async function runInteractivePicker(options, project, contextFile) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error("Interactive mode requires a TTY terminal.");
  }

  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  let selectedIndex = 0;

  return await new Promise((resolve, reject) => {
    function cleanup() {
      process.stdin.off("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    }

    function onKeypress(_str, key = {}) {
      if (key.sequence === "\u0003" || key.name === "escape" || key.name === "q") {
        cleanup();
        reject(Object.assign(new Error("Cancelled"), { code: "CANCELLED" }));
        return;
      }
      if (key.name === "up" || key.name === "k") {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        clearAndWrite(renderMenu({ options, selectedIndex, project, contextFile }));
        return;
      }
      if (key.name === "down" || key.name === "j") {
        selectedIndex = (selectedIndex + 1) % options.length;
        clearAndWrite(renderMenu({ options, selectedIndex, project, contextFile }));
        return;
      }
      if (key.name === "return" || key.name === "enter") {
        const selected = options[selectedIndex];
        cleanup();
        resolve(selected);
      }
    }

    process.stdin.on("keypress", onKeypress);
    clearAndWrite(renderMenu({ options, selectedIndex, project, contextFile }));
  });
}

function selectNonInteractive(options, selectArg) {
  if (!selectArg || selectArg === "new") {
    return options[0];
  }
  if (selectArg === "first") {
    return options[1] || options[0];
  }
  if (selectArg.startsWith("index:")) {
    const value = Number(selectArg.slice("index:".length));
    if (!Number.isInteger(value) || value < 1 || value > options.length) {
      throw new Error(`Invalid --select index: ${selectArg}`);
    }
    return options[value - 1];
  }
  if (selectArg.startsWith("id:")) {
    const sessionId = selectArg.slice("id:".length).trim();
    const found = options.find((option) => option.session_id === sessionId);
    if (!found) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return found;
  }
  throw new Error(`Unsupported --select value: ${selectArg}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  const project = String(
    args.project || process.env.MCP_SHARED_CONTEXT_PROJECT || path.basename(process.cwd()) || "default",
  ).trim();
  const contextFile = path.resolve(
    expandHomePath(args.file || process.env.MCP_SHARED_CONTEXT_FILE || "~/.shared-context/shared-context.jsonl"),
  );
  const activeFile = path.resolve(
    expandHomePath(
      args["active-file"] ||
        process.env.MCP_SHARED_CONTEXT_ACTIVE_SESSION_FILE ||
        path.join(path.dirname(contextFile), "active-session.txt"),
    ),
  );
  const limit = Number.isInteger(Number(args.limit)) ? Math.max(1, Number(args.limit)) : 50;
  const prefix = String(args.prefix || "session");

  const raw = await readContextFile(contextFile);
  const entries = parseEntries(raw);
  const summaries = buildSessionSummaries(entries, project, limit);
  const newSessionId = await makeNewSessionId(prefix, process.cwd());
  const options = buildOptions(summaries, newSessionId);

  const interactive = !args.nonInteractive && process.stdin.isTTY && process.stdout.isTTY;
  const selected = interactive
    ? await runInteractivePicker(options, project, contextFile)
    : selectNonInteractive(options, String(args.select || "new"));

  if (!args.noSave) {
    await fs.mkdir(path.dirname(activeFile), { recursive: true });
    await fs.writeFile(activeFile, `${selected.session_id}\n`, "utf8");
  }

  const payload = {
    session_id: selected.session_id,
    selection: selected.kind,
    project,
    context_file: contextFile,
    active_session_file: activeFile,
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${selected.session_id}\n`);
  }
}

main().catch((error) => {
  if (error && error.code === "CANCELLED") {
    process.exitCode = 130;
    return;
  }
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 1;
});
