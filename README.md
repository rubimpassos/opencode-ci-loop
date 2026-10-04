# opencode-ci-loop

> You push. The plugin stares down the CI. The agent fixes it on its own.

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-bun-f9f1e1.svg?logo=bun)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/typescript-strict-3178c6.svg?logo=typescript&logoColor=white)](tsconfig.json)
[![opencode plugin](https://img.shields.io/badge/opencode-plugin-000.svg)](https://opencode.ai)

**CI validation loop** plugin for [opencode](https://opencode.ai) — the equivalent of Claude Code desktop's validation loop.

After the agent runs `git push`, the plugin watches GitHub Actions and **injects the CI result (including failure log tails) back into the session**. Red CI becomes a fix instruction; the agent reacts without you asking. Once CI settles, it **keeps watching the PR's reviews** — Copilot's push-time review and human comments that arrive later — and injects those too. With a per-session toggle, a live visual dashboard, an OpenChamber extension, and localized reports (English / Brazilian Portuguese).

## How it works

```mermaid
sequenceDiagram
    participant A as Agent
    participant P as Plugin
    participant GH as GitHub Actions
    A->>P: shell: git push ✅
    P->>GH: gh run list --commit <sha> (poll)
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
- **Language** — review reports follow the `language` option (auto-detected or pinned to `en` / `pt-BR`); comment bodies, logins, and URLs are always shown verbatim.

## Features

- **Push detection** — an `execute.after` hook on the `shell` tool catches the agent's `git push` (ignores `--dry-run` and rejected pushes)
- **CI watch** — polls `gh run list --commit <sha>` until all workflows complete
- **Multi-worktree / multi-repo** — watches every branch pushed from linked worktrees or external repos in parallel, labeling the source (session branch vs. worktree vs. external repo) without dropping the session's earlier watches
- **Context injection** — green CI becomes a noop, red CI becomes a fix instruction with the log tail of every failed run
- **PR readiness** — with an open PR on the branch, the report says whether it can merge and lists the exact blockers
- **Review watching** — after CI settles, keeps polling the PR's review threads and injects new Copilot / human comments, thread resolutions, and review-decision changes (even when no CI re-runs)
- **Agent-marker filter** — the agent's own replies (tagged with a configurable marker) are the only comments filtered out, so it never notifies itself; humans on the same account still come through
- **i18n** — reports render in English or Brazilian Portuguese, auto-detected from the session or pinned via config
- **Per-session toggle** — `ci_watch` tool (`enable` / `disable` / `status`); tell the agent "turn off the ci loop" anytime
- **Live dashboard** — mini HTTP+SSE server at `http://127.0.0.1:4517` with a per-session panel
- **Dashboard panel** — sessions labeled by their opencode title, search across titles/repos/branches/PRs, phase + watch filters, and the same PR readiness verdict the report injects (verdict + full blocker list, never a raw `mergeable` flag)
- **Multi-project** — plugin instances across multiple worktrees share a single dashboard (per-port singleton)
- **Fork-aware** — resolves the push repo via `@{push}` (`gh` alone resolves to the `upstream` remote on forks and misses the runs)

## Requirements

- [GitHub CLI (`gh`)](https://cli.github.com/) authenticated
- Git

## Installation

Requires OpenCode **2.x** (tested with 2.0.22). Releases from `v1.0.0` on are V2-only; the last
OpenCode 1.x release is `v0.9.2`.

In your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-ci-loop@git+https://github.com/rubimpassos/opencode-ci-loop.git#v1.0.0"]
}
```

Or with options:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [{
    "package": "opencode-ci-loop@git+https://github.com/rubimpassos/opencode-ci-loop.git#v1.0.0",
    "options": {
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
    }
  }]
}
```

A local checkout works too: point `package` at the repository's absolute directory (OpenCode 2.0.22
rejects paths to a single `.ts` file).

V2 admits reports as queued user prompts, not synthetic messages: a report never interrupts an active
turn, it runs after it (or right away when the session is idle). `ci_watch` is a directly callable tool.
OpenCode 2 has no plugin toast API; use the dashboard or the OpenChamber extension for progress. Diagnostics stay off the terminal in a bounded
`ci-loop-v2.log` under OpenCode's state
directory (`$XDG_STATE_HOME/opencode`, or `~/.local/state/opencode`).

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
| `language` | `"auto"` | Language for reports **and the dashboard panel** (chrome, phase labels, PR blockers); `"auto"` detects it from the session's messages. Supported: `en`, `pt-BR` |
| `review.enabled` | `true` | Watch PR review comments after CI settles |
| `review.pollIntervalMs` | `30000` | Review-watch polling interval (min 5000) |
| `review.idleTimeoutMs` | `3600000` (1h) | Stop watching after this long with no new review activity (re-armed on every update; min 60000) |
| `review.agentMarker` | `"_🤖 via agent_"` | Marker the agent appends to its own review replies; comments ending with it are the only ones filtered from notifications |
| `review.ignoreAuthors` | `[]` | Extra author logins to ignore (e.g. `["codecov[bot]"]`) |

## Usage

1. Ask the agent to commit and push — the loop kicks in on its own
2. Follow along in the dashboard (`http://127.0.0.1:4517`) or the OpenChamber extension
3. CI failed? The agent receives the report with logs and fixes it without you asking
4. "turn off the ci watch for this session" → the agent calls `ci_watch(action=disable)`

> [!TIP]
> The `ci_watch` tool also instructs the agent to **never** poll CI manually (`sleep`, `gh pr checks`, `gh run watch`) — the result always arrives on its own.

### OpenChamber extension

This same folder is both the opencode plugin above and an [OpenChamber](https://openchamber.ai) extension — one install, two roles. In OpenChamber: **Settings → Extensions → Add**, then point it at this folder's path. It requires an OpenChamber fork at or above the version in `package.json`'s `openchamber.engines.openchamber` (currently `>=2.1.1`); this is **not** a capability of upstream OpenChamber, it needs the fork that adds the `loopback` guest contribution.

What it adds once installed:

- **Rail panel** — the same live dashboard as a native OpenChamber panel, searchable and filterable like the standalone page
- **Work Status section** — the current session's CI summary in the chat sidebar, with its own watch toggle
- **Failure-count badge** — the rail icon shows a count of watches whose report isn't clean (not just PR-blocking ones), kept live by an automatic background frame that OpenChamber starts on its own
- **Chat activity rows** — `[ci-loop]` reports and `ci_watch` tool calls render as structured rows in the conversation instead of raw markdown

Installing it is a capability grant, not just a file copy: OpenChamber asks you to approve the extension's `loopback` capability, a server-local connection to `127.0.0.1:<port>` restricted to the exact routes the manifest declares. If the declared port, env var, or route list ever changes (e.g. after an update), OpenChamber asks for reapproval; it never silently widens an existing grant.

**Port matching matters.** The plugin's `dashboard.port` (default `4517`) and OpenChamber server's `OPENCHAMBER_CI_LOOP_PORT` (same default) must agree, the extension talks to whichever port the manifest declares, overridable by that env var. Only one plugin process can own a port; if a second opencode process starts pointing at the same port, the dashboard it binds serves it, and the other is the one the extension sees as **"plugin not running"** until that port frees up or you point one of them elsewhere.

**Transport**: the rail and status section use a live stream when the host supports it, and fall back to polling `/panel/state` every 5 seconds when it doesn't (relay-mediated hosts, for instance). Either way the data is the same `PanelSnapshot`, just delivered differently.

### Dashboard panel

The page renders a view model computed on the server and streamed over `/panel/events`. The client never re-derives status from raw fields, so the panel cannot drift from what the agent was told.

- **Session title first** — the opencode session title is the primary label; the session id stays visible, muted, next to it. The title is fetched when a watch starts and refreshed live from the `session.updated` event; a session with no title yet falls back to its id.
- **PR readiness, not raw fields** — the verdict and the **full blocker list** come from `prReadiness`, the same engine that builds the injected report, so the panel can no longer contradict the report. This replaces the old raw `state · draft · mergeable` line, which could read "mergeable" while the PR was actually blocked (draft, unresolved conversations, branch protection, failing checks…).
- **External checks** — pending or failing PR checks that aren't Actions workflow runs (GitHub Apps, status contexts) are listed on the watch row.
- **Search** — one box filters by session title, session id, project directory, repo, branch, PR number and PR title.
- **Filters** — phase chips (`waiting`, `running`, `green`, `failed`, `reviewing`, `review ended`, `timed out`, `error`) plus a tri-state watch chip (`watch: all` → `watch: on` → `watch: off`). Chips and search combine; a counter reports how many rows the filters hid, a `clear` chip resets them, and a distinct empty state shows when nothing matches.
- **Language** — the panel chrome follows the `language` option (`en` / `pt-BR`); under `"auto"`, each session's own rows render in that session's detected locale, so a multi-project panel can show both at once.

### Dashboard HTTP API

All routes require a loopback `Host` (barrier against DNS rebinding).

| Route | Method | Description |
|---|---|---|
| `/` | GET | Panel page |
| `/state` | GET | `SessionState[]` snapshot |
| `/events` | GET | SSE with live snapshots |
| `/sessions/:id` | GET | State of one session (pure read; never-seen sessions inherit the `autoWatch` default) |
| `/sessions/:id/enabled` | POST | Toggles the session's loop — body `{ "enabled": boolean }`, returns the new `SessionState` |
| `/panel/state?locale=en\|pt-BR` | GET | **Panel-internal.** `PanelSnapshot` — the localized, fully-resolved view model the page renders. `locale` overrides the per-session default; a `watch` entry includes a `failed` boolean (report not clean) |
| `/panel/events?locale=en\|pt-BR` | GET | **Panel-internal.** SSE with live `PanelSnapshot` frames, same `locale` override |

`/state`, `/events`, `/sessions/:id` and `POST /sessions/:id/enabled` are **unchanged** — same `SessionState` payload, same shape, same semantics. The OpenChamber integration is unaffected.

`/panel/state` and `/panel/events` are **internal to the built-in panel and not part of the OpenChamber contract**. Their `PanelSnapshot` payload is pre-localized and pre-resolved for that one page, and it may change with it — read `/state` and `/events` for the stable contract.

## Development

```bash
bun install
bun run check                   # typecheck + biome + tests
bun run build:extension         # bundles panel/status/background into their index.html + main.js
bun run check:extension-build   # verifies the bundled output matches current source
```

The OpenChamber extension entries (`panel/`, `status/`, `background/`) are built against
`@openchamber/sdk`, vendored under `vendor/openchamber-sdk-loopback.tgz` because the loopback host
API it uses isn't in a published SDK release yet (see `vendor/README.md`). To refresh it against a
newer OpenChamber fork checkout:

```bash
bun scripts/sync-openchamber-sdk.ts <path to openchamber checkout>
bun install
```

## Architecture

```
# core loop
src/plugin.ts             # wiring: hooks, ci_watch tool, shared singleton, session-title cache
src/registry.ts           # per-session state + CI watch loop + post-CI review loop (abortable)
src/resolve.ts            # parses `git push` output into watch targets (worktrees, external repos)
src/types.ts              # domain types + the zod config schema
src/session-context.ts    # session model + locale lookup via the opencode client

# GitHub
src/gh.ts                 # gh/git integration (injectable exec, fork-aware)
src/gh-review.ts          # PR review snapshot via gh GraphQL (threads, reviews, comments)
src/review.ts             # pure review diff engine + review-cycle evaluator

# reports and notifications
src/render.ts             # markdown CI report + summaries + prReadiness + externalChecks
src/render-review.ts      # markdown review update messages (mid-CI, post-CI, final)
src/notify.ts             # prompt injection, fingerprint dedupe, locale resolution
src/notify-review.ts      # review fingerprints (keyed by PR) + unseen-delta filtering

# i18n
src/i18n.ts               # Messages contract, catalog registry, detection + resolution
src/i18n-en.ts            # English catalog
src/i18n-pt-br.ts         # Brazilian Portuguese catalog

# dashboard
src/server.ts             # dashboard HTTP+SSE (/state, /events, /panel/*, session control)
src/panel-types.ts        # PanelSnapshot view-model contract (phase keys, tones, chrome)
src/panel-view.ts         # projects SessionState[] into the localized PanelSnapshot
src/panel-locale.ts       # panel chrome locale + chrome builder
src/dashboard.ts          # panel HTML shell composing styles + script + controls
src/dashboard-styles.ts   # panel CSS (dark GitHub-ish; tone → color)
src/dashboard-script.ts   # client renderer: escapes and paints the snapshot, SSE reconnect
src/dashboard-controls.ts # client search box + phase/watch filter chips

# OpenChamber extension
src/extension/binding.ts  # typed SDK loopback client: live stream, 5s poll fallback, session calls
src/extension/schemas.ts  # parses PanelSnapshot/session-control payloads, flags stale/old-plugin data
src/extension/badge.ts    # background-frame badge writer (failed-watch count)
src/extension/panel/      # rail panel view (mirrors dashboard-script.ts, as SDK-safe templates)
src/extension/status/     # Work Status section view + authoritative watch toggle
panel/, status/, background/  # built entries (index.html + main.js) consumed by the OpenChamber manifest
```

Runtime dependencies: `@opencode/plugin` and `zod`. Strictly typed, tested with `bun test`.

## License

[MIT](LICENSE)
