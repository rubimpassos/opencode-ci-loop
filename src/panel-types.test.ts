import { describe, expect, it } from "bun:test"
import { PANEL_PHASE_KEYS, PANEL_TONES, type PanelPhaseKey, type PanelTone } from "./panel-types.ts"

describe("panel view-model contract", () => {
  it("PANEL_PHASE_KEYS lists every filterable phase in chip order", () => {
    expect(PANEL_PHASE_KEYS).toEqual([
      "waiting",
      "running",
      "done-green",
      "done-failed",
      "reviewing",
      "review-ended",
      "timed-out",
      "error",
    ])
  })

  it("PANEL_TONES covers every tone a phase key can map to", () => {
    // The locked phase→tone assignment, kept here as test data: the mapper itself lives in panel-view.ts.
    // The Record type makes the table exhaustive over PanelPhaseKey at compile time.
    const assignment: Readonly<Record<PanelPhaseKey, PanelTone>> = {
      waiting: "info",
      running: "info",
      reviewing: "info",
      "done-green": "ok",
      "review-ended": "ok",
      "done-failed": "fail",
      error: "fail",
      "timed-out": "warn",
    }
    const used = [...new Set(Object.values(assignment))].sort()
    expect(used).toEqual([...PANEL_TONES].sort())
  })
})
