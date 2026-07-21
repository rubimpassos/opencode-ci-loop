import { type Plugin, tool } from "@opencode-ai/plugin"
import { bunExec, GhClient } from "./gh.ts"
import { WatchRegistry, watchKey } from "./registry.ts"
import {
  isReportClean,
  prReadiness,
  renderPromptReport,
  renderWatchNotice,
  sourceLabel,
  summarizeRuns,
} from "./render.ts"
import { resolvePushTargets } from "./resolve.ts"
import { DashboardServer } from "./server.ts"
import { assertNever, type PluginConfig, PluginConfigSchema, type SessionId, type Watch } from "./types.ts"

type OpencodeClient = Parameters<Plugin>[0]["client"]

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

  const registry = new WatchRegistry(config, {
    onChange: (sessions) => dashboard.broadcast(sessions),
    onPhase: async (sessionID, watch, signal) => {
      await notifyPhase(shared.client, shared.notifications, sessionID, watch, signal)
    },
  })

  const shared: SharedCiLoop = { registry, dashboard, refs: 1, client, notifications }
  dashboard.setControl({
    getSession: (id) => registry.sessionView(id as SessionId),
    setEnabled: (id, enabled) => {
      registry.setEnabled(id as SessionId, enabled)
      return registry.sessionView(id as SessionId)
    },
  })
  dashboard.start()
  map.set(config.dashboard.port, shared)
  return shared
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

/**
 * Model last used in the session, so the injected report replies on it — not the agent default.
 * The user may have switched models mid-session; without this the prompt reverts to the default.
 */
export async function resolveSessionModel(
  client: OpencodeClient,
  sessionID: SessionId,
): Promise<{ providerID: string; modelID: string } | undefined> {
  try {
    const response = await client.session.messages({ path: { id: sessionID } })
    const messages = response.data ?? []
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]?.info
      if (info?.role === "assistant") return { providerID: info.providerID, modelID: info.modelID }
    }
  } catch (error) {
    if (!(error instanceof Error)) throw error
  }
  return undefined
}

export async function notifyPhase(
  client: OpencodeClient,
  notifications: Set<string>,
  sessionID: SessionId,
  watch: Watch,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) return
  const phase = watch.phase
  const phaseFingerprint = phase.kind === "running" ? `running:${summarizeRuns(phase.runs)}` : phase.kind
  const fingerprint = `${sessionID}\0${watchKey(watch.repo, watch.branch)}\0${watch.sha}\0${phaseFingerprint}`
  if (notifications.has(fingerprint)) return
  notifications.add(fingerprint)
  const context = `${watch.repo} · ${watch.branch} — ${sourceLabel(watch.sourceKind, watch.directory)}`

  const toast = async (message: string, variant: "info" | "success" | "warning" | "error") => {
    if (signal?.aborted) return
    await client.tui.showToast({ body: { title: "CI Loop", message, variant } })
  }

  switch (phase.kind) {
    case "waiting":
      await toast(`Waiting for CI to start… · ${context}`, "info")
      return
    case "running":
      await toast(`CI: ${summarizeRuns(phase.runs)} · ${context}`, "info")
      return
    case "timed-out":
      await toast(`Timed out waiting for CI · ${context}`, "warning")
      return
    case "error":
      await toast(`CI watch failed: ${phase.message} · ${context}`, "error")
      return
    case "done": {
      const clean = isReportClean(phase.report)
      let message = clean ? `CI green (${phase.report.runs.length} checks)` : "CI failed — injecting report"
      if (phase.report.pr) {
        const readiness = prReadiness(phase.report.pr, clean)
        const prStatus = readiness.ready
          ? "ready to merge"
          : `blocked: ${readiness.blockers.length} issue${readiness.blockers.length === 1 ? "" : "s"}`
        message += ` · PR #${phase.report.pr.number} ${prStatus}`
      }
      await toast(`${message} · ${context}`, clean ? "success" : "error")
      if (signal?.aborted) return
      const model = await resolveSessionModel(client, sessionID)
      if (signal?.aborted) return
      await client.session.prompt({
        path: { id: sessionID },
        body: { ...(model && { model }), parts: [{ type: "text", text: renderPromptReport(phase.report) }] },
      })
      return
    }
    default:
      return assertNever(phase)
  }
}

export function clearSessionNotifications(notifications: Set<string>, sessionID: SessionId): void {
  const prefix = `${sessionID}\0`
  for (const fingerprint of notifications) {
    if (fingerprint.startsWith(prefix)) notifications.delete(fingerprint)
  }
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
      if (event.type === "session.deleted") {
        const sessionID = event.properties.info.id as SessionId
        registry.remove(sessionID)
        clearSessionNotifications(shared.notifications, sessionID)
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
