import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createMcpLineClient, parseToolJson } from "../test-utils/mcp-line-client.mjs";

async function startClient(t, envOverrides = {}) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "contextflowmcp-test-"));
  const contextFile = path.join(tempDir, "shared-context.jsonl");
  const activeSessionFile = path.join(tempDir, "active-session.txt");
  const env = {
    MCP_SHARED_CONTEXT_FILE: contextFile,
    MCP_SHARED_CONTEXT_ACTIVE_SESSION_FILE: activeSessionFile,
    MCP_SHARED_CONTEXT_PROJECT: "security-tests",
    ...envOverrides,
  };
  const client = createMcpLineClient({
    cwd: process.cwd(),
    env,
  });

  t.after(async () => {
    await client.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  await client.initialize();
  return { client, tempDir, contextFile, activeSessionFile };
}

test("append_shared_note schema avoids top-level combinators for Claude compatibility", async (t) => {
  const { client } = await startClient(t);
  const toolsResult = await client.request("tools/list");
  const noteTool = toolsResult.tools.find((tool) => tool.name === "append_shared_note");
  assert.ok(noteTool, "append_shared_note should exist");
  assert.deepEqual(noteTool.inputSchema.required, ["agent"]);
  assert.equal(noteTool.inputSchema.anyOf, undefined);
  assert.equal(noteTool.inputSchema.oneOf, undefined);
  assert.equal(noteTool.inputSchema.allOf, undefined);
});

test("append_shared_note rejects missing text/content at runtime", async (t) => {
  const { client } = await startClient(t);

  const response = await client.callToolRaw("append_shared_note", {
    agent: "claude",
    session_id: "missing-text",
  });
  assert.ok(response.error, "missing text/content should return an error");
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /Missing required string: text \(or content\)/);
});

test("append_shared_note accepts content alias and falls back when text is empty", async (t) => {
  const { client } = await startClient(t);

  const appendResult = await client.callTool("append_shared_note", {
    agent: "claude",
    text: "",
    content: "content-alias-value",
    session_id: "alias-test",
  });
  assert.match(appendResult.content[0].text, /Appended note/);

  const readResult = await client.callTool("read_shared_context", {
    session_id: "alias-test",
    format: "json",
    limit: 10,
  });
  const payload = parseToolJson(readResult);
  assert.equal(payload.count, 1);
  assert.equal(payload.entries[0].text, "content-alias-value");
});

test("writes one JSONL file per session and keeps a shared index file", async (t) => {
  const { client } = await startClient(t);

  await client.callTool("append_shared_note", {
    agent: "codex",
    session_id: "session-a",
    text: "note for session a",
  });
  await client.callTool("append_shared_note", {
    agent: "codex",
    session_id: "session-b",
    text: "note for session b",
  });

  const infoResult = await client.request("resources/read", { uri: "shared-context://info" });
  const infoPayload = JSON.parse(infoResult.contents[0].text);
  const sessionFiles = (await fs.readdir(infoPayload.sessionDataDir)).filter((name) => name.endsWith(".jsonl"));
  assert.equal(sessionFiles.length, 2);

  const indexStat = await fs.stat(infoPayload.sessionIndexFile);
  assert.ok(indexStat.isFile(), "session index file should exist");

  const sessionsResult = await client.callTool("list_sessions", { format: "json" });
  const sessionsPayload = parseToolJson(sessionsResult);
  assert.equal(sessionsPayload.count, 2);
});

test("read_shared_context text output strips ANSI control sequences", async (t) => {
  const { client } = await startClient(t);
  await client.callTool("append_shared_note", {
    agent: "codex",
    session_id: "ansi-test",
    text: "hello \u001b[31mRED\u001b[0m world",
  });

  const readResult = await client.callTool("read_shared_context", {
    session_id: "ansi-test",
    format: "text",
    limit: 5,
  });
  const text = readResult.content[0].text;
  assert.ok(!text.includes("\u001b"), "sanitized output should not contain ESC");
  assert.match(text, /hello RED world/);
});

