import type { PanelPhaseKey, PanelSession, PanelSnapshot } from "../../panel-types.ts"

export type EnabledFilter = "all" | "on" | "off"
export type FilterState = {
  readonly query: string
  readonly phases: ReadonlySet<PanelPhaseKey>
  readonly enabled: EnabledFilter
}

export type FilteredPanel = { readonly sessions: readonly PanelSession[]; readonly hidden: number }

export function filterActive(state: FilterState): boolean {
  return state.query !== "" || state.phases.size > 0 || state.enabled !== "all"
}

export function nextEnabled(enabled: EnabledFilter): EnabledFilter {
  switch (enabled) {
    case "all":
      return "on"
    case "on":
      return "off"
    case "off":
      return "all"
    default:
      return assertNever(enabled)
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled enabled filter ${value}`)
}

/** Exactly the built-in dashboard's watch-row AND semantics, including watchless sessions. */
export function filterSnapshot(snapshot: PanelSnapshot, state: FilterState): FilteredPanel {
  const sessions: PanelSession[] = []
  let baseline = 0
  let visible = 0
  for (const session of snapshot.sessions) {
    baseline += session.watches.length > 0 ? session.watches.length : 1
    if (state.enabled !== "all" && state.enabled !== (session.enabled ? "on" : "off")) continue
    if (session.watches.length === 0) {
      if (state.phases.size === 0 && session.searchText.includes(state.query)) {
        sessions.push(session)
        visible += 1
      }
      continue
    }
    const watches = session.watches.filter(
      (watch) =>
        (state.phases.size === 0 || state.phases.has(watch.phaseKey)) &&
        watch.searchText.includes(state.query),
    )
    if (watches.length > 0) {
      sessions.push({ ...session, watches })
      visible += watches.length
    }
  }
  return { sessions, hidden: baseline - visible }
}
