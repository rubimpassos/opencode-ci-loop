import type { PanelBinding } from "./binding.ts"
import { describeConnection } from "./connection-view.ts"

/** Interim one-line state readout; the panel/status/badge tasks replace it with real views. */
export function renderStateLine(binding: PanelBinding, root: HTMLElement): () => void {
  const line = document.createElement("p")
  root.replaceChildren(line)
  return binding.subscribe((state) => {
    const watches = state.snapshot?.sessions.reduce((sum, session) => sum + session.watches.length, 0) ?? 0
    line.textContent = `${describeConnection(state).text} · ${watches}`
  })
}
