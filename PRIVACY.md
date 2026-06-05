# Privacy

**AgentDX is local-first. No telemetry, no analytics, no accounts — nothing about you or your usage is ever sent anywhere.**

AgentDX reads the local logs your AI coding agents already write and stores what it parses in a single SQLite database on your machine. The one and only outbound request it ever makes is an **update check**: a read-only fetch of the latest published version number from the public npm registry, so it can tell you when a new release is out. That request sends no identifiers and no usage data — it only asks "what's the newest version?" You can ignore it entirely (the tool works the same offline).

---

## What AgentDX does

- Reads local agent logs (Claude Code, Codex, Cursor, Aider, Cline) from their existing on-disk locations.
- Writes a single SQLite database at `~/.agentdx/agentdx.db`.
- Serves a dashboard from `localhost` that reads that database.

That is the complete data flow. It begins and ends on your computer.

---

## What leaves your machine

Your data: nothing. Your sessions, prompts, code, tokens, and repo names never leave your computer.

The only outbound request is the version check described above — a `GET` to `registry.npmjs.org` for a version number, sending nothing about you. If you click "Update", AgentDX runs `npm install` to pull the new release (again, a pull — nothing is uploaded). Run offline and everything except the update check behaves identically.

---

## Your data, your control

- Everything lives in `~/.agentdx/agentdx.db`. Delete that file and the data is gone.
- The dashboard binds to `localhost` only.
- No identifiers, hashes, telemetry, or usage pings are ever generated or transmitted.

---

## Sensitive-data hygiene

AgentDX includes a redaction preview in the dashboard (Collector → Redaction tester) so you can see how secrets like API keys, connection strings, and emails are masked. This is purely a local convenience — it never implies anything is transmitted.

---

## In short

No server, no account, no telemetry — nothing about you is ever sent. The single network call is a read-only version check against npm so you know when to update. Disconnect your network and everything but that check works identically.
