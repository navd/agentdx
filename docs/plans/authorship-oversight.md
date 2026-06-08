# AgentDX — Authorship & Oversight ("Who actually wrote this, and where am I losing the plot")

## The four questions to answer

1. **% human vs AI** — repo-level headline + per-file ratio.
2. **Files you should surely review** — ranked queue with *reasons*, not a flat list.
3. **Blindspots** — code AI wrote that you never read or hand-touched, weighted by how central it is.
4. **Losing control / trend** — is the AI:human ratio climbing, is accept-without-review rising, is review latency growing.

The thesis: AgentDX already records *what the AI did* (`file_events`, sessions). The missing half is *git ground truth* — what actually landed in the tree and who introduced it. Join the two and all four questions fall out.

---

## What exists vs what's missing

| Have | Source | Use |
|---|---|---|
| AI file touches (op, ±lines approx, path, ts, session, agent) | `file_events` | Correlate commits → AI sessions; per-file AI activity |
| Session windows (start/end, project_path, git_sha, git_branch) | `sessions` | Time-box AI activity per repo |
| Tool errors per call | `tool_calls.is_error` | Error-density signal per file |

| Missing | Why it matters |
|---|---|
| **Git commits** (sha, author, email, ts, ±lines, files, co-authors) | The only *exact* line-count + the human authorship signal |
| **Git blame** (surviving line → commit) | Truest "% of current code that is AI" — reflects what survived, not churn |
| **Commit→attribution** (ai / human / mixed) | The classification everything else hangs on |
| **Centrality / blast radius** | Can't rank "review this" without knowing what depends on it |

**Do NOT use `file_events.lines_added` for the headline %.** It's a newline count of changed blocks (Edit counts `new_string` as added + `old_string` as removed → double-ish). Use it only to know *which files an AI session touched*, never magnitudes. Magnitudes come from git.

---

## New data layer

### Git collector — `src/collector/git.ts`

Runs each collect, per distinct on-disk repo (derive set from `repositories.path` + `sessions.project_path` that resolve to a real `.git`). Incremental, keyed off HEAD sha in `collection_state`.

1. **Commits** — `git log --numstat --no-merges --pretty=format:'%H%x09%an%x09%ae%x09%aI%x09%P' <since last sha>..HEAD`
   - Capture co-author trailers (`git log --format='%(trailers:key=Co-authored-by)'`).
   - One `git_commits` row + per-file `±lines` folded into authorship rollup.
2. **Blame** — only for files changed since last run (`git diff --name-only <lastSha>..HEAD`). `git blame --line-porcelain <file>` → map each *surviving* line to its commit → bucket by that commit's attribution. Re-blaming only changed files keeps it cheap; full repo only on first run.
3. **Attribution per commit** — classify `ai | human | mixed | unknown`, with `confidence`:
   - **AI-assisted** if commit timestamp falls inside an AI session window for that repo **and** ≥1 changed file overlaps that session's `file_events` (strong).
   - **AI** if a `Co-authored-by: Claude/Codex/...` or known bot trailer/email is present (strong).
   - **Human** if neither, author = the user's own email, no overlapping session (default).
   - **Mixed** if human authored a commit that *also* overlaps AI session edits (human edited on top of AI). Record both.
   - Squash/rebase collapses granularity → drop confidence, flag it.

### New tables

```sql
CREATE TABLE git_commits (
  repo_path TEXT, sha TEXT PRIMARY KEY, author_name TEXT, author_email TEXT,
  committed_at INTEGER, lines_added INTEGER, lines_removed INTEGER,
  files_changed INTEGER, is_merge INTEGER DEFAULT 0,
  attribution TEXT,            -- ai | human | mixed | unknown
  confidence REAL,             -- 0..1
  session_id TEXT,             -- linked AI session when correlated
  collected_at INTEGER
);

CREATE TABLE git_file_authorship (
  repo_path TEXT, file_path TEXT,
  ai_lines INTEGER, human_lines INTEGER, mixed_lines INTEGER, total_lines INTEGER,
  last_ai_commit_at INTEGER, last_human_commit_at INTEGER,
  first_seen_at INTEGER, head_sha TEXT, computed_at INTEGER,
  PRIMARY KEY (repo_path, file_path)
);
```

Both materialized by the collector (idempotent, marker rows like existing `*_v1` heals). Web reads them read-only — no heavy git in the request path.

---

## Metrics & formulas

### Q1 — % human vs AI
- **Headline (per repo / global):** `Σ ai_lines / Σ total_lines` from `git_file_authorship` (blame-based = surviving code).
- **Companion (churn view):** AI vs human `±lines` per week from `git_commits` — shows *flow*, not *stock*. Both shown; labeled distinctly.
- **Per file:** the ai/human/mixed split bar.

### Q2 — Review-priority score (the "surely review" queue)
Per file, a 0–100 score = weighted blend of normalized signals (weights tunable, shown to user):

