# AgentDX Homebrew Tap

Install AgentDX via Homebrew.

## Installation

```bash
brew tap navd/tap
brew install agentdx
```

## Upgrading

```bash
brew upgrade agentdx
```

## Uninstalling

```bash
brew uninstall agentdx
brew untap navd/tap
```

## How It Works

The formula installs AgentDX from the npm registry into a Homebrew-managed
prefix. The CLI binary (`agentdx`) is symlinked into your PATH automatically.

## Tap Repository

The canonical Homebrew tap lives at
[navd/homebrew-tap](https://github.com/navd/homebrew-tap).
This directory contains the source formula and CI workflow that pushes
updates to that tap on every GitHub release.

## Requirements

- macOS or Linux
- Node.js >= 18 (installed automatically as a Homebrew dependency)
