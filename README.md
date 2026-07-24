# opencode-ci-loop

> You push. The plugin stares down the CI. The agent fixes it on its own.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-bun-f9f1e1.svg?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6.svg?logo=typescript&logoColor=white)](tsconfig.json)
[![opencode plugin](https://img.shields.io/badge/opencode-plugin-000.svg)](https://opencode.ai)

**CI validation loop** plugin for [opencode](https://opencode.ai) — the equivalent of Claude Code desktop's validation loop.

After the agent runs `git push`, the plugin watches GitHub Actions and **injects the CI result (including failure log tails) back into the session**. Red CI becomes a fix instruction; the agent reacts without you asking. Once CI settles, it **keeps watching the PR's reviews** — Copilot's push-time review and human comments that arrive later — and injects those too. With a per-session toggle, TUI toasts, a live visual dashboard, and localized reports (English / Brazilian Portuguese).

## How it works

```mermaid
sequenceDiagram
    participant A as Agent
    participant P as Plugin
    participant GH as GitHub Actions
    A->>P: bash: git push ✅
    P->>GH: gh run list --commit <sha> (poll)
    Note over P: toasts: Waiting for CI… → CI: 1/2 completed
    GH-->>P: all workflows completed
    alt CI green
        P-->>A: noop report (+ PR readiness)
    else CI red
        P-->>A: report with failure logs → "fix this"
        A->>A: fixes and pushes again 🔁
    end
```

1. The `tool.execute.after` hook detects a successful `git push` from the agent
2. An abortable watch polls `gh run list --commit <sha>` until everything completes (or the timeout hits)
3. The report is injected via `session.prompt` — **using the model the session was using**, not the agent default
4. If the branch has an open PR, the report includes whether it's ready to merge and the exact blockers (draft, conflicts, pending review…)

## Review watching

CI green is rarely the end of a PR. Copilot reviews on every push, humans comment minutes or hours later, and an unresolved-conversation rule can flip a PR from mergeable to blocked **without any CI re-running**. So once the CI watch settles on a branch with an open PR, the loop keeps going:

```mermaid
sequenceDiagram
    participant A as Agent
    participant P as Plugin
    participant GH as GitHub
    Note over P: CI settled → reviewing phase
    P->>GH: gh api graphql (review threads + reviews, poll)
    GH-->>P: 🤖 Copilot review (on push)
    P-->>A: review update → "address these comments"
    GH-->>P: 👤 human comment + BLOCKED (unresolved rule)
    P-->>A: review update → "fix, reply, resolve"
    A->>GH: reply (tagged _🤖 via agent_) + resolve
    GH-->>P: all threads resolved → CLEAN
    P-->>A: ✅ ready to merge · [review watch ended]
```

- **What triggers an update** — new review comments or reviews (Copilot or human), threads flipping resolved/unresolved, and `reviewDecision` / `mergeStateStatus` changes (e.g. an unresolved-conversation rule turning the PR `BLOCKED`).
- **Mid-CI** — Copilot's review usually lands before CI finishes; those comments are injected right away so the agent can start fixing in parallel.
- **Batched & deduped** — one injection per poll cycle; each comment/review/state-change is fingerprinted by PR (not commit), so a new push to the same branch never re-notifies already-seen items.
- **The agent-marker contract** — every reply the agent posts to a review thread ends with a line containing the marker (default `_🤖 via agent_`). That marker is the **only** notification filter: marked comments are treated as the agent's own and skipped, while a human commenting from the same account still comes through. Configure it via `review.agentMarker`; add more logins to skip via `review.ignoreAuthors`.
- **When it stops** — the PR is merged or closed, a new push supersedes the watch, or `review.idleTimeoutMs` (default 1h, re-armed on every update) elapses with no new activity.
- **Language** — review reports and toasts follow the `language` option (auto-detected or pinned to `en` / `pt-BR`); comment bodies, logins, and URLs are always shown verbatim.

## Features

- **Push detection** — `tool.execute.after` hook catches the agent's `git push` (ignores `--dry-run` and rejected pushes)
- **CI watch** — polls `gh run list --commit <sha>` until all workflows complete
- **Multi-worktree / multi-repo** — watches every branch pushed from linked worktrees or external repos in parallel, labeling the source (session branch vs. worktree vs. external repo) without dropping the session's earlier watches
- **Context injection** — green CI becomes a noop, red CI becomes a fix instruction with the log tail of every failed run
- **PR readiness** — with an open PR on the branch, the report says whether it can merge and lists the exact blockers
- **Review watching** — after CI settles, keeps polling the PR's review threads and injects new Copilot / human comments, thread resolutions, and review-decision changes (even when no CI re-runs)
- **Agent-marker filter** — the agent's own replies (tagged with a configurable marker) are the only comments filtered out, so it never notifies itself; humans on the same account still come through
- **i18n** — reports and toasts render in English or Brazilian Portuguese, auto-detected from the session or pinned via config
- **Per-session toggle** — `ci_watch` tool (`enable` / `disable` / `status`); tell the agent "turn off the ci loop" anytime
- **TUI toasts** — `Waiting for CI…` → `CI: 1/2 completed` → `CI green/failed`, then review toasts (`Copilot review: 3 comments` → `All threads resolved`) — deduped per transition
- **Live dashboard** — mini HTTP+SSE server at `http://127.0.0.1:4517` with a per-session panel
- **Multi-project** — plugin instances across multiple worktrees share a single dashboard (per-port singleton)
- **Fork-aware** — resolves the push repo via `@{push}` (`gh` alone resolves to the `upstream` remote on forks and misses the runs)

## Requirements

- [GitHub CLI (`gh`)](https://cli.github.com/) authenticated
- Git

## Installation

In your `opencode.json`:

```json
{
  "plugin": ["opencode-ci-loop@git+https://github.com/rubimpassos/opencode-ci-loop.git"]
}
```

Or with options:

```json
{
  "plugin": [
    ["opencode-ci-loop@git+https://github.com/rubimpassos/opencode-ci-loop.git", {
      "autoWatch": true,
      "pollIntervalMs": 15000,
      "timeoutMs": 1800000,
      "failLogLines": 80,
      "dashboard": { "enabled": true, "host": "127.0.0.1", "port": 4517 },
      "language": "auto",
      "review": {
        "enabled": true,
        "pollIntervalMs": 30000,
        "idleTimeoutMs": 3600000,
        "agentMarker": "_🤖 via agent_",
        "ignoreAuthors": []
      }
    }]
  ]
}
```

| Option | Default | Description |
|---|---|---|
| `autoWatch` | `true` | Initial loop state for each session |
| `pollIntervalMs` | `15000` | `gh run list` polling interval |
| `initialDelayMs` | `5000` | Wait after the push before the first poll |
| `timeoutMs` | `1800000` (30min) | Maximum time watching a push |
| `failLogLines` | `80` | Log tail lines per failed run (10–500) |
| `dashboard.enabled` | `true` | Enables the visual panel server |
| `dashboard.host` | `127.0.0.1` | Panel host (keep it on loopback) |
| `dashboard.port` | `4517` | Panel port |
| `language` | `"auto"` | Report/toast language; `"auto"` detects it from the session's messages. Supported: `en`, `pt-BR` |
| `review.enabled` | `true` | Watch PR review comments after CI settles |
| `review.pollIntervalMs` | `30000` | Review-watch polling interval (min 5000) |
| `review.idleTimeoutMs` | `3600000` (1h) | Stop watching after this long with no new review activity (re-armed on every update; min 60000) |
| `review.agentMarker` | `"_🤖 via agent_"` | Marker the agent appends to its own review replies; comments ending with it are the only ones filtered from notifications |
| `review.ignoreAuthors` | `[]` | Extra author logins to ignore (e.g. `["codecov[bot]"]`) |

## Usage

1. Ask the agent to commit and push — the loop kicks in on its own
2. Follow along via toasts or the dashboard (`http://127.0.0.1:4517`)
3. CI failed? The agent receives the report with logs and fixes it without you asking
4. "turn off the ci watch for this session" → the agent calls `ci_watch(action=disable)`

> [!TIP]
> The `ci_watch` tool also instructs the agent to **never** poll CI manually (`sleep`, `gh pr checks`, `gh run watch`) — the result always arrives on its own.

### Dashboard in OpenChamber

Open `http://127.0.0.1:4517` in OpenChamber's **browser/preview** panel to get the live CI panel next to the chat — per-workflow status, spinner while running, and expandable failure logs.

The **PR** tab in OpenChamber's git area also integrates with the plugin: a per-session "CI Monitor" toggle + live status badge (the OpenChamber server proxies to the dashboard; port configurable via `OPENCHAMBER_CI_LOOP_PORT`).

### Dashboard HTTP API

All routes require a loopback `Host` (barrier against DNS rebinding).

| Route | Method | Description |
|---|---|---|
| `/` | GET | Panel page |
| `/state` | GET | `SessionState[]` snapshot |
| `/events` | GET | SSE with live snapshots |
| `/sessions/:id` | GET | State of one session (pure read; never-seen sessions inherit the `autoWatch` default) |
| `/sessions/:id/enabled` | POST | Toggles the session's loop — body `{ "enabled": boolean }`, returns the new `SessionState` |

## Development

```bash
bun install
bun run check   # typecheck + biome + tests
```

## Architecture

```
src/plugin.ts         # wiring: hooks, ci_watch tool, shared singleton
src/registry.ts       # per-session state + CI watch loop + post-CI review loop (abortable)
src/gh.ts             # gh/git integration (injectable exec, fork-aware)
src/gh-review.ts      # PR review snapshot via gh GraphQL (threads, reviews, comments)
src/review.ts         # pure review diff engine + review-cycle evaluator
src/render.ts         # markdown CI report for the prompt + summaries + PR readiness
src/render-review.ts  # markdown review update messages (mid-CI, post-CI, final)
src/notify.ts         # toasts, prompt injection, fingerprint dedupe, locale resolution
src/i18n.ts           # en / pt-BR message catalogs + language detection
src/server.ts         # dashboard HTTP+SSE
src/dashboard.ts      # panel page
```

No runtime dependencies beyond `@opencode-ai/plugin`. Strictly typed, tested with `bun test`.

## License

[MIT](LICENSE)
