# Contributing To ContextFlowMCP

Thanks for contributing.

## Before You Start

- Read `README.md` for user behavior and setup.
- Read `MAINTAINER.md` for implementation and compatibility constraints.
- Use Node.js 18+ (`package.json` engines).

## Local Setup

```powershell
npm install
npm start
```

Validation commands:

```powershell
node --check server.mjs
node --check pick-session.mjs
npm run self-test
npm test
```

## What We Accept

- Bug fixes
- Performance improvements
- New MCP usability improvements
- Documentation improvements
- Compatibility fixes for Claude/Codex/Gemini clients

## Compatibility Rules

When changing public behavior, keep backward compatibility where practical.

- Do not break existing tool names without a compatibility path.
- Do not break prompt names without updating docs and migration notes.
- Keep `append_shared_note` compatibility for `text` and `content`.
- Keep shared file format append-only JSONL.

## Pull Request Checklist

1. Explain the problem and the fix.
2. Include exact files changed and rationale.
3. Update docs (`README.md` and/or `MAINTAINER.md`) for behavior changes.
4. Run validation commands locally.
5. Add or update tests if behavior changed.

## Commit Guidance

- Keep commits focused and reviewable.
- Prefer clear, imperative commit messages.
- Recommended style: Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`).

## Reporting Issues

- Use GitHub Issues for bugs and feature requests.
- Use the issue templates in `.github/ISSUE_TEMPLATE`.
- For vulnerabilities, follow `SECURITY.md` and do not post public exploit details.
