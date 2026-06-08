CREATE TABLE IF NOT EXISTS sessions (
    id                TEXT PRIMARY KEY,
    agent             TEXT NOT NULL,
    agent_version     TEXT,
    title             TEXT,
    status            TEXT DEFAULT 'completed',
    project_path      TEXT,
    repository_url    TEXT,
    git_branch        TEXT,
    git_sha           TEXT,
    model_primary     TEXT,
    started_at        INTEGER NOT NULL,
    ended_at          INTEGER,
    duration_ms       INTEGER,
    total_input_tokens    INTEGER DEFAULT 0,
    total_output_tokens   INTEGER DEFAULT 0,
    total_cache_read      INTEGER DEFAULT 0,
    total_cache_write     INTEGER DEFAULT 0,
    turn_count            INTEGER DEFAULT 0,
    tool_call_count       INTEGER DEFAULT 0,
    first_user_message    TEXT,
    source_path           TEXT,
    collected_at          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_path);

CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    parent_id       TEXT,
    role            TEXT NOT NULL,
    model           TEXT,
    content_text    TEXT,
    content_type    TEXT DEFAULT 'text',
    timestamp       INTEGER NOT NULL,
    input_tokens    INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,
    cache_read      INTEGER DEFAULT 0,
    cache_write     INTEGER DEFAULT 0,
    seq             INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

