# Contributing to AgentDX

Thanks for your interest in contributing. AgentDX is a local-first flight recorder for AI coding agents, and contributions of all kinds are welcome -- bug fixes, new collectors, dashboard improvements, docs, and tests.

---

## Prerequisites

- **Node.js 18+** (18, 20, or 22 -- CI tests all three)
- **npm** (ships with Node.js)
- **Git**

---

## Setup

```bash
# Clone the repo
git clone https://github.com/navd/agentdx.git
cd agentdx

# Install root dependencies (CLI, collectors, core)
npm install

# Install web dependencies (Next.js dashboard)
cd web && npm install && cd ..
```

### Verify the build

```bash
# Type-check root
npx tsc --noEmit

# Type-check web
cd web && npx tsc --noEmit && cd ..
```

---

## Project Structure

```
agentdx/
  bin/            CLI entry point (agentdx.mjs)
  src/
    collector/    Per-agent data collectors (claude, codex, cursor, aider, cline)
    core/         Database, config, telemetry, types, schema
  web/
    src/
      app/        Next.js pages (12 dashboard pages)
      components/ Reusable UI components (charts, tables, filters)
      lib/        Shared utilities (db access, chart data helpers)
  tests/          Playwright end-to-end tests
  data/           SQLite database (gitignored, created at runtime)
```

---

## Running Locally

```bash
# Collect data from installed agents and start the dashboard
npm run dev

# Or run steps individually
npm run collect   # Collect session data into data/agentdx.db
npm run serve     # Start Next.js dashboard with hot-reload
```

The dashboard runs at `http://localhost:3002` by default.

---

## Tests

AgentDX uses [Playwright](https://playwright.dev/) for end-to-end tests covering CLI output, data crawling, dashboard rendering, data consistency, and interactive UI flows.

```bash
# Install browsers (first time only)
cd web && npx playwright install --with-deps

# Run all tests
npx playwright test

# Run a specific test file
npx playwright test tests/dashboard.spec.ts
```

CI runs tests on Node 18/20/22 across Ubuntu, macOS, and Windows.

---

## Pull Request Process

1. **Fork** the repo and create a branch from `main`.
2. **Make your changes.** Keep commits focused -- one logical change per commit.
3. **Type-check** both root and web (`npx tsc --noEmit`).
4. **Run tests** and make sure they pass.
5. **Open a PR** against `main` with a clear description of what changed and why.

### PR guidelines

- Keep PRs small and reviewable. If a change touches multiple areas, consider splitting it.
- Add or update tests for new functionality.
- If adding a new collector, follow the pattern in `src/collector/` -- export a `collectX(db, dir)` function that returns `{ sessions, messages, toolCalls, errors }`.
- If adding a new dashboard page, add it to the `NAV` array in `web/src/components/sidebar.tsx`.

---

## Code Style

- **TypeScript** throughout (strict mode in both root and web).
- **ESM** (`"type": "module"` in package.json). Use `.js` extensions in import paths for compiled output.
- **No external charting libraries** in the dashboard -- charts are hand-rolled SVG components.
- Use `better-sqlite3` for all database access. Queries go in the page/component that needs them.
- Keep dependencies minimal. Check if something can be done with Node builtins before adding a package.

---

## Reporting Issues

- Search [existing issues](https://github.com/navd/agentdx/issues) first.
- Include your OS, Node version, and agent versions when reporting bugs.
- For data collection issues, run `npx agentdx status` and include the output.

---

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
