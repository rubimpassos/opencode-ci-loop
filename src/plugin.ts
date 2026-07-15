import { type Plugin, tool } from "@opencode-ai/plugin"
import { bunExec, GhClient } from "./gh.ts"
import { WatchRegistry } from "./registry.ts"
import { isReportClean, renderPromptReport, summarizeRuns } from "./render.ts"
import { DashboardServer } from "./server.ts"
import { assertNever, PluginConfigSchema, type SessionId, type Watch } from "./types.ts"

const BashArgsSchema = tool.schema.object({ command: tool.schema.string() }).loose()

const PUSH_PATTERN = /\bgit\b[^\n;|&]*\bpush\b/
const PUSH_FAILURE_MARKERS = ["! [rejected]", "fatal:", "error: failed to push"] as const

export function isGitPush(command: string): boolean {
  return PUSH_PATTERN.test(command) && !command.includes("--dry-run")
}

function pushSucceeded(output: string): boolean {
  return !PUSH_FAILURE_MARKERS.some((marker) => output.includes(marker))
}

export const CiLoopPlugin: Plugin = async ({ client, directory }, options) => {
  const config = PluginConfigSchema.parse(options ?? {})
  const gh = new GhClient(bunExec, directory)
  const dashboard = new DashboardServer(config.dashboard)
  const lastToastedPhase = new Map<SessionId, string>()

  const registry = new WatchRegistry(gh, config, {
    onChange: (sessions) => dashboard.broadcast(sessions),
    onPhase: async (sessionID, watch) => {
      await notifyPhase(sessionID, watch)
    },
  })

  async function notifyPhase(sessionID: SessionId, watch: Watch): Promise<void> {
    const phase = watch.phase
    const fingerprint = phase.kind === "running" ? `running:${summarizeRuns(phase.runs)}` : phase.kind
    if (lastToastedPhase.get(sessionID) === fingerprint) return
    lastToastedPhase.set(sessionID, fingerprint)

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
        await client.session.prompt({
          path: { id: sessionID },
          body: { parts: [{ type: "text", text: renderPromptReport(phase.report) }] },
        })
        return
      }
      default:
        return assertNever(phase)
    }
  }

  async function toast(message: string, variant: "info" | "success" | "warning" | "error"): Promise<void> {
    await client.tui.showToast({ body: { title: "CI Loop", message, variant } })
  }

  try {
    dashboard.start()
  } catch (error) {
    if (!(error instanceof Error)) throw error
    console.warn(`[ci-loop] dashboard desabilitado (${error.message})`)
  }

  return {
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "bash") return
      const args = BashArgsSchema.safeParse(input.args)
      if (!args.success || !isGitPush(args.data.command)) return
      if (!pushSucceeded(output.output)) return

      const sessionID = input.sessionID as SessionId
      if (!registry.isEnabled(sessionID)) return

      const [sha, branch] = await Promise.all([gh.headSha(), gh.currentBranch()])
      void registry.startWatch(sessionID, sha, branch)
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
              registry.setEnabled(sessionID, true)
              return `CI loop HABILITADO nesta sessão. Dashboard: ${dashboard.url}`
            case "disable":
              registry.setEnabled(sessionID, false)
              return "CI loop DESABILITADO nesta sessão (watch ativo cancelado)."
            case "status": {
              const enabled = registry.isEnabled(sessionID)
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
      registry.dispose()
      dashboard.stop()
    },
  }
}
