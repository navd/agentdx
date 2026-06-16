# AgentDX

**See what your AI coding agents are actually doing.**

A small, local-first tool built by a developer who wanted an honest picture of how the different agentic coding tools — Claude Code, Codex, Cursor, Antigravity — really behave: where the tokens go, which one ships, where the errors pile up. It reads logs your agents already write and shows you the reality. Runs entirely on your machine; nothing ever leaves.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

---

## Install

```bash
npx @agentdx/agentdx
```

Or install once and call it by name:

```bash
npm install -g @agentdx/agentdx
agentdx
```

Homebrew: _coming soon._

---

## Screenshots

One `npx @agentdx/agentdx` and the dashboard opens on your own machine — no account, no upload.

**Overview — the flight recorder at a glance**

![AgentDX overview dashboard](https://cdn.jsdelivr.net/npm/@agentdx/agentdx@0.3.9/docs/screenshots/overview.png)

**Insights — judgements, not just numbers ("which agent actually ships?")**

![AgentDX insights page](https://cdn.jsdelivr.net/npm/@agentdx/agentdx@0.3.9/docs/screenshots/insights.png)

**Models & Tokens — spend, cache hit rate, input vs output**

![AgentDX models and tokens page](https://cdn.jsdelivr.net/npm/@agentdx/agentdx@0.3.9/docs/screenshots/models.png)

**Agents & Skills — every agent, every tool, side by side**

![AgentDX agents page](https://cdn.jsdelivr.net/npm/@agentdx/agentdx@0.3.9/docs/screenshots/agents.png)

---

## What It Does

AgentDX is a free tool that reads the local logs your AI coding agents already write, stores everything in a single SQLite database on your machine, and serves a dashboard so you can see tokens burned, tools called, models used, and errors hit across every agent — and judge which one actually ships. One command, no accounts, no uploads, no telemetry. Nothing ever leaves your computer.

---

## Supported Agents

| Agent | Source | Status |
|---|---|---|
| **Claude Code** | `~/.claude/projects/` | Stable |
| **Cowork (Claude app)** | Claude desktop local agent mode | Stable |
| **Cursor** | `~/.cursor/projects/` | Stable |
| **Codex** | `~/.codex/` | Stable |
| **Antigravity** | `~/.gemini/antigravity/` | Stable |
| **VS Code (Copilot)** | VS Code chat sessions | Stable |
| **Continue.dev** | `~/.continue/sessions/` | Stable |
| **opencode** | `~/.local/share/opencode/opencode.db` | Stable |

AgentDX reads local logs and artifacts. It never intercepts live traffic or modifies agent behavior.

---

## Quick Start

```bash
# 1. Collect session data from all installed agents
npx @agentdx/agentdx collect

# 2. Start the dashboard
npx @agentdx/agentdx serve

# Or do both in one command
npx @agentdx/agentdx
```

The dashboard opens at `http://localhost:3002`. (After `npm install -g @agentdx/agentdx` you can drop the `npx @agentdx/` prefix and just run `agentdx`.)

---

## CLI Commands

Shown with `npx @agentdx/agentdx`; once installed globally, just use `agentdx`.

| Command | Description |
|---|---|
| `agentdx` | Collect data from all agents, then start the dashboard |
| `agentdx collect` | Collect session data only (no dashboard) |
| `agentdx serve` | Start the dashboard only (no collection) |
| `agentdx watch` | Collect, serve, and re-collect on an interval (default: 5 min) |
| `agentdx status` | Show database stats: sessions, messages, tool calls, tokens, models |
| `agentdx import <file>` | Import sessions from a portable JSONL export |

---

## Privacy

AgentDX is **local-first**. No telemetry, no analytics, no accounts, no uploads — your sessions, prompts, code, tokens, and repo names never leave your machine. Data lives in a single SQLite file at `~/.agentdx/agentdx.db`, which you fully control and can delete anytime. The one outbound request is a read-only **update check** against the public npm registry (just the latest version number — nothing about you is sent); ignore it and the tool works the same offline.

Full details in [PRIVACY.md](PRIVACY.md).

---

## License

[MIT](LICENSE)
