# AgentDX — Improvement Plan (for sign-off)

_Generated from a 15-scope review (every dashboard page + developer experience). Severity: **P0** = breaks trust/correctness or misleads; **P1** = notable UX/value gap; **P2** = polish. Effort: **S** <1h · **M** few hrs · **L** day+._

## Overall read

AgentDX is a genuinely well-built local-first flight recorder with honesty-forward design (verdict-led Insights, log-bucketed histograms, median durations, error boundaries). But the core promise — showing the **honest reality** of agent behaviour — is undercut by metrics that are **fabricated, misattributed, or scoped inconsistently**, plus decorative affordances (fake Export/PDF buttons, hardcoded "policy/approval" framing, dead capture-mode radios) that read as vaporware on the exact surfaces meant to build trust. Single highest-leverage issue: **3 of 5 collectors hardcode `is_error=0`**, silently inverting every cross-agent error comparison.

---

## 🔴 High-impact (the P0s)

1. **Collectors hardcode `is_error=0` for Codex/Cursor/Aider** — every cross-agent error comparison is blind for 3 of 5 agents. _(Collector / cross-app)_
2. **Risk "Introduced vs resolved" fabricates a metric** — "resolved" is just successful tool-call volume; implies bug-fix tracking that doesn't exist. _(Risk)_
3. **Models per-model Latency & Fail% are misattributed** — `tool_calls` has no model column, so multi-model sessions pool/double-count → fabricated reliability numbers. _(Models)_
4. **Token convention drifts across pages** — session detail adds `cache_write`, reports sparkline omits the synthetic filter → same session shows different totals. _(Session detail / Reports)_
5. **Decorative privacy/control affordances that don't work** — wrong Settings DB path, fake Export/PDF/Delete buttons, non-functional capture-mode + redaction radios, "never captured secrets" claim with no redaction code. _(Settings / Collector / Reports)_
6. **Fabricated "policy/approval/consent" framing** on Remote Control + Rules with zero data backing. _(Remote Control / Rules)_
7. **Install front-door is wrong** — `npx agentdx` runs a different stale third-party package, not this tool. _(DX)_
8. **Missing per-agent ship comparison** (commits/pushes/PR-attempts per agent) — the core "which tool ships code" view the product pitches is absent. _(Git Activity)_ — P1 but flagged as high-impact.

---

## ⚡ Quick wins (high value, effort S)

- Fix Settings DB path → reuse `db.ts getDbPath()` _(Settings)_
- Fix install command → `npx @agentdx/agentdx` everywhere _(DX)_
- Remove fake "Policy: Active / approval required" tile; rename `approvalEvents` → "matched tool calls" _(Remote Control)_
- Rename Rules event-log "Blocked"/"Followed" → "Error"/"OK" _(Rules)_
- Align session-detail headline token total with app convention (cache_write) _(Session detail)_
- Make Overview "Rules & policy" error tile period-aware so it reconciles _(Overview)_
- Gate/annotate low-n Insights cards (commit-cost, error-tax) _(Insights)_
- Label Duration as wall-span/approx wherever shown _(Sessions, cross-cutting)_
- Read version from `package.json` instead of hardcoded strings _(Collector/Settings/CLI)_
- Import shared `fmtTok`/`fmtDuration` in sessions-table (drop dup copies) _(Sessions)_
- Drop noisy `/remote-control` substring keyword from detection _(Remote Control)_

---

## By scope

