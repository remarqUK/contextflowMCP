# ContextFlowMCP

ContextFlowMCP is a small MCP server (stdio) that lets multiple assistants share progress through one append-only JSONL file.

Maintainers: see `MAINTAINER.md` for architecture and amendment guidance.



This an example workflow:

- Claude writes a handoff
- Gemini reads it and continues
- Codex reads the same file and picks up where they left off

## What It Exposes

- `append_shared_note`: add progress notes while working
- `write_shared_handoff`: write a structured handoff for the next assistant
- `read_shared_context`: read recent notes/handoffs from the shared file
- `get_latest_handoff`: fetch the most recent handoff quickly
- `list_sessions`: list resumable work sessions (`session_id`) like a resume picker
- `choose_session`: choose a session from the list (by index or `session_id`)
- `resume_session`: load the latest handoff + recent entries for a chosen `session_id`
- MCP prompt commands: `new_session`, `resume_#`, and `resume_by_id` for session picking

It also exposes read-only MCP resources like `shared-context://raw` and `shared-context://latest`.

## Interactive Picker (MCP-Native)

No extra script is required.

In Claude/Codex, type `/` and pick an MCP prompt from `contextflow`:

- `new_session` (first option)
- `resume_1`, `resume_2`, ... (existing sessions)

Use arrow keys to scroll and press Enter.

Behavior:

- `new_session` is always first
- If you are in a Git repository, `new_session` uses the current branch as `session_id`
- Selected session becomes the active session and tools can omit `session_id`

Optional local picker script (same behavior):

```powershell
node pick-session.mjs
```

## Storage Format

- One shared file, append-only JSONL (`.jsonl`)
- Each line is a JSON object (`note` or `handoff`)
- Safe for multiple MCP server processes using a simple lock file (`.lock`)
- A sidecar session index file (`.sessions-index.json`) is maintained to speed up `list_sessions` and prompt-based session pickers.

## Run

```powershell
node server.mjs
```

Or:

```powershell
npm start
```

## Important: Point All Clients To The Same File

Every client (Gemini / Claude / Codex) must resolve to the same shared context file.

Zero-config first run behavior (when `MCP_SHARED_CONTEXT_FILE` is unset):

- If `MCP_SHARED_CONTEXT_FOLDER` is set, the file becomes `<folder>/.mcp-shared-context.jsonl`.
- Otherwise the server checks common Codex/Claude/Gemini config files for `MCP_SHARED_CONTEXT_FILE`.
- If still not found, it checks common user config folders for existing context files (`.mcp-shared-context.jsonl`, `shared-context.jsonl`, `agent-context.jsonl`).
- If nothing is found, it falls back to `~/.mcp-shared-context.jsonl`.

Recommended env vars:

- `MCP_SHARED_CONTEXT_FILE`: absolute path to the shared JSONL file
- `MCP_SHARED_CONTEXT_FOLDER`: folder containing the shared JSONL file (`<folder>/.mcp-shared-context.jsonl`)
- `MCP_SHARED_CONTEXT_PROJECT` (optional): logical project key for filtering (defaults to `shared`)
- `MCP_SHARED_CONTEXT_ACTIVE_SESSION_FILE` (optional): file storing the currently active session id (defaults to `active-session.txt` next to the shared JSONL)

Security/performance guardrails (optional):

- `MCP_SHARED_CONTEXT_MAX_CONTEXT_FILE_BYTES` (default `52428800`)
- `MCP_SHARED_CONTEXT_MAX_INBOUND_FRAME_BYTES` (default `2097152`)
- `MCP_SHARED_CONTEXT_MAX_INBOUND_LINE_BYTES` (default `2097152`)
- `MCP_SHARED_CONTEXT_MAX_INPUT_BUFFER_BYTES` (default `4194304`)
- `MCP_SHARED_CONTEXT_MAX_NOTE_TEXT_CHARS` (default `20000`)
- `MCP_SHARED_CONTEXT_MAX_HANDOFF_SUMMARY_CHARS` (default `20000`)
- `MCP_SHARED_CONTEXT_MAX_ARRAY_ITEMS` (default `200`)
- `MCP_SHARED_CONTEXT_MAX_ARRAY_ITEM_CHARS` (default `1000`)

Example values:

```text
MCP_SHARED_CONTEXT_FILE=/absolute/path/to/shared/agent-context.jsonl
```

```text
MCP_SHARED_CONTEXT_FOLDER=/absolute/path/to/shared
```

## MCP Config Pattern (Stdio)

Use your client's MCP server config and add a stdio server entry that runs this file.

```json
{
  "mcpServers": {
    "contextflow": {
      "command": "node",
      "args": ["/absolute/path/to/contextflow-mcp/server.mjs"],
      "env": {
        "MCP_SHARED_CONTEXT_FILE": "/absolute/path/to/shared/agent-context.jsonl"
      }
    }
  }
}
```

Notes:

- The exact config file location/shape differs across Claude, Gemini, and Codex clients.
- The key requirement is the same stdio command and the same resolved shared context file.

## Suggested Workflow For All Assistants

1. Use MCP prompt commands (`new_session`, `resume_#`, or `resume_by_id`) to set the active session.
2. Call `resume_session` (you can omit `session_id` if active session is set).
3. Call `append_shared_note` as you make progress.
4. End by calling `write_shared_handoff` with `summary`, `next_steps`, and blockers/questions.

## Example Tool Calls

Write a note:

```json
{
  "agent": "claude",
  "text": "Investigated failing auth flow. Root cause appears to be missing cookie SameSite config.",
  "session_id": "bugfix-auth-cookie",
  "task": "Fix auth cookie regression"
}
```

Compatibility: `append_shared_note` also accepts `content` as an alias for `text`.

Write a handoff:

```json
{
  "agent": "claude",
  "summary": "Found the regression in cookie configuration. No code changes yet.",
  "next_steps": [
    "Update cookie options in auth middleware",
    "Run login flow manually",
    "Add regression test for SameSite setting"
  ],
  "open_questions": [
    "Should staging use Secure cookies behind proxy in local dev?"
  ],
  "files": [
    "src/auth/middleware.ts"
  ],
  "session_id": "bugfix-auth-cookie",
  "task": "Fix auth cookie regression"
}
```

Read recent context:

```json
{
  "limit": 10,
  "session_id": "bugfix-auth-cookie"
}
```

List resumable sessions:

```json
{
  "limit": 20,
  "format": "json"
}
```

Choose a session (by list index):

```json
{
  "index": 1,
  "limit": 20,
  "format": "json"
}
```

Resume a chosen session:

```json
{
  "session_id": "bugfix-auth-cookie",
  "limit": 20,
  "format": "json"
}
```

## Quick Validation

```powershell
npm run self-test
npm test
```

`npm run self-test` checks core JSONL parsing/formatting logic.
`npm test` runs integration tests for schema compatibility and security guards.

## Contributing

Pull requests are welcome. Start with `CONTRIBUTING.md` and `MAINTAINER.md`, then run:

```powershell
node --check server.mjs
node --check pick-session.mjs
npm run self-test
npm test
```

## Collaboration Docs

- Contributor guide: `CONTRIBUTING.md`
- Code of conduct: `CODE_OF_CONDUCT.md`
- Security policy: `SECURITY.md`
- Support guide: `SUPPORT.md`
- Changelog: `CHANGELOG.md`
- License: `LICENSE`
