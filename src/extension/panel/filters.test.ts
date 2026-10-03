import { describe, expect, it } from "bun:test"
import type { PanelPhaseKey, PanelSnapshot } from "../../panel-types.ts"
import { snapshot } from "../fake-host.test-support.ts"
import { filterActive, filterSnapshot, nextEnabled } from "./filters.ts"

const base = snapshot("en", "Checkout")
const original = base.sessions[0]
const watch = original?.watches[0]
if (!original || !watch) throw new Error("fixture is missing a session watch")

const rich: PanelSnapshot = {
  chrome: base.chrome,
  sessions: [
    {
      ...original,
      searchText: "checkout ses_1",
      watches: [
        { ...watch, key: "failure", searchText: "checkout failed #318", phaseKey: "done-failed" },
        { ...watch, key: "review", searchText: "checkout review #318", phaseKey: "reviewing" },
      ],
    },
    {
      ...original,
      sessionID: "ses_off",
      title: "Pause review",
      enabled: false,
      searchText: "pause review",
      watches: [{ ...watch, key: "off-review", searchText: "pause review #318", phaseKey: "reviewing" }],
    },
    {
      ...original,
      sessionID: "ses_bare",
      title: null,
      enabled: false,
      searchText: "ses_bare empty",
      watches: [],
    },
  ],
}

describe("rail filters", () => {
  it("keeps only the matching watch when search, phase and enabled filters combine", () => {
    // Given: multiple rows share a search term but differ in phase or enabled state.
    const phases = new Set<PanelPhaseKey>(["reviewing"])

    // When: all three criteria are applied at watch-row granularity.
    const result = filterSnapshot(rich, { query: "#318", phases, enabled: "on" })

    // Then: the matching watch remains and all three other baseline rows are hidden.
    expect(
      result.sessions.map((session) => [session.sessionID, session.watches.map((item) => item.key)]),
    ).toEqual([["ses_1", ["review"]]])
    expect(result.hidden).toBe(3)
  })

  it("keeps a watchless session only without a phase filter and counts it as one row", () => {
    // Given: one paused session has no watches.
    const phases = new Set<PanelPhaseKey>()

    // When: searching for its session-level searchText, then selecting a phase.
    const matching = filterSnapshot(rich, { query: "ses_bare", phases, enabled: "off" })
    phases.add("running")
    const phased = filterSnapshot(rich, { query: "ses_bare", phases, enabled: "off" })

    // Then: search alone finds it; a phase requires a watch and hides all four baseline rows.
    expect(matching.sessions.map((session) => session.sessionID)).toEqual(["ses_bare"])
    expect(matching.hidden).toBe(3)
    expect(phased.sessions).toEqual([])
    expect(phased.hidden).toBe(4)
  })

  it("cycles enabled all, on, off and activates only non-default filters", () => {
    // Given: the default filter is inactive.
    const phases = new Set<PanelPhaseKey>()
    expect(filterActive({ query: "", phases, enabled: "all" })).toBe(false)

    // When: the enabled chip is advanced through its states.
    const on = nextEnabled("all")
    const off = nextEnabled(on)
    const all = nextEnabled(off)

    // Then: it cycles deterministically and each non-default state counts as a filter.
    expect([on, off, all]).toEqual(["on", "off", "all"])
    expect(filterActive({ query: "", phases, enabled: off })).toBe(true)
  })
})