CREATE TABLE IF NOT EXISTS tool_calls (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id      TEXT,
    tool_name       TEXT NOT NULL,
    tool_input      TEXT,
    tool_output     TEXT,
    is_error        INTEGER DEFAULT 0,
    duration_ms     INTEGER,
    timestamp       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
CREATE INDEX IF NOT EXISTS idx_tool_calls_name ON tool_calls(tool_name);

-- Skill / slash-command invocations. One row per invocation.
-- source: 'slash' (user msg `/cmd`), 'command' (<command-name> tag), 'tool' (Skill tool).
CREATE TABLE IF NOT EXISTS skill_invocations (
    id              TEXT PRIMARY KEY,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id      TEXT,
    skill           TEXT NOT NULL,
    source          TEXT NOT NULL,
    timestamp       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_skill_inv_session ON skill_invocations(session_id);
CREATE INDEX IF NOT EXISTS idx_skill_inv_skill ON skill_invocations(skill);

-- File touches derived from tool calls (Edit/Write/Read/apply_patch/etc).
-- One row per (tool_call, file) pair. Powers the knowledge-graph file nodes.
-- op: read | edit | write | create | delete.
CREATE TABLE IF NOT EXISTS file_events (
    id              TEXT PRIMARY KEY,
    tool_call_id    TEXT NOT NULL,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    agent           TEXT,
    file_path       TEXT NOT NULL,
    repo_path       TEXT,
    op              TEXT NOT NULL,
    tool_name       TEXT,
    ext             TEXT,
    lines_added     INTEGER DEFAULT 0,
    lines_removed   INTEGER DEFAULT 0,
    is_error        INTEGER DEFAULT 0,
    timestamp       INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_file_events_path ON file_events(file_path, timestamp);
CREATE INDEX IF NOT EXISTS idx_file_events_session ON file_events(session_id);
CREATE INDEX IF NOT EXISTS idx_file_events_repo ON file_events(repo_path);
CREATE INDEX IF NOT EXISTS idx_file_events_agent ON file_events(agent);
CREATE INDEX IF NOT EXISTS idx_file_events_toolcall ON file_events(tool_call_id);

CREATE TABLE IF NOT EXISTS model_usage (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    model           TEXT NOT NULL,
    input_tokens    INTEGER DEFAULT 0,
    output_tokens   INTEGER DEFAULT 0,
    cache_read      INTEGER DEFAULT 0,
    cache_write     INTEGER DEFAULT 0,
    message_count   INTEGER DEFAULT 0,
    UNIQUE(session_id, model)
);

CREATE INDEX IF NOT EXISTS idx_model_usage_model ON model_usage(model);

-- Sub-agent / workflow transcripts spawned by a parent session (e.g. Claude
-- Code Task tools and Workflow agents). Their token/tool usage is also rolled
-- into the parent session totals; this table keeps the per-sub-agent breakdown
-- for the sub-agent metrics view.
CREATE TABLE IF NOT EXISTS subagents (
    id                TEXT PRIMARY KEY,           -- sub-agent transcript file id
    parent_session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    agent             TEXT,                       -- parent agent, e.g. 'claude-code'
    kind              TEXT,                       -- 'task' | 'workflow'
    workflow_id       TEXT,                       -- wf_xxx when kind='workflow'
    model             TEXT,
    input_tokens      INTEGER DEFAULT 0,
    output_tokens     INTEGER DEFAULT 0,
    cache_read        INTEGER DEFAULT 0,
    cache_write       INTEGER DEFAULT 0,
    tool_call_count   INTEGER DEFAULT 0,
    message_count     INTEGER DEFAULT 0,
    started_at        INTEGER,
    ended_at          INTEGER,
    source_path       TEXT
);

CREATE INDEX IF NOT EXISTS idx_subagents_parent ON subagents(parent_session_id);
CREATE INDEX IF NOT EXISTS idx_subagents_kind ON subagents(kind);

-- Git ground truth for the Authorship & Oversight view. Populated by the git
-- collector from `git log` / `git blame` on each local repo AgentDX has
-- session history for. Line counts here are EXACT (from git); the ai/human
-- attribution is a HEURISTIC (commit↔session correlation + co-author trailers)
-- and always carries a confidence — never present it as ground-truth authorship.
CREATE TABLE IF NOT EXISTS git_commits (
    sha             TEXT PRIMARY KEY,
    repo_path       TEXT NOT NULL,
    author_name     TEXT,
    author_email    TEXT,
    committed_at    INTEGER,
    lines_added     INTEGER DEFAULT 0,
    lines_removed   INTEGER DEFAULT 0,
    files_changed   INTEGER DEFAULT 0,
    coauthors       TEXT,                       -- raw Co-authored-by trailer values
    attribution     TEXT,                       -- ai | human | mixed | unknown
    confidence      REAL DEFAULT 0,             -- 0..1 for the attribution label
    session_id      TEXT,                       -- linked AI session when correlated
    collected_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_git_commits_repo ON git_commits(repo_path, committed_at DESC);
CREATE INDEX IF NOT EXISTS idx_git_commits_attr ON git_commits(attribution);

-- Per-file authorship rollup from `git blame` (surviving lines = "stock").
-- ai/human/mixed lines come from each surviving line's introducing commit's
-- attribution. fan_in = how many other tracked files reference this one
-- (heuristic import graph); -1 means centrality was not computed for the repo.
CREATE TABLE IF NOT EXISTS git_file_authorship (
    repo_path            TEXT NOT NULL,
    file_path            TEXT NOT NULL,
    ai_lines             INTEGER DEFAULT 0,
    human_lines          INTEGER DEFAULT 0,
    mixed_lines          INTEGER DEFAULT 0,
    unknown_lines        INTEGER DEFAULT 0,
    total_lines          INTEGER DEFAULT 0,
    fan_in               INTEGER DEFAULT -1,
    risk_flags           TEXT,                  -- comma list: auth,secret,infra,migration,payment,deploy,config
    last_ai_commit_at    INTEGER,
    last_human_commit_at INTEGER,
    head_sha             TEXT,
    computed_at          INTEGER NOT NULL,
    PRIMARY KEY (repo_path, file_path)
);

CREATE INDEX IF NOT EXISTS idx_git_authorship_repo ON git_file_authorship(repo_path);

CREATE TABLE IF NOT EXISTS repositories (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    path            TEXT UNIQUE NOT NULL,
    origin_url      TEXT,
    name            TEXT,
    session_count   INTEGER DEFAULT 0,
    last_session_at INTEGER,
    total_tokens    INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS collection_state (
    source          TEXT PRIMARY KEY,
    last_file       TEXT,
    last_offset     INTEGER DEFAULT 0,
    last_session_id TEXT,
    last_timestamp  INTEGER,
    updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collection_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at      INTEGER NOT NULL,
    completed_at    INTEGER,
    source          TEXT NOT NULL,
    sessions_added  INTEGER DEFAULT 0,
    messages_added  INTEGER DEFAULT 0,
    tool_calls_added INTEGER DEFAULT 0,
    errors          TEXT,
    status          TEXT DEFAULT 'running'
);
