import { type Plugin, tool } from "@opencode-ai/plugin"
import { bunExec, GhClient } from "./gh.ts"
import type { Locale } from "./i18n.ts"
import { clearSessionNotifications, type NotifyContext, notifyPhase, notifyReviewUpdate } from "./notify.ts"
import { buildPanelSnapshot } from "./panel-view.ts"
import { WatchRegistry } from "./registry.ts"
import { renderWatchNotice } from "./render.ts"
import { resolvePushTargets } from "./resolve.ts"
import { DashboardServer } from "./server.ts"
import type { OpencodeClient } from "./session-context.ts"
import { assertNever, type PluginConfig, PluginConfigSchema, type SessionId } from "./types.ts"

const BashArgsSchema = tool.schema.object({ command: tool.schema.string() }).loose()

const PUSH_PATTERN = /\bgit\b[^\n;|&]*\bpush\b/
const PUSH_FAILURE_MARKERS = ["! [rejected]", "fatal:", "error: failed to push"] as const

export function isGitPush(command: string): boolean {
  return PUSH_PATTERN.test(command) && !command.includes("--dry-run")
}

function pushSucceeded(output: string): boolean {
  return !PUSH_FAILURE_MARKERS.some((marker) => output.includes(marker))
}

type SharedCiLoop = {
  readonly registry: WatchRegistry
  readonly dashboard: DashboardServer
  refs: number
  client: OpencodeClient
  readonly notifications: Set<string>
  readonly locales: Map<SessionId, Locale>
  /** Panel-only label cache. Deliberately NOT on `SessionState` — `/state` stays byte-identical. */
  readonly titles: Map<SessionId, string>
  /** Pushes the current registry state to the dashboard; the panel mapper runs inside `broadcast`. */
  readonly publish: () => void
}

const SHARED_KEY = Symbol.for("opencode-ci-loop.shared")

function sharedMap(): Map<number, SharedCiLoop> {
  const holder = globalThis as { [SHARED_KEY]?: Map<number, SharedCiLoop> }
  holder[SHARED_KEY] ??= new Map()
  return holder[SHARED_KEY]
}

/**
 * opencode instantiates the plugin once per project/worktree within the same process.
 * Without sharing, each instance would create its own registry + dashboard and only the first
 * would get the port — the visible dashboard would be blind to the other instances' sessions.
 * State is a per-process singleton, keyed by the dashboard port.
 */
export function acquireShared(config: PluginConfig, client: OpencodeClient): SharedCiLoop {
  const map = sharedMap()
  const existing = map.get(config.dashboard.port)
  if (existing) {
    existing.refs += 1
    existing.client = client
    return existing
  }

  const dashboard = new DashboardServer(config.dashboard)
  const notifications = new Set<string>()
  const locales = new Map<SessionId, Locale>()
  const titles = new Map<SessionId, string>()
  // Rebuilt per event so notifications always use the most recent client instance.
  const ctx = (): NotifyContext => ({ client: shared.client, notifications, locales, config })

  const registry = new WatchRegistry(config, {
    onChange: (sessions) => dashboard.broadcast(sessions),
    onPhase: (sessionID, watch, signal) => notifyPhase(ctx(), sessionID, watch, signal),
    onReviewUpdate: (sessionID, watch, update, signal) =>
      notifyReviewUpdate(ctx(), sessionID, watch, update, signal),
  })

  const publish = (): void => dashboard.broadcast(registry.snapshot())
  const shared: SharedCiLoop = {
    registry,
    dashboard,
    refs: 1,
    client,
    notifications,
    locales,
    titles,
    publish,
  }
  dashboard.setControl({
    getSession: (id) => registry.sessionView(id as SessionId),
    setEnabled: (id, enabled) => {
      registry.setEnabled(id as SessionId, enabled)
      return registry.sessionView(id as SessionId)
    },
  })
  dashboard.setPanelMapper((sessions) =>
    buildPanelSnapshot(sessions, { language: config.language, locales, titles }),
  )
  dashboard.start()
  map.set(config.dashboard.port, shared)
  return shared
}

