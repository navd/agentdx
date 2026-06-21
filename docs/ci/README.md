# AgentDX in CI / git hooks

`agentdx check` produces an **agent diff** for a commit range — AI/human line
split (with confidence), the cost of the sessions behind it, their tool-error
rate, and which changed files touch risk surface or were never human-reviewed.

**P0 is non-blocking** — it always exits 0. It surfaces information; it does not
gate merges (blocking gates are on the roadmap). Attribution is a
confidence-scored heuristic; line counts and cost are exact.

> Telemetry lives on the developer's machine. The pre-push hook below works
> today because the DB is local. In CI the DB must be provided to the runner
> (cache/artifact, or a self-hosted runner that has it).

## Pre-push hook (works locally, today)

`.git/hooks/pre-push` (make it executable: `chmod +x .git/hooks/pre-push`):

```bash
#!/usr/bin/env bash
# Show the agent diff for what you're about to push. Never blocks.
npx -y @agentdx/agentdx check --base origin/main --head HEAD || true
```

## Config (optional)

Drop `.agentdx.json` at the repo root to enable threshold warnings:

```json
{
  "max_session_cost": 25,
  "max_tool_error_rate": 0.2,
  "max_ai_pct": 90,
  "block_if_risk_flag": ["auth", "migration"]
}
```

In P0 these only print warnings. (When blocking lands, the same config drives the gate.)

## GitHub Action

This repo ships a composite action (`action.yml`). Example workflow:

```yaml
name: AgentDX
on: pull_request
permissions:
  contents: read
  pull-requests: write
  security-events: write   # for SARIF upload
jobs:
  agent-diff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }   # need full history for base..head
      # - restore your agentdx.db onto the runner here (cache/artifact), then:
      - uses: navd/agentdx@main
        with:
          db: .agentdx/agentdx.db   # omit if not provided → graceful no-op
```

Without a DB on the runner the action no-ops cleanly (nothing posted). Provide
the DB via cache/artifact, or use a self-hosted runner that has it.