test("context file size guard blocks oversized session reads", async (t) => {
  const { client } = await startClient(t, {
    MCP_SHARED_CONTEXT_MAX_CONTEXT_FILE_BYTES: "64",
  });

  await client.callTool("append_shared_note", {
    agent: "codex",
    session_id: "oversized-session",
    text: "seed entry",
  });
  const infoResult = await client.request("resources/read", { uri: "shared-context://info" });
  const infoPayload = JSON.parse(infoResult.contents[0].text);
  const sessionFiles = (await fs.readdir(infoPayload.sessionDataDir)).filter((name) => name.endsWith(".jsonl"));
  assert.ok(sessionFiles.length >= 1, "expected at least one session file");
  await fs.writeFile(path.join(infoPayload.sessionDataDir, sessionFiles[0]), `${"x".repeat(200)}\n`, "utf8");

  const response = await client.callToolRaw("read_shared_context", {
    format: "json",
    session_id: "oversized-session",
  });
  assert.ok(response.error, "oversized context should return an error");
  assert.equal(response.error.code, -32603);
  assert.match(response.error.message, /Context file exceeds configured max size/);
});

test("line-delimited parser enforces max line size and recovers", async (t) => {
  const { client } = await startClient(t, {
    MCP_SHARED_CONTEXT_MAX_INBOUND_LINE_BYTES: "256",
  });

  const oversizedLine = JSON.stringify({
    jsonrpc: "2.0",
    method: "ping",
    params: {
      value: "a".repeat(1024),
    },
  });
  client.sendRawLine(oversizedLine);

  const errorMessage = await client.waitForMessage(
    (msg) =>
      msg?.error?.code === -32700
      && typeof msg?.error?.data?.detail === "string"
      && msg.error.data.detail.includes("Line-delimited JSON message exceeds max size"),
  );
  assert.equal(errorMessage.id, null);

  const pingResult = await client.request("ping");
  assert.deepEqual(pingResult, {});
});

test("input buffer size guard rejects oversized stdin chunks and recovers", async (t) => {
  const { client } = await startClient(t, {
    MCP_SHARED_CONTEXT_MAX_INPUT_BUFFER_BYTES: "256",
  });

  client.sendRaw("z".repeat(1024));
  const errorMessage = await client.waitForMessage(
    (msg) =>
      msg?.error?.code === -32600
      && typeof msg?.error?.message === "string"
      && msg.error.message.includes("max buffer size"),
  );
  assert.equal(errorMessage.id, null);

  const pingResult = await client.request("ping");
  assert.deepEqual(pingResult, {});
});