/**
 * Best-effort: a title only improves the panel label, so a failed lookup must never break a
 * watch — the panel falls back to the session id. opencode rewrites titles as the conversation
 * evolves, so `session.updated` (not this fetch) is what keeps the cache fresh.
 */
async function ensureTitle(shared: SharedCiLoop, sessionID: SessionId): Promise<void> {
  if (shared.titles.has(sessionID)) return
  try {
    const response = await shared.client.session.get({ path: { id: sessionID } })
    const title = response.data?.title
    if (title) {
      shared.titles.set(sessionID, title)
      shared.publish()
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error
  }
}

export function releaseShared(port: number): void {
  const map = sharedMap()
  const shared = map.get(port)
  if (!shared) return
  shared.refs -= 1
  if (shared.refs > 0) return
  shared.registry.dispose()
  shared.dashboard.stop()
  map.delete(port)
}

export const CiLoopPlugin: Plugin = async ({ client, directory }, options) => {
  const config = PluginConfigSchema.parse(options ?? {})
  const shared = acquireShared(config, client)
  const { registry, dashboard } = shared

  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return
      const args = BashArgsSchema.safeParse(input.args)
      if (!args.success || !isGitPush(args.data.command)) return
      if (!pushSucceeded(output.output)) return

      const sessionID = input.sessionID as SessionId
      if (!registry.isEnabled(sessionID, directory)) return
      void ensureTitle(shared, sessionID)

      const targets = await resolvePushTargets(output.output, args.data.command, input.args, {
        exec: bunExec,
        sessionDir: directory,
      })
      if (targets.length === 0) return
      for (const target of targets) {
        const gh = new GhClient(bunExec, target.directory ?? directory, target.repoUrl)
        void registry.startWatch(sessionID, target, gh, directory)
      }
      output.output += renderWatchNotice(targets)
    },

    event: async ({ event }) => {
      if (event.type === "session.updated") {
        // Fires on nearly every turn; re-broadcasting unchanged titles would be pure waste.
        const { id, title } = event.properties.info
        const sessionID = id as SessionId
        if (shared.titles.get(sessionID) !== title) {
          shared.titles.set(sessionID, title)
          shared.publish()
        }
        return
      }
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id as SessionId
        registry.remove(sessionID)
        shared.titles.delete(sessionID)
        clearSessionNotifications(shared.notifications, sessionID, shared.locales)
      }
    },

    tool: {
      ci_watch: tool({
        description:
          "Controls the CI validation loop for this session. After a `git push`, the loop watches GitHub " +
          "Actions and injects the result (including failure logs) into the session automatically — you NEVER " +
          "need to wait for or manually poll CI (no `sleep`, `gh pr checks`, `gh run watch`). " +
          "Use action=enable/disable to toggle it for this session, action=status to check.",
        args: {
          action: tool.schema.enum(["enable", "disable", "status"]),
        },
        async execute(args, context) {
          const sessionID = context.sessionID as SessionId
          switch (args.action) {
            case "enable":
              registry.setEnabled(sessionID, true, directory)
              return (
                "CI loop ENABLED for this session. After a push, the CI result is injected here " +
                `automatically — don't poll manually (sleep/gh pr checks). Dashboard: ${dashboard.url}`
              )
            case "disable":
              registry.setEnabled(sessionID, false, directory)
              return "CI loop DISABLED for this session (active watch cancelled)."
            case "status": {
              const enabled = registry.isEnabled(sessionID, directory)
              const watch = registry.sessionView(sessionID).watch
              const phase = watch
                ? `; current watch: ${watch.phase.kind} (${watch.branch}@${watch.sha.slice(0, 8)})`
                : ""
              return `CI loop ${enabled ? "enabled" : "disabled"}${phase}. Dashboard: ${dashboard.url}`
            }
            default:
              return assertNever(args.action)
          }
        },
      }),
    },

    dispose: async () => {
      releaseShared(config.dashboard.port)
    },
  }
}