| Signal | Source | Rationale |
|---|---|---|
| AI authorship % | `git_file_authorship` | More AI = more to verify |
| Blast radius (fan-in) | import graph (below) | Central file failing = wide damage |
| Risk-surface flag | path/name regex: auth, secret, crypto, payment, migration, infra/terraform, `.env`, deploy, middleware, perm | Some files are inherently load-bearing |
| Churn velocity | `git_commits` recent ±lines | Hot files drift fast |
| **Never human-reviewed** | `git_file_authorship.human_lines==0` AND no human-session read in `file_events` | Pure AI, zero human eyes |
| Error density | `tool_calls.is_error` ∩ file's `file_events` | AI struggled here |
| Test gap | no sibling/`tests/` file touches it | Unverified by tests *and* unread |

Output: ranked table, each row carrying *reason chips* ("92% AI · central · touches auth · never reviewed · no tests") so it's explainable, not a black-box number.

### Q3 — Blindspot score
`blindspot = ai_lines × centrality × (1 − human_touch)` where `human_touch ∈ {0,1}` from any human commit OR human-session read of the file.
- Surfaces "dark dependencies": files AI created/imports that no human commit ever references.
- Surfaces "write-once" clusters: files born in a single AI session burst and never revisited by anyone.

### Q4 — Control trend (time series, weekly)
- **AI:human authored-line ratio** per week (climbing = losing ground).
- **Accept-without-review rate**: share of AI commits with *no* subsequent human edit to those files within N days.
- **Review latency**: median time from AI commit → next human commit on same files; trend arrow.
- **Velocity gap**: AI lines/week vs human read+edit events/week (comprehension capacity proxy).
- **Blast-radius creep**: are AI edits increasingly landing in high-fan-in files.

### Centrality without external libs
Language-agnostic import/require/include regex pass over tracked files → fan-in (how many files import X). Cheap, approximate, language-aware enough. **If `.codegraph/` exists for that repo, use `codegraph_impact` instead (exact).** Degrade gracefully + label "centrality: heuristic|codegraph|unavailable".

---

## Honesty / confidence rules (this project's whole reputation is metric honesty)

- Blame line counts are **exact**; the **ai/human label is heuristic** → always show confidence, never claim "AI wrote these exact lines." Language: *"introduced in AI-assisted commits."*
- Show **coverage**: "analyzed 4/7 repos (3 are remote-only / no local .git)." Never imply 100% when partial.
- Exclude vendored/generated/lockfiles (reuse `file-events.ts` NOISE filters + `.gitattributes linguist-generated` + lockfile globs) — they'd inflate either side.
- Surface the squash/rebase confidence hit explicitly where it applies.

---

## Web surface — new page "Authorship & Oversight"

Repo selector at top. Then:
1. **Headline ring** — % AI vs human vs mixed (surviving lines). Center = AI %. Segments clickable → file list.
2. **Control trend area chart** — AI vs human lines/week + the three trend gauges (accept-without-review, review latency, velocity gap) with arrows.
3. **Authorship treemap** — files sized by `total_lines`, colored by AI% (green→red). Click → file detail / `/sessions?file=`.
4. **Review queue** — ranked table (Q2) with reason chips + score; click → file detail / owning sessions.
5. **Blindspots panel** — Q3 list: AI-authored, zero human touch, central. The "you should look here and haven't" board.

Fits the existing graphics-driven redesign plan (ring/area/treemap components already specced).

---

## Edge cases & perf
- First blame run is O(repo) → run in collector (background), not request path; cache by HEAD sha; thereafter only changed files.
- Monorepo / nested repos: key everything by `repo_path`.
- Remote-only or deleted-locally repos: can't blame → mark unanalyzable, count in coverage.
- Git author email is the human's → stays local (project is local-first), no exfil.
- Renames: `git log --follow` per-file blame handles continuity; rename map best-effort.

---

## Build phases (when greenlit)
1. **Collector**: `git.ts` + 2 tables + commit attribution + blame rollup + NOISE reuse. Idempotent marker.
2. **Centrality**: import-graph fan-in pass (+ optional codegraph hook).
3. **Scoring lib** (`web/src/lib/oversight.ts`): review-priority, blindspot, trend queries — pure SQL + weights.
4. **Page + charts**: ring/area/treemap/review-queue/blindspots.
5. **Verify**: synthetic repo with known AI/human split → assert %; coverage + confidence labels render; honesty audit.

---

## Resolved product decisions (locked)
- **Headline basis**: **Both equal** — surviving-lines (blame, "stock") AND churn (commits, "flow") shown as two co-equal hero numbers, labeled distinctly. No single primary.
- **Mixed commits**: **Split the lines** — per-line blame; AI lines stay AI, hand-edited lines become human; `mixed_lines` bucket retained for files containing both.
- **Scope**: **All local repos** — every repo with session history that resolves to a real local `.git`. First blame run heavier (background, cached by HEAD sha); coverage reported for repos that can't be analyzed.
- **"Reviewed" definition**: **Commit OR human read** — a human-authored commit touching the file, OR a human-driven session that read it, both count as reviewed (lenient). Drives `human_touch` in Q3.