### Cross-cutting (collectors & metric conventions)
- **P0/M** — Codex/Cursor/Aider hardcode `is_error=0`; infer errors from `tool_output` where available; until parity, scope every error metric to reporting agents with a note (don't dilute global rate toward zero).
- **P0/S** — Settle one token convention (input+output+cache_read, exclude synthetic); decide cache_write inclusion once, apply everywhere.
- **P1/S** — Apply the wall-span Duration caveat consistently (label/de-emphasize) everywhere duration appears.
- **P2/S** — Centralize tool→category mapping; prefer exact/normalized names over `includes()` substring matching.

### Overview (/)
- **P0/S** — "Rules & policy" error tile → period-aware so it reconciles with period-filtered "Risk signals".
- **P0/M** — Drive sparklines/heatmap from active period (fix "(30d)" labels) or separate them as a fixed mini-trend block.
- **P1/S** — Derive collector-status strip from `collection_runs`, not hardcoded "idle" + live dot.
- **P1/S** — Period-active repo count (or label repo totals as all-time).
- **P2/S** — "latest 10 of N" on recent-sessions collapsible.
- **P2/M** — Always show by-agent legend; year qualifier / day-week bucketing for short periods.
- **P2/S** — Hash model name → stable color instead of hardcoded map.

### Insights
- **P1/M** — Render the already-computed per-session scatter (effort vs output, log-X, links to /sessions/:id) or delete the wasted query.
- **P1/M** — Base cost-vs-output bars + ring on fresh tokens (input+output), or surface the cache caveat inline.
- **P1/M** — Tighten commit counting: require `is_error=0`, word-boundary `git commit`, exclude `--amend`/heredoc echoes.
- **P1/M** — Make verdict winner, scorecard rows, hero bars link to `/sessions?agent=` (hrefs already produced).
- **P1/S** — Gate/annotate low-n insight cards with minimum-volume guards.
- **P2/S** — Filter edits to `is_error=0`; reconsider summing edits+commits into one "ship".
- **P2/S** — Single-agent state: swap comparison framing for a summary / "add another agent" hint.
- **P2/S** — Differentiate input/output bars by pattern/divider (not opacity alone); check hero % contrast.

### Sessions
- **P1/M** — Clickable column sorting over the full filtered list with active-sort indicator.
- **P1/S** — Label Duration as "Span" + tooltip; de-emphasize.
- **P1/M** — Implement local Export JSON (Blob from filtered rows) or remove the dead "Coming soon" button.
- **P1/S** — Document Risk thresholds via tooltip (exact rule + raw count); consider error-RATE basis, rename to "Errors".
- **P1/M** — Accessibility: SVG role/aria-label on histogram, labels on search+selects, non-color cues.
- **P2/M** — Debounce search; push filter/sort/pagination to SQL as datasets grow.
- **P2/M** — Mirror filters into URL (replaceState); key project facet by full path.
- **P2/S** — Import shared formatters; delete dup copies.

### Session detail
- **P0/S** — Headline `totalTok` → canonical convention (cache_write is the divergence).
- **P1/S** — Label/drop avg wall-span duration (false ms precision); suppress when degenerate.
- **P1/M** — Hide "show output" expander when `tool_output` empty; join user-role tool_result onto matching calls.
- **P1/M** — Real line-level diff (LCS/collapse context) instead of all-old-then-all-new blocks.
- **P1/M** — Populate or remove the hardcoded "Rules & approvals" placeholder card.
- **P1/M** — "Show more"/load-all for the 100-event cap; apply `maxItems` AFTER filtering.
- **P2/M** — Make project/branch/file paths clickable into filtered /sessions.
- **P2/S** — Reuse centralized tool-category helper for Read/Write KPI counters.

### Git Activity (Pull Requests)
- **P0/M** — Aggregate `prSessions` to one row per session (`GROUP BY s.id`) so table/count/tiles reconcile (DISTINCT + per-row evidence CASE duplicates).
- **P1/M** — Relabel intent vs outcome: "PR attempts"/"ran gh pr create"; cross-check exit status; footnote "detected commands".
- **P1/S** — Tighten LIKE matching to command-start patterns; strip heredoc bodies.
- **P1/M** — Point summary tiles at pre-filtered /sessions views.
- **P1/M** — Add per-agent breakdown (commits/pushes/PR-attempts + ship-rate) — the core missing comparison.
- **P2/S** — Scope Branch/Repo tiles to same session population or label denominators.
- **P2/M** — Filter chips + pagination/virtualization; default PR-create rows to top.
- **P2/S** — Remove unreachable empty branch; unify empty copy; absolute-time title on timeAgo.

### Agents & Skills
- **P0/S** — Compute error-rate numerator + denominator from the same source (count `tool_calls` rows per agent, not stored `tool_call_count`).
- **P1/S** — Drop/label avg duration as approx wall time; consider median, skip null durations.
- **P1/M** — Scale bubbles by area (sqrt) not diameter; anchor with absolute session+token numbers.
- **P1/M** — Give Skills a real section (top-skills bar list + empty state); rename bottom card "Tools by kind".
- **P2/M** — Normalize skill-matrix intensity per row/col or log-scale; tie legend to real buckets.
- **P2/S** — Tighten KindFilter categorization to exact names; route counts through `fmtNum`.
- **P2/M** — aria-labels on bubble links; pair error color with glyph/label; matrix contrast.

### Models & Tokens
- **P0/M** — Stop per-model Latency/Fail% (no model column on `tool_calls`); restrict to single-model sessions or derive via `messages.model`, else drop the columns.
- **P0/M** — Make area-chart "click week to drill down" real (URL-encoded ISO week, server-side filter) or remove the affordance.
- **P1/S** — "Other" band for models beyond top 5 (or label "top 5"); add a Total line to tooltip.
- **P1/S** — Define cache-hit-rate in a tooltip; add no-network "cache savings" framing.
- **P1/S** — Soften provider inference: "Provider (inferred)", drop "Local" badge unless endpoint recorded, replace "Connected" with last-used.
- **P2/M** — aria-labels on chart SVGs; keyboard-focusable columns; pattern/border on bands.
- **P2/M** — Index weekly tokens via Map; consider pre-aggregated summary table.

### Repositories
- **P1/M** — Reframe language detection as "file types touched"; parse real extension; weight by write/edit; fix `.tsx` before `.ts` precedence.
- **P1/S** — Render the already-fetched `origin_url` (provider from host, link repo) instead of hardcoded "Local" badge.
- **P1/M** — Cache/materialize language-per-repo or scope scan to write/edit calls / recent sessions.
- **P2/S** — Link repos using the basename the dropdown uses, or show "Filtered: <repo>" chip.
- **P2/M** — Per-repo view (expandable row or /repositories/[path]) with agent split + token timeline.
- **P2/S** — Omit zero-activity repos by default (with "show N inactive" toggle).

### Rules & Policy
- **P0/M** — Fix/scope error metrics to error-reporting agents (depends on collector fix); never show a global rate including agents that can't report errors.
- **P0/S** — Rename event-log "Blocked"/"Followed" → "Error"/"OK"; consider "Tool event log" title.
- **P1/S** — Centralize tool-category lists (shared with event-log-filter); audit against real tool_names; `Math.max(0,...)` the "Other errors" math.
- **P1/M** — Error-prone-tools bar should encode the same dimension as its headline; add min sample-size guard + baseline marker.
- **P1/M** — Deep-link drilldown tiles with the relevant filter; expand error rows to full `tool_output`.
- **P2/M** — Merge the two near-duplicate error/event tables; add agent + time-range filters + explicit window label.
- **P2/S** — Make event-log filter query-backed (or label "last 30 events").

### Risk & Quality
- **P0/M** — Replace "Introduced vs resolved" with honest errors-per-month (or error-rate) series; never present successful-call volume as "resolved".
- **P0/S** — Gauge denominator = real global `COUNT(*)` of sessions with tool calls; label "% of sessions with ≥1 error" (currently divides by LIMIT-30 sample → can exceed 100%).
- **P1/M** — Add a visible Risk column (score/meter via computed maxRisk) with formula caption; sort by it.
- **P1/M** — Drop/cap/caveat duration in risk score; base "long session" on tool-call density not elapsed time.
- **P1/M** — Aggregate finding counts in SQL by signature (not latest 400); rename "Open findings" → "Recurring errors".
- **P2/S** — Default unmatched severity to "Unclassified" not Medium; surface that severity is a text heuristic.
- **P2/S** — aria-label the gauge + bar SVGs; non-color severity cues.
- **P2/S** — Positive zero-error state ("No errors across N sessions") instead of a half-empty 0% page.

### Remote Control
- **P0/S** — Remove hardcoded "Policy: Active / approval required" tile (and its /sessions twin).
- **P0/S** — Rename `approvalEvents` (= remoteCalls.length) + tile to "Matched tool calls"; drop all "approval" wording.
- **P1/S** — Evidence-categories card reflects only the 4 detected categories with live counts (or frame as "what we look for").
- **P1/M** — Tighten keyword detection: drop `/remote-control`, scope to tool_name/structured fields, word boundaries, demote noisy upload/download/browser.
- **P1/M** — Add a remote filter to /sessions; point tiles at it; don't link Policy → /rules.
- **P2/M** — Expandable evidence badges → matched tool calls (self-verifying).
- **P2/S** — Drop/tooltip the whole-session Duration column.

### Reports
- **P0/M** — Replace fake Preview/Generate-PDF spans with working `window.print()` or reuse CsvExport, or remove.
- **P1/S** — Point the four template cards at real destinations (/sessions, /models, /risk, /agents) not one dead #summary anchor.
- **P1/S** — Derive token sparkline from the same synthetic-excluded source as the headline KPI.
- **P1/M** — Sparklines: "30d" caption + hover values + delta; "not enough history" instead of fake flat zero line.
- **P1/M** — Working CSV/JSON/Markdown export (reuse CsvExport).
- **P2/S** — Replace CTO/CFO/Security/Engineering persona badges with what each card measures.
- **P2/S** — Wall-clock caveat + sample size on median-duration figures.

### Collector
- **P0/M** — Remove/honestly reduce the non-functional capture-mode + redaction radios (no such logic exists).
- **P0/M** — Make Export/Re-collect/Delete buttons real (or show the CLI equivalent); currently inert spans.
- **P0/M** — Make "What is captured / Never captured" reflect reality (prompts/tool output stored verbatim, no redaction) or ship redaction before claiming it.
- **P1/S** — Per-source "Last collected" via `MAX` across matching watermark rows; match on `agent::` boundary.
- **P1/S** — Doctor card reflects real DB state (found on statSync success); drop unverifiable "writable".
- **P1/M** — Surface per-source last-run status/errors + staleness from `collection_runs`; link each source to filtered sessions.
- **P2/S** — Read version from package.json; hoist `hostname()` out of JSX.
- **P2/S** — Click-to-copy command blocks; gate "watch mode coming soon".

### Settings
- **P0/S** — Delete local `getDbPath()`, reuse `db.ts` resolver so shown path/size matches the file actually opened.
- **P1/M** — Surface errors text on failed collection-history rows (expandable/tooltip); add duration + per-run summary.
- **P1/M** — "Last collected X ago" readout (+ "Collect now" if a local endpoint exists).
- **P1/M** — Three data-source states (active+sessions / detected-empty / not-found); make Aider scan root configurable (not hardcoded ~/Documents/code).
- **P2/M** — IntersectionObserver for sub-nav active state; ensure every nav id has a DOM target (Database card lacks `id`).
- **P2/S** — Humanize table-row labels; drop the meaningless cross-table "Total rows" sum.
- **P2/S** — Read About version from package.json; add the promised repo/license/changelog links.

### Developer Experience (CLI / install / onboarding)
- **P0/S** — Fix install command everywhere: `npx agentdx` runs a stale alpha; use `npx @agentdx/agentdx` (or claim the unscoped name + bin).
- **P1/S** — Zero-state/help text → real detection paths (Cline → VS Code globalStorage, Cursor → ~/.cursor/projects/); report detected-vs-parsed per agent.
- **P1/S** — Add `import` command to README CLI table; fix `collect` description to name all five agents.
- **P1/M** — Make `--verbose` real: print per-agent collection errors after finalize; distinguish errored-but-nonempty from empty.
- **P1/M** — First-class `agentdx reset`/`clean` + a `where`/status path line so the "delete the file" privacy promise is discoverable.
- **P1/M** — Don't print "live <url>" until the server responds; show "first run is slower" spinner during install + cold compile.
- **P2/S** — Relabel `status` token line to documented convention; keep `<synthetic>` sentinel out of user-facing output.
</content>
