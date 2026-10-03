import type { HostClient } from "@openchamber/sdk"
import { mountBanner, mountButton, mountEmpty, mountTextField } from "@openchamber/sdk/ui"
import {
  PANEL_PHASE_KEYS,
  type PanelChrome,
  type PanelPhaseKey,
  type PanelSnapshot,
} from "../../panel-types.ts"
import type { PanelBinding } from "../binding.ts"
import { type BindingState, describeConnection } from "../connection-view.ts"
import { node, syncChildren } from "./dom-list.ts"
import { type EnabledFilter, filterActive, filterSnapshot, nextEnabled } from "./filters.ts"
import { PANEL_STYLES } from "./panel-styles.ts"
import { type SessionEnvironment, SessionView } from "./session-view.ts"

type PhaseChip = { readonly key: PanelPhaseKey; readonly element: HTMLButtonElement }

export function renderPanel(
  binding: PanelBinding,
  host: Pick<HostClient, "openUrl">,
  root: HTMLElement,
): () => void {
  const style = document.createElement("style")
  style.textContent = PANEL_STYLES
  document.head.append(style)

  const shell = node("div", "ci-shell")
  const heading = node("h1", "ci-heading")
  const connectionRoot = node("div", "ci-connection")
  const controls = node("div", "ci-controls")
  const filtersTitle = node("h2", "ci-filters-title")
  const searchRoot = node("div", "ci-search")
  const chipList = node("div", "ci-chips")
  const hiddenCount = node("p", "ci-hidden")
  const body = node("main", "ci-body")
  const sessionsRoot = node("div", "ci-sessions")
  const emptyRoot = node("div", "ci-empty")
  const clearRoot = node("span", "ci-clear")
  controls.append(filtersTitle, searchRoot, chipList, hiddenCount)
  body.append(sessionsRoot, emptyRoot)
  shell.append(heading, connectionRoot, controls, body)
  root.replaceChildren(shell)

  const initial = describeConnection(binding.state())
  const connection = mountBanner(connectionRoot, { title: initial.text, tone: initial.tone })
  const empty = mountEmpty(emptyRoot, { title: "" })
  const sessions = new Map<string, SessionView>()
  const phases = new Set<PanelPhaseKey>()
  const phaseChips: PhaseChip[] = []
  let enabled: EnabledFilter = "all"
  let query = ""
  let debounce: ReturnType<typeof setTimeout> | null = null
  let search: ReturnType<typeof mountTextField> | null = null
  let clear: ReturnType<typeof mountButton> | null = null
  let enabledChip: HTMLButtonElement | null = null
  let activeChrome: PanelChrome | null = null
  let lastState: BindingState = binding.state()
  let lastSnapshot: PanelSnapshot | null = null
  let environment: SessionEnvironment = { binding, host, locale: lastState.locale }

  const updateFilters = (chrome: PanelChrome): void => {
    for (const { key, element } of phaseChips) {
      element.textContent = chrome.phaseChips[key]
      element.setAttribute("aria-pressed", String(phases.has(key)))
      element.dataset["active"] = String(phases.has(key))
    }
    if (enabledChip) {
      const labels = {
        all: chrome.filterEnabledAll,
        on: chrome.filterEnabledOn,
        off: chrome.filterEnabledOff,
      }
      enabledChip.textContent = labels[enabled]
      enabledChip.setAttribute("aria-pressed", String(enabled !== "all"))
      enabledChip.dataset["active"] = String(enabled !== "all")
    }
    clear?.update({ label: chrome.clearFilters, disabled: !filterActive({ query, phases, enabled }) })
  }

  const renderSnapshot = (snapshot: PanelSnapshot): void => {
    const chrome = snapshot.chrome
    document.title = chrome.pageTitle
    heading.textContent = chrome.pageTitle
    if (activeChrome === null) {
      filtersTitle.textContent = chrome.filtersLabel
      search = mountTextField(searchRoot, {
        label: chrome.searchPlaceholder,
        placeholder: chrome.searchPlaceholder,
        value: "",
        onChange: (value) => {
          if (debounce !== null) clearTimeout(debounce)
          debounce = setTimeout(() => {
            query = value.toLowerCase()
            debounce = null
            render()
          }, 150)
        },
      })
      for (const key of PANEL_PHASE_KEYS) {
        const chip = node("button", "ci-chip")
        chip.type = "button"
        chip.addEventListener("click", () => {
          if (phases.has(key)) phases.delete(key)
          else phases.add(key)
          render()
        })
        phaseChips.push({ key, element: chip })
        chipList.append(chip)
      }
      enabledChip = node("button", "ci-chip ci-chip-enabled")
      enabledChip.type = "button"
      enabledChip.addEventListener("click", () => {
        enabled = nextEnabled(enabled)
        render()
      })
      chipList.append(enabledChip)
      clear = mountButton(clearRoot, {
        label: chrome.clearFilters,
        variant: "ghost",
        size: "xs",
        onClick: () => {
          if (debounce !== null) clearTimeout(debounce)
          debounce = null
          query = ""
          phases.clear()
          enabled = "all"
          search?.update({ value: "" })
          render()
        },
      })
      chipList.append(clearRoot)
    } else if (
      activeChrome.filtersLabel !== chrome.filtersLabel ||
      activeChrome.searchPlaceholder !== chrome.searchPlaceholder
    ) {
      filtersTitle.textContent = chrome.filtersLabel
      search?.update({ label: chrome.searchPlaceholder, placeholder: chrome.searchPlaceholder })
    }
    activeChrome = chrome
    updateFilters(chrome)

    const filtered = filterSnapshot(snapshot, { query, phases, enabled })
    hiddenCount.textContent = filterActive({ query, phases, enabled })
      ? chrome.hiddenTemplate.replace("{n}", String(filtered.hidden))
      : ""
    hiddenCount.hidden = hiddenCount.textContent === ""
    const freshFrame = lastSnapshot !== snapshot
    lastSnapshot = snapshot
    const present = new Set(snapshot.sessions.map((session) => session.sessionID))
    for (const [id, view] of sessions) {
      if (!present.has(id)) {
        view.dispose()
        sessions.delete(id)
      }
    }
    for (const session of snapshot.sessions) {
      const view = sessions.get(session.sessionID)
      if (!view) continue
      view.pruneWatches(session)
      if (freshFrame) view.syncEnabled(session.enabled)
    }
    const writable =
      !lastState.stale && (lastState.connection.kind === "live" || lastState.connection.kind === "polling")
    const ordered: HTMLElement[] = []
    for (const session of filtered.sessions) {
      let view = sessions.get(session.sessionID)
      if (!view) {
        view = new SessionView(session.sessionID, environment)
        sessions.set(session.sessionID, view)
        view.syncEnabled(session.enabled)
      }
      view.update(session, chrome, writable)
      ordered.push(view.element)
    }
    syncChildren(sessionsRoot, ordered)
    const fresh = !lastState.stale && writable
    const message = snapshot.sessions.length === 0 ? chrome.emptyWaiting : chrome.noMatches
    emptyRoot.hidden = !fresh || filtered.sessions.length > 0
    if (!emptyRoot.hidden) empty.update({ title: message })
  }

  const render = (): void => {
    const state = lastState
    const view = describeConnection(state)
    connection.update({ title: view.text, tone: view.tone })
    connectionRoot.dataset["state"] = state.connection.kind
    if (state.locale !== environment.locale) {
      for (const session of sessions.values()) session.dispose()
      sessions.clear()
      environment = { binding, host, locale: state.locale }
    }
    const snapshot = state.snapshot
    if (snapshot) renderSnapshot(snapshot)
    else {
      controls.hidden = true
      emptyRoot.hidden = true
    }
    if (snapshot) controls.hidden = false
  }
  const unsubscribe = binding.subscribe((state) => {
    lastState = state
    render()
  })
  return () => {
    unsubscribe()
    if (debounce !== null) clearTimeout(debounce)
    for (const session of sessions.values()) session.dispose()
    search?.dispose()
    clear?.dispose()
    empty.dispose()
    connection.dispose()
    style.remove()
  }
}
