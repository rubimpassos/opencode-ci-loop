import type { WatchRegistry } from "./registry.ts"
import { assertNever, type SessionId } from "./types.ts"

export type WatchAction = "enable" | "disable" | "status"
export type WatchToolContext = {
  readonly registry: WatchRegistry
  readonly directory: string
  readonly dashboardUrl: string
}

/** Host-independent action execution; all state effects go through the supplied registry. */
export function executeWatchAction(ctx: WatchToolContext, sessionID: SessionId, action: WatchAction): string {
  switch (action) {
    case "enable":
      ctx.registry.setEnabled(sessionID, true, ctx.directory)
      return (
        "CI loop ENABLED for this session. After a push, the CI result is injected here " +
        `automatically — don't poll manually (sleep/gh pr checks). Dashboard: ${ctx.dashboardUrl}`
      )
    case "disable":
      ctx.registry.setEnabled(sessionID, false, ctx.directory)
      return "CI loop DISABLED for this session (active watch cancelled)."
    case "status": {
      const enabled = ctx.registry.isEnabled(sessionID, ctx.directory)
      const watch = ctx.registry.sessionView(sessionID).watch
      const phase = watch
        ? `; current watch: ${watch.phase.kind} (${watch.branch}@${watch.sha.slice(0, 8)})`
        : ""
      return `CI loop ${enabled ? "enabled" : "disabled"}${phase}. Dashboard: ${ctx.dashboardUrl}`
    }
    default:
      return assertNever(action)
  }
}
