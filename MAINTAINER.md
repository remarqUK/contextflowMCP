# ContextFlowMCP Maintainer Guide

This document is for future LLMs/humans making changes to this MCP.

## Scope

This server exists to let multiple agents share progress in one append-only JSONL file and resume work by `session_id`.

Primary entrypoints:

- MCP tools
- MCP prompts (`new_session`, `resume_#`, `resume_by_id`)
- Optional local picker script (`pick-session.mjs`)

## File Map

- `server.mjs`: main MCP server (transport, tools, prompts, resources, storage, cache/index, self-test).
- `pick-session.mjs`: optional local TTY picker that writes the active session file.
- `README.md`: user-facing setup and workflow docs.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, `SUPPORT.md`: collaboration policies.
- `.github/`: issue and pull request templates.

## Runtime Contract

Transport:

- JSON-RPC 2.0 over stdio.
- Supports both framed MCP messages (`Content-Length`) and line-delimited JSON.

Tools (public API):

- `read_shared_context`
- `append_shared_note`
- `write_shared_handoff`
- `get_latest_handoff`
- `list_sessions`
- `choose_session`
- `resume_session`

Prompt names (public API):

- `new_session`
- `resume_1` ... `resume_N`
- `resume_by_id`

## Data Model

Storage files:

- Context JSONL: resolution order is:
  1) `MCP_SHARED_CONTEXT_FILE` when set
  2) `MCP_SHARED_CONTEXT_FOLDER` when set (`<folder>/.mcp-shared-context.jsonl`)
  3) `MCP_SHARED_CONTEXT_FILE` discovered from common Codex/Claude/Gemini config files
  4) existing common context filenames in user config folders
  5) fallback `~/.mcp-shared-context.jsonl`
- Lock file: `${CONTEXT_FILE}.lock`.
- Session index sidecar: `${CONTEXT_FILE}.sessions-index.json`.
- Active session file: `MCP_SHARED_CONTEXT_ACTIVE_SESSION_FILE` (default: `active-session.txt` next to context file).

Entry types:

- `note`: includes `text`.
- `handoff`: includes `summary` and optional arrays (`next_steps`, `open_questions`, `files`).

Important compatibility behavior:

- `append_shared_note` accepts `text` and also `content` as an alias.
- If `text` is missing/empty and `content` is present, handler falls back to `content`.

## Session Semantics

Session resolution order:

1. Explicit `session_id` argument.
2. `MCP_SHARED_CONTEXT_ACTIVE_SESSION` env var.
3. Active session file contents.

If none exists and tool requires it (for example `resume_session`), the call fails with a guidance error.

Important:

- Starting Claude/Codex does not auto-create a session.
- `new_session` prompt sets the active session id, but does not write a note/handoff by itself.

## Performance Design

There are two read paths for sessions:

1. Fast path (index):
   - Uses `${CONTEXT_FILE}.sessions-index.json`.
   - Used by `list_sessions`/prompt listing when filters are simple:
     - no `agent`
     - no `since`
     - `include_unsessioned = false`
2. Fallback path (full scan):
   - Parses full JSONL and computes summaries in memory.

Index lifecycle:

- Lazy build when first needed and missing/stale.
- Incremental update on append while under write lock.
- If index write/load fails, server falls back safely to full scan.
- Deleting the index file is safe; it will be rebuilt.

## Concurrency + Integrity Rules

- Never write context without holding the lock.
- Keep context file append-only.
- Parse must remain tolerant to malformed lines (skip and report parse errors).
- Avoid cache poisoning:
  - Context cache keyed by file signature (`size:mtimeMs`).
  - Torn reads are retried.

## Change Checklist (When Amending)

When adding/changing a tool or prompt:

1. Update schema definitions in `tools`.
2. Update handler logic in `callTool`/`getPrompt`.
3. Preserve backward compatibility where practical (aliases, field aliases).
4. Update docs in `README.md` and this file.
5. Run checks:
   - `node --check server.mjs`
   - `node --check pick-session.mjs`
   - `npm run self-test`
   - `npm test`

When changing session behavior:

1. Validate `list_sessions`, `choose_session`, `resume_session`.
2. Validate prompt flow (`new_session`, `resume_#`, `resume_by_id`).
3. Validate active-session fallback behavior (omit `session_id` in resume/read/write calls).

## Known Gaps / Risks

- `npm run self-test` validates parsing/formatting path.
- `npm test` covers key MCP/security integration flows, but still does not exhaustively fuzz protocol input.
- Client UI for "scrollable list + Enter" is host-controlled; MCP server can expose prompts but cannot force UI behavior.
- `pick-session.mjs` has duplicated session-summary logic and does not currently use the sidecar session index.

## Safe Recovery

- Slow session list: delete `${CONTEXT_FILE}.sessions-index.json` and rerun `list_sessions` to rebuild.
- Stuck lock: lock has stale-lock break logic; if needed, remove `${CONTEXT_FILE}.lock` after confirming no active writer.
- Missing session errors: set active session via `new_session` prompt or `choose_session`.
