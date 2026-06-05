# AgentDX — Design Gap TODO

## Entire Pages Missing

- [x] **Pull Requests page** — list view derived from git push/commit/gh pr tool calls. KPI strip, session table, methodology card
- [x] **Remote Control page** — audit surface for browser/shell automation, KPI strip, evidence schema card

## Dashboard/Overview

- [x] Capture health section (capture rate, error sessions, local-only count, last capture)
- [x] Recent High-Risk Sessions table (separate from recent sessions — sessions with errors, sorted by error count, with risk/status dots)
- [x] Transparency strip (live pulse indicator, capture mode pill, last sync timestamp, link to collector)
- [x] Sync now + Generate report buttons in header
- [x] QTD/YTD in period selector

## Sessions

- [x] Routing column (Local/Cloud pill derived from model provider)
- [x] Risk indicator column (error count badge)
- [x] Export button (JSON export placeholder — "Coming soon")

## Session Detail

- [x] Agent icon tile (large square in header, agent-colored)
- [x] Status/Risk/Capture badges in header
- [x] Risk Findings card (sessions with errors → list error tool calls as findings with severity)
- [x] Skills Used card (builtin tools as pills, grouped by kind)
- [x] Rules & Approvals card (placeholder — "No active rules configured" with link to /rules)
- [x] Reasoning tokens as 4th color in token breakdown (cache write as purple segment)

## Agents

- [x] Agent × Skill Matrix (grid visualization — agents as columns, tools as rows, colored dots by frequency)
- [x] Kind filter dropdown on skills table (All/File/Shell/Agent/Web/Other)

## Models

- [x] Mode badges on provider cards (BYOK/Local/Org derived from provider type)
- [x] Reliability & Routing card (6 metrics: tool calls, cache savings, errors, providers, sessions, avg latency)
- [x] Export CSV button (client component, downloads model usage data)
- [x] Latency + Fail % columns in models table (derived from tool_calls join)

## Repositories

- [x] Provider column (Local badge on all repos)
- [x] Language tags on repo names (derived from file extensions in tool_calls — TS, JS, Python, Rust, Go, Java, Ruby, Web)

## Rules & Policy

- [x] Prevented Damage card (accent bg, shield icon, blocked count, error stats)
- [x] Policy Event Log table (recent tool calls with error/success status, agent, repo, session link)
- [x] 6 KPI strip (total calls, followed, blocked, error rate, sessions affected, distinct tools)
- [x] Type filter dropdown on event log (All/Success/Error/Bash/Read/Write/Other)

## Risk & Quality

- [x] Findings by Category card (6 categories with meter bars)
- [x] Introduced vs Resolved chart (SVG bar chart — errors per month, red/green bars)
- [x] Severity filter dropdown (All/High/Medium/Low)
- [x] Open Findings table (error tool calls as "findings" with category/severity/status)

## Reports

- [x] Audience badges on template cards (CTO/CFO/Security/Engineering)
- [x] Report Builder Preview panel (right sticky — methodology formula, evidence links, generate button)
- [x] Recently Generated reports table (placeholder — "No reports generated yet")

## Collector

- [x] Live indicator with pulse animation
- [x] Install & Verify card (numbered steps with copyable commands)
- [x] What is Captured? card (2-column: captured vs never-captured items)
- [x] Doctor card (terminal with health check results — check dirs exist, DB accessible, recent collection)
- [x] Capture Mode selector (4 radio buttons — metadata-only, redacted, full, local-only — display only for now)
- [x] Local Data Controls card (export JSON/SQLite buttons, delete data danger button)

## Settings

- [x] Left settings nav (scrollspy-style, 6 sections)
- [x] Display panel (theme, default period, items per page — read-only)
- [x] Collection panel (auto-collect toggle, collection interval — read-only)
- [ ] Save/Discard buttons (needs API routes)
- [ ] Editable form inputs (needs API routes)

## Stolen from Codex version

- [x] **Command palette (Cmd+K)** — search/navigate pages, keyboard nav, Escape to close
- [x] **Redaction tester** — interactive redaction preview on Collector page (AWS keys, API keys, emails, connection strings, secrets)
- [x] **Pull Requests sidebar nav** — added to sidebar nav between Sessions and Agents

## Infrastructure

- [ ] git init + .gitignore
- [ ] Watch mode (`agentdx watch`)
- [ ] API routes for collect-on-demand
