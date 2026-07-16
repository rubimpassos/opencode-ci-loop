import { type Plugin, tool } from "@opencode-ai/plugin"
import { bunExec, GhClient } from "./gh.ts"
import { WatchRegistry } from "./registry.ts"
import { isReportClean, renderPromptReport, summarizeRuns } from "./render.ts"
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
}

const SHARED_KEY = Symbol.for("opencode-ci-loop.shared")

function sharedMap(): Map<number, SharedCiLoop> {
  const holder = globalThis as { [SHARED_KEY]?: Map<number, SharedCiLoop> }
  holder[SHARED_KEY] ??= new Map()
  return holder[SHARED_KEY]
}

/**
 * O opencode instancia o plugin uma vez por projeto/worktree dentro do mesmo processo.
 * Sem compartilhamento, cada instância criaria seu próprio registry + dashboard e só a
 * primeira conseguiria a porta — o dashboard visível ficaria cego às sessões das demais.
 * Estado é um singleton por processo, keyed pela porta do dashboard.
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
  const lastToastedPhase = new Map<SessionId, string>()

  const registry = new WatchRegistry(config, {
    onChange: (sessions) => dashboard.broadcast(sessions),
    onPhase: async (sessionID, watch) => {
      await notifyPhase(shared, lastToastedPhase, sessionID, watch)
    },
  })

  const shared: SharedCiLoop = { registry, dashboard, refs: 1, client }
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

async function notifyPhase(
  shared: SharedCiLoop,
  lastToastedPhase: Map<SessionId, string>,
  sessionID: SessionId,
  watch: Watch,
): Promise<void> {
  const phase = watch.phase
  const fingerprint = phase.kind === "running" ? `running:${summarizeRuns(phase.runs)}` : phase.kind
  if (lastToastedPhase.get(sessionID) === fingerprint) return
  lastToastedPhase.set(sessionID, fingerprint)

  const toast = async (message: string, variant: "info" | "success" | "warning" | "error") => {
    await shared.client.tui.showToast({ body: { title: "CI Loop", message, variant } })
  }

  switch (phase.kind) {
    case "waiting":
      await toast("Aguardando o CI iniciar…", "info")
      return
    case "running":
      await toast(`CI: ${summarizeRuns(phase.runs)}`, "info")
      return
    case "timed-out":
      await toast("Timeout esperando o CI", "warning")
      return
    case "error":
      await toast(`CI watch falhou: ${phase.message}`, "error")
      return
    case "done": {
      const clean = isReportClean(phase.report)
      await toast(
        clean ? `CI verde (${phase.report.runs.length} checks)` : `CI com falhas — injetando relatório`,
        clean ? "success" : "error",
      )
      await shared.client.session.prompt({
        path: { id: sessionID },
        body: { parts: [{ type: "text", text: renderPromptReport(phase.report) }] },
      })
      return
    }
    default:
      return assertNever(phase)
  }
}

export const CiLoopPlugin: Plugin = async ({ client, directory }, options) => {
  const config = PluginConfigSchema.parse(options ?? {})
  const gh = new GhClient(bunExec, directory)
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

      const [sha, branch] = await Promise.all([gh.headSha(), gh.currentBranch()])
      void registry.startWatch(sessionID, sha, branch, gh, directory)
    },

    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        registry.remove(event.properties.info.id as SessionId)
      }
    },

    tool: {
      ci_watch: tool({
        description:
          "Controla o CI validation loop desta sessão. Após um `git push`, o loop vigia o GitHub Actions " +
          "e injeta o resultado (incluindo logs de falha) na sessão. " +
          "Use action=enable/disable para ligar/desligar nesta sessão, action=status para consultar.",
        args: {
          action: tool.schema.enum(["enable", "disable", "status"]),
        },
        async execute(args, context) {
          const sessionID = context.sessionID as SessionId
          switch (args.action) {
            case "enable":
              registry.setEnabled(sessionID, true, directory)
              return `CI loop HABILITADO nesta sessão. Dashboard: ${dashboard.url}`
            case "disable":
              registry.setEnabled(sessionID, false, directory)
              return "CI loop DESABILITADO nesta sessão (watch ativo cancelado)."
            case "status": {
              const enabled = registry.isEnabled(sessionID, directory)
              const watch = registry.snapshot().find((s) => s.sessionID === sessionID)?.watch
              const phase = watch
                ? `; watch atual: ${watch.phase.kind} (${watch.branch}@${watch.sha.slice(0, 8)})`
                : ""
              return `CI loop ${enabled ? "habilitado" : "desabilitado"}${phase}. Dashboard: ${dashboard.url}`
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
