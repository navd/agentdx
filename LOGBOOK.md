# AgentDX Logbook — Issues & Improvements

## Test Results

- **CLI tests:** 12/12 pass
- **Dashboard tests:** 95/95 pass
- **Total:** 107/107 pass

---

## Phase 3 Completed (Sprint 9-12)

### Sprint 9: Interactive Sessions UX
- **Sessions search & filter**: Client component with text search, agent/model/project dropdown filters, clear filters button
- **Pagination**: 25 items per page, prev/next, page counter
- **Sessions-over-time bar chart**: SVG bar chart on Overview, stacked by agent, with legend
- **Period selector**: 30d / 90d / All segmented control on Overview, filters all queries

### Sprint 10: Forensic Session Detail
- **Timeline event filter**: Client dropdown (All / User prompts / Responses / Tool calls)
- **Enhanced event detection**: Git commit, file write/edit/read, shell commands, subagent events
- **File path extraction**: Shows file path for Read/Write/Edit tool calls
- **Tool usage by category**: Groups tools into Read/Write/Shell/Agent/Web/Other categories
- **Context sources card**: Files read, files written, shell commands, tool types, errors

### Sprint 11: Settings + Collector
- **Settings page** (`/settings`): Data sources with status badges, DB info with table counts, collection history, about section
- **Collector page** (`/collector`): Source status, session counts per agent, DB file size, collection runs table, CLI instructions
- **Sidebar updated**: 9 nav items (added Rules, Risk, Collector)

### Sprint 12: Rules, Risk
- **Rules & Policy** (`/rules`): KPI strip, error-prone tools table with meter bars, recent errors table with session links
- **Risk & Quality** (`/risk`): KPI strip, risk sessions table sorted by error count, category breakdown (errors, long sessions, heavy tool use)

---

## Phase 2 Completed (previous session)

### Codex CLI Collector
- Reads `~/.codex/state_5.sqlite` threads table + JSONL session files
- 14 Codex sessions collected with 2,428 tool calls

### Pages Built (6)
- Overview, Sessions, Session Detail, Models & Tokens, Repositories, Agents & Skills

### Dark Theme Fixes
- Card borders, row hovers, terminal blocks, tag badges

---

## Current Stats

| Metric | Value |
|--------|-------|
| Pages | 9 (Overview, Sessions, Detail, Models, Repos, Agents, Rules, Risk, Collector, Settings) |
| Tests | 107 |
| Sessions | 32 (18 Claude Code + 14 Codex) |
| Messages | 24,384 |
| Tool calls | 11,105 |
| Repos | 11 |
| Models | 4 (claude-opus-4-6, claude-opus-4-7, gpt-5.5, qwen3.6:35b) |

---

## Remaining Work

### Features
- [ ] Watch mode for collector (`agentdx watch`)
- [ ] Reports page with export functionality
- [ ] Diff visualization in session timeline
- [ ] Session comparison view
- [ ] API routes for collect-on-demand from UI

### Polish
- [ ] Session detail: agent icon tiles
- [ ] Session detail: status/risk/capture badges
- [ ] Overview: delta indicators (vs prior period)
- [ ] Sidebar: navigation badges (counts)
- [ ] Better Codex JSONL tool call parsing

### Infrastructure
- [ ] git init + .gitignore
- [ ] npm scripts for dev/build/test
- [ ] README.md
