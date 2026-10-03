import type { PanelSnapshot } from "../panel-types.ts"
import type { PanelBinding } from "./binding.ts"
import type { BindingState } from "./connection-view.ts"

/** Failed stored watches across every session (paused ones included); a watch counts once. */
export function failedWatchCount(snapshot: PanelSnapshot): number {
  let count = 0
  for (const session of snapshot.sessions) {
    for (const watch of session.watches) if (watch.failed) count += 1
  }
  return count
}

/** The rail badge for a binding state: only fresh data shows a count; zero and anything else clear it. */
export function badgeCount(state: BindingState): number | null {
  switch (state.connection.kind) {
    case "live":
    case "polling": {
      if (state.stale || state.snapshot === null) return null
      const count = failedWatchCount(state.snapshot)
      return count === 0 ? null : count
    }
    case "connecting":
    case "unavailable":
    case "forbidden":
    case "invalid-data":
      return null
    default:
      return assertNever(state.connection)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled variant ${JSON.stringify(value)}`)
}

export type BadgeWriter = (count: number | null) => Promise<void>

/**
 * Mirrors the binding into the badge, writing only on change. A rejected write is forgotten so the
 * next state retries it. The returned stop function unsubscribes and clears the badge.
 */
export function bindBadge(binding: Pick<PanelBinding, "subscribe">, write: BadgeWriter): () => void {
  let written: number | null | undefined
  const sync = (count: number | null): void => {
    if (count === written) return
    written = count
    void write(count).catch(() => {
      if (written === count) written = undefined
    })
  }
  const unsubscribe = binding.subscribe((state) => sync(badgeCount(state)))
  return () => {
    unsubscribe()
    sync(null)
  }
}
