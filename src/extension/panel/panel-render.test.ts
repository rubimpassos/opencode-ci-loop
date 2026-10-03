import { describe, expect, it } from "bun:test"
import { HostRequestError } from "@openchamber/sdk"
import type { PanelPr, PanelSnapshot } from "../../panel-types.ts"
import { snapshot } from "../fake-host.test-support.ts"
import { panelHarness } from "./panel-harness.test-support.ts"

const source = snapshot("en", "Fix checkout")
const original = source.sessions[0]
const watch = original?.watches[0]
if (!original || !watch) throw new Error("fixture is missing a session watch")

const pr: PanelPr = {
  number: 318,
  title: "Retry payment flow",
  url: "https://github.com/o/r/pull/318",
  ready: false,
  verdictLabel: "Not ready to merge",
  blockers: ["Missing checks", "Open review thread", "Branch blocked"],
  draftLabel: "draft",
}
const rich: PanelSnapshot = {
  chrome: source.chrome,
  sessions: [
    {
      ...original,
      projectLabel: "mercato-web",
      directory: "/work/mercato-web",
      watches: [
        {
          ...watch,
          failed: true,
          phaseKey: "reviewing",
          tone: "info",
          phaseLabel: "Watching reviews",
          checks: [{ name: "security", url: null, state: "failing", failing: true }],
          failures: [{ runName: "ci", logTail: "<script>not markup</script>\nFAIL retry.ts:47" }],
          pr,
        },
      ],
    },
    {
      ...original,
      sessionID: "ses_off",
      title: null,
      enabled: false,
      projectLabel: "ops",
      watches: [],
      searchText: "ses_off ops",
    },
  ],
}