test("auto-discovers context file from client config when env path is unset", async (t) => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "contextflowmcp-home-"));
  const codexConfigPath = path.join(tempHome, ".codex", "config.toml");
  const discoveredContextFile = path.join(tempHome, "shared", "agent-context.jsonl");
  await fs.mkdir(path.dirname(codexConfigPath), { recursive: true });
  await fs.mkdir(path.dirname(discoveredContextFile), { recursive: true });
  await fs.writeFile(
    codexConfigPath,
    [
      "[mcp_servers.contextflow.env]",
      "MCP_SHARED_CONTEXT_FILE = \"~/shared/agent-context.jsonl\"",
      "",
    ].join("\n"),
    "utf8",
  );

  const client = createMcpLineClient({
    cwd: process.cwd(),
    env: {
      HOME: tempHome,
      USERPROFILE: tempHome,
      APPDATA: path.join(tempHome, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(tempHome, "AppData", "Local"),
      XDG_CONFIG_HOME: path.join(tempHome, ".config"),
      MCP_SHARED_CONTEXT_FILE: "",
      MCP_SHARED_CONTEXT_ACTIVE_SESSION_FILE: "",
      MCP_SHARED_CONTEXT_PROJECT: "security-tests",
    },
  });

  t.after(async () => {
    await client.close();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  await client.initialize();
  await client.callTool("append_shared_note", {
    agent: "codex",
    session_id: "autodiscovery",
    text: "auto-discovered write",
  });

  const infoResult = await client.request("resources/read", { uri: "shared-context://info" });
  const infoPayload = JSON.parse(infoResult.contents[0].text);
  assert.equal(path.resolve(infoPayload.file), path.resolve(discoveredContextFile));
  assert.equal(infoPayload.contextFileSource, "auto-discovered-config");
  assert.equal(path.resolve(infoPayload.contextFileDiscovery.configFile), path.resolve(codexConfigPath));
});

test("ignores commented MCP_SHARED_CONTEXT_FILE entries in client config", async (t) => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "contextflowmcp-commented-config-"));
  const codexConfigPath = path.join(tempHome, ".codex", "config.toml");
  const expectedHomeFile = path.join(tempHome, ".mcp-shared-context.jsonl");
  await fs.mkdir(path.dirname(codexConfigPath), { recursive: true });
  await fs.writeFile(
    codexConfigPath,
    [
      "# MCP_SHARED_CONTEXT_FILE = \"~/wrong/path.jsonl\"",
      "; MCP_SHARED_CONTEXT_FILE = \"~/wrong/path-2.jsonl\"",
      "// MCP_SHARED_CONTEXT_FILE = \"~/wrong/path-3.jsonl\"",
      "",
    ].join("\n"),
    "utf8",
  );

  const client = createMcpLineClient({
    cwd: process.cwd(),
    env: {
      HOME: tempHome,
      USERPROFILE: tempHome,
      APPDATA: path.join(tempHome, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(tempHome, "AppData", "Local"),
      XDG_CONFIG_HOME: path.join(tempHome, ".config"),
      MCP_SHARED_CONTEXT_FILE: "",
      MCP_SHARED_CONTEXT_FOLDER: "",
      MCP_SHARED_CONTEXT_ACTIVE_SESSION_FILE: "",
    },
  });

  t.after(async () => {
    await client.close();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  await client.initialize();
  await client.callTool("append_shared_note", {
    agent: "codex",
    session_id: "commented-config",
    text: "commented config ignored",
  });

  const infoResult = await client.request("resources/read", { uri: "shared-context://info" });
  const infoPayload = JSON.parse(infoResult.contents[0].text);
  assert.equal(path.resolve(infoPayload.file), path.resolve(expectedHomeFile));
  assert.equal(infoPayload.contextFileSource, "home-default");
});

test("falls back to home context file when no env or discoveries exist", async (t) => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "contextflowmcp-home-fallback-"));
  const expectedHomeFile = path.join(tempHome, ".mcp-shared-context.jsonl");
  const client = createMcpLineClient({
    cwd: process.cwd(),
    env: {
      HOME: tempHome,
      USERPROFILE: tempHome,
      APPDATA: path.join(tempHome, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(tempHome, "AppData", "Local"),
      XDG_CONFIG_HOME: path.join(tempHome, ".config"),
      MCP_SHARED_CONTEXT_FILE: "",
      MCP_SHARED_CONTEXT_FOLDER: "",
      MCP_SHARED_CONTEXT_ACTIVE_SESSION_FILE: "",
      MCP_SHARED_CONTEXT_PROJECT: "security-tests",
    },
  });

  t.after(async () => {
    await client.close();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  await client.initialize();
  await client.callTool("append_shared_note", {
    agent: "codex",
    session_id: "home-fallback",
    text: "home fallback write",
  });

  const infoResult = await client.request("resources/read", { uri: "shared-context://info" });
  const infoPayload = JSON.parse(infoResult.contents[0].text);
  assert.equal(path.resolve(infoPayload.file), path.resolve(expectedHomeFile));
  assert.equal(infoPayload.contextFileSource, "home-default");
});

test("uses MCP_SHARED_CONTEXT_FOLDER for shared context storage root", async (t) => {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "contextflowmcp-folder-env-"));
  const sharedFolder = path.join(tempHome, "shared-contexts");
  const expectedFile = path.join(sharedFolder, ".mcp-shared-context.jsonl");
  const client = createMcpLineClient({
    cwd: process.cwd(),
    env: {
      HOME: tempHome,
      USERPROFILE: tempHome,
      APPDATA: path.join(tempHome, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(tempHome, "AppData", "Local"),
      XDG_CONFIG_HOME: path.join(tempHome, ".config"),
      MCP_SHARED_CONTEXT_FILE: "",
      MCP_SHARED_CONTEXT_FOLDER: sharedFolder,
      MCP_SHARED_CONTEXT_ACTIVE_SESSION_FILE: "",
    },
  });

  t.after(async () => {
    await client.close();
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  await client.initialize();
  await client.callTool("append_shared_note", {
    agent: "codex",
    session_id: "folder-env",
    text: "folder env write",
  });

  const infoResult = await client.request("resources/read", { uri: "shared-context://info" });
  const infoPayload = JSON.parse(infoResult.contents[0].text);
  assert.equal(path.resolve(infoPayload.file), path.resolve(expectedFile));
  assert.equal(infoPayload.contextFileSource, "env-folder");
  assert.equal(path.resolve(infoPayload.contextFileDiscovery.folder), path.resolve(sharedFolder));
});
