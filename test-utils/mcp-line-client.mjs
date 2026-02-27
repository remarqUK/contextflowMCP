import { spawn } from "node:child_process";

function makeTimeout(ms, message) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
    timer.unref?.();
  });
}

export function parseToolJson(toolResult) {
  const text = toolResult?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new Error("Tool result did not contain text content");
  }
  return JSON.parse(text);
}

export function createMcpLineClient({ cwd, env = {} } = {}) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let nextId = 1;
  let stdoutBuffer = "";
  let stderrBuffer = "";
  const pendingById = new Map();
  const messageWaiters = [];
  const queuedMessages = [];

  function handleMessage(message) {
    if (message && Object.prototype.hasOwnProperty.call(message, "id") && pendingById.has(message.id)) {
      const resolve = pendingById.get(message.id);
      pendingById.delete(message.id);
      resolve(message);
      return;
    }

    queuedMessages.push(message);
    for (let i = 0; i < messageWaiters.length; i += 1) {
      const waiter = messageWaiters[i];
      if (waiter.predicate(message)) {
        messageWaiters.splice(i, 1);
        waiter.resolve(message);
        return;
      }
    }
  }

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += String(chunk);
    while (true) {
      const idx = stdoutBuffer.indexOf("\n");
      if (idx === -1) {
        return;
      }
      const line = stdoutBuffer.slice(0, idx).trim();
      stdoutBuffer = stdoutBuffer.slice(idx + 1);
      if (!line) {
        continue;
      }
      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      handleMessage(parsed);
    }
  });

  child.stderr.on("data", (chunk) => {
    stderrBuffer += String(chunk);
  });

  async function requestRaw(method, params = {}, timeoutMs = 4000) {
    if (child.killed) {
      throw new Error("MCP child process is not running");
    }
    const id = nextId;
    nextId += 1;
    const payload = { jsonrpc: "2.0", id, method, params };
    const resultPromise = new Promise((resolve) => {
      pendingById.set(id, resolve);
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return Promise.race([
      resultPromise,
      makeTimeout(timeoutMs, `Timed out waiting for MCP response id=${id} method=${method}`),
    ]);
  }

  async function request(method, params = {}, timeoutMs = 4000) {
    const response = await requestRaw(method, params, timeoutMs);
    if (response.error) {
      const error = new Error(response.error.message || "MCP request failed");
      error.response = response;
      throw error;
    }
    return response.result;
  }

  async function callTool(name, args = {}, timeoutMs = 4000) {
    return request("tools/call", { name, arguments: args }, timeoutMs);
  }

  async function callToolRaw(name, args = {}, timeoutMs = 4000) {
    return requestRaw("tools/call", { name, arguments: args }, timeoutMs);
  }

  function sendRaw(text) {
    child.stdin.write(text);
  }

  function sendRawLine(line) {
    child.stdin.write(`${line}\n`);
  }

  async function waitForMessage(predicate, timeoutMs = 4000) {
    const queuedIndex = queuedMessages.findIndex(predicate);
    if (queuedIndex !== -1) {
      const [msg] = queuedMessages.splice(queuedIndex, 1);
      return msg;
    }
    return Promise.race([
      new Promise((resolve) => {
        messageWaiters.push({ predicate, resolve });
      }),
      makeTimeout(timeoutMs, "Timed out waiting for matching MCP message"),
    ]);
  }

  async function initialize() {
    return request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: {
        name: "contextflowmcp-tests",
        version: "0.0.0",
      },
    });
  }

  async function close() {
    for (const [id, resolve] of pendingById.entries()) {
      pendingById.delete(id);
      resolve({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: "MCP client closed" },
      });
    }
    try {
      await requestRaw("shutdown", {}, 1000);
    } catch {
      // Ignore shutdown failure during teardown.
    }
    try {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "exit" })}\n`);
    } catch {
      // Ignore write errors if process already closed.
    }
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      makeTimeout(1000, "Timed out waiting for MCP process to exit"),
    ]).catch(() => {
      child.kill("SIGTERM");
    });
  }

  function getStderr() {
    return stderrBuffer;
  }

  return {
    child,
    initialize,
    request,
    requestRaw,
    callTool,
    callToolRaw,
    sendRaw,
    sendRawLine,
    waitForMessage,
    close,
    getStderr,
  };
}