describe("rail DOM updates", () => {
  it("renders every watch evidence group and treats payload markup as text", () => {
    // Given: a rich failed CI watch, external check and blocked PR.
    const app = panelHarness()
    try {
      // When: the binding receives a parsed panel frame.
      app.push(rich)

      // Then: all blockers, run, check, log and project details are visible without parsed HTML.
      expect(app.root.textContent).toContain("mercato-web")
      expect(app.root.textContent).toContain("ci")
      expect(app.root.textContent).toContain("security")
      expect(app.root.textContent).toContain("#318 Retry payment flow")
      for (const blocker of pr.blockers) expect(app.root.textContent).toContain(blocker)
      expect(app.root.textContent).toContain("draft")
      expect(app.root.querySelector("script")).toBeNull()
      expect(app.root.querySelector("pre")?.textContent).toContain("<script>not markup</script>")
      expect(app.root.querySelector(".ci-session-id")?.textContent).toBe("ses_1")
      expect(app.root.querySelector(".ci-project")?.getAttribute("title")).toBeNull()
    } finally {
      app.close()
    }
  })

  it("keeps disclosure, search caret and list scroll when a keyed SSE row updates", () => {
    // Given: a reader has opened the failure log and positioned their search caret and scroll.
    const app = panelHarness()
    try {
      app.push(rich)
      const details = app.root.querySelector<HTMLDetailsElement>("details")
      const input = app.root.querySelector<HTMLInputElement>("input")
      const body = app.root.querySelector<HTMLElement>(".ci-body")
      if (!details || !input || !body) throw new Error("rendered controls missing")
      details.open = true
      input.focus()
      input.value = "retry"
      input.selectionStart = 3
      input.selectionEnd = 3
      body.scrollTop = 120

      // When: the same session/watch/failure keys arrive in the next SSE frame.
      const first = rich.sessions[0]
      const current = first?.watches[0]
      if (!first || !current) throw new Error("fixture missing keyed watch")
      app.push({
        ...rich,
        sessions: [
          {
            ...first,
            watches: [
              {
                ...current,
                meta: "updated context",
                failures: [{ runName: "ci", logTail: "new failing line" }],
              },
            ],
          },
          rich.sessions[1] ?? first,
        ],
      })

      // Then: DOM identity and local user state remain unchanged while content updates in place.
      expect(app.root.querySelector("details")).toBe(details)
      expect(details.open).toBe(true)
      expect(details.querySelector("pre")?.textContent).toBe("new failing line")
      expect(app.root.querySelector("input")).toBe(input)
      expect(Object.is(app.dom.activeElement, input)).toBe(true)
      expect(input.selectionStart).toBe(3)
      expect(body.scrollTop).toBe(120)
    } finally {
      app.close()
    }
  })

  it("retains an expanded disclosure while its watch is temporarily filtered out", () => {
    // Given: the failed watch has an expanded log.
    const app = panelHarness()
    try {
      app.push(rich)
      const details = app.root.querySelector<HTMLDetailsElement>("details")
      if (!details) throw new Error("failure disclosure missing")
      details.open = true

      // When: an unmatched phase hides the watch and then is cleared.
      const chip = [...app.root.querySelectorAll<HTMLButtonElement>(".ci-chip")].find(
        (button) => button.textContent === rich.chrome.phaseChips.running,
      )
      if (!chip) throw new Error("running phase chip missing")
      chip.click()
      expect(app.root.querySelector("details")).toBeNull()
      chip.click()

      // Then: the same node returns, still expanded.
      expect(app.root.querySelector("details")).toBe(details)
      expect(details.open).toBe(true)
    } finally {
      app.close()
    }
  })

  it("discards removed watches on a new authoritative frame", () => {
    // Given: a failed watch was visible and expanded.
    const app = panelHarness()
    try {
      app.push(rich)
      const details = app.root.querySelector<HTMLDetailsElement>("details")
      if (!details) throw new Error("failure disclosure missing")
      details.open = true

      // When: the next server frame removes that watch.
      const first = rich.sessions[0]
      if (!first) throw new Error("fixture missing session")
      app.push({ ...rich, sessions: [{ ...first, watches: [] }] })

      // Then: no stale failure remains in the rendered session.
      expect(app.root.querySelector("details")).toBeNull()
      expect(app.root.textContent).not.toContain("<script>not markup</script>")
    } finally {
      app.close()
    }
  })

  it("opens only validated HTTP(S) links through the host", async () => {
    // Given: server payloads include both safe and script/data URLs.
    const app = panelHarness()
    try {
      const current = rich.sessions[0]
      const first = current?.watches[0]
      if (!current || !first) throw new Error("fixture missing watch")
      app.push({
        ...rich,
        sessions: [
          {
            ...current,
            watches: [
              {
                ...first,
                runs: [
                  { name: "hostile run", url: "javascript:alert(1)", status: "completed", state: "failure" },
                  {
                    name: "safe run",
                    url: "https://github.com/o/r/actions/runs/1",
                    status: "completed",
                    state: "success",
                  },
                ],
                pr: { ...pr, url: "data:text/html,attack" },
              },
            ],
          },
        ],
      })

      // When: only the safe rendered control is activated.
      const link = [...app.root.querySelectorAll<HTMLButtonElement>(".ci-link")].find(
        (node) => node.textContent === "safe run",
      )
      link?.click()

      // Then: unsafe names are plain text and the host receives only normalized HTTPS.
      expect(app.root.textContent).toContain("hostile run")
      expect(app.root.textContent).toContain("#318 Retry payment flow")
      expect(
        [...app.root.querySelectorAll<HTMLElement>(".ci-link")].filter((node) => !node.hidden),
      ).toHaveLength(1)
      expect(app.opened).toEqual(["https://github.com/o/r/actions/runs/1"])
    } finally {
      app.close()
    }
  })

  it("distinguishes waiting, no matches and offline without presenting stale data as healthy", () => {
    // Given: a live dashboard with a watch and a phase-filter control.
    const app = panelHarness()
    try {
      app.push(rich)
      const phase = [...app.root.querySelectorAll<HTMLButtonElement>(".ci-chip")].find(
        (button) => button.textContent === "running",
      )

      // When: an unmatched filter is selected, then an empty frame arrives, then the plugin drops.
      phase?.click()
      const noMatches = app.root.querySelector<HTMLElement>(".ci-empty")?.textContent
      phase?.click()
      app.push({ chrome: rich.chrome, sessions: [] })
      const waiting = app.root.querySelector<HTMLElement>(".ci-empty")?.textContent
      app.fake.watches[0]?.emit({
        type: "connection",
        state: "unavailable",
        error: new HostRequestError("DISCONNECTED", "offline"),
      })

      // Then: the empty region disappears while the connection names the failure.
      expect(noMatches).toBe(rich.chrome.noMatches)
      expect(waiting).toBe(rich.chrome.emptyWaiting)
      expect(app.root.querySelector<HTMLElement>(".ci-empty")?.hidden).toBe(true)
      expect(app.root.querySelector(".ci-connection")?.textContent).toContain("unreachable")
      expect(app.root.querySelector(".ci-connection")?.textContent).toContain("last known")
    } finally {
      app.close()
    }
  })
})
