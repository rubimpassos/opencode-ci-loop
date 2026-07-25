import { describe, expect, it } from "bun:test"
import { DASHBOARD_SCRIPT } from "./dashboard-script.ts"
import type { PanelChrome, PanelPr, PanelSession, PanelSnapshot, PanelWatch } from "./panel-types.ts"

type StubEl = {
  innerHTML: string
  textContent: string
  className: string
  readonly classList: { add(name: string): void; remove(name: string): void }
}

function makeDom() {
  const els = new Map<string, StubEl>()
  const el = (id: string): StubEl => {
    const existing = els.get(id)
    if (existing) return existing
    const created: StubEl = {
      innerHTML: "",
      textContent: "",
      className: "",
      classList: { add: () => {}, remove: () => {} },
    }
    els.set(id, created)
    return created
  }
  const document = { title: "", getElementById: (id: string) => el(id) }
  return { document, el }
}

function boot() {
  const dom = makeDom()
  const urls: string[] = []
  let onmessage: ((event: { readonly data: string }) => void) | null = null
  class StubEventSource {
    onopen: (() => void) | null = null
    onerror: (() => void) | null = null
    constructor(url: string) {
      urls.push(url)
    }
    set onmessage(handler: (event: { readonly data: string }) => void) {
      onmessage = handler
    }
    close(): void {}
  }
  new Function("document", "EventSource", DASHBOARD_SCRIPT)(dom.document, StubEventSource)
  return {
    dom,
    urls,
    push: (snapshot: PanelSnapshot) => onmessage?.({ data: JSON.stringify(snapshot) }),
    app: () => dom.el("app").innerHTML,
  }
}

function makeChrome(overrides: Partial<PanelChrome> = {}): PanelChrome {
  return {
    pageTitle: "CI Loop",
    emptyWaiting: "Waiting for a push with CI…",
    noMatches: "No session matches the current filters.",
    searchPlaceholder: "Search sessions…",
    filtersLabel: "Filters",
    filterEnabledAll: "watch: all",
    filterEnabledOn: "watch: on",
    filterEnabledOff: "watch: off",
    watchOn: "watch on",
    watchOff: "watch off",
    clearFilters: "clear",
    hiddenTemplate: "{n} hidden by filters",
    phaseChips: {
      waiting: "waiting",
      running: "running",
      "done-green": "green",
      "done-failed": "failed",
      reviewing: "reviewing",
      "review-ended": "review ended",
      "timed-out": "timed out",
      error: "error",
    },
    ...overrides,
  }
}

function makePr(overrides: Partial<PanelPr> = {}): PanelPr {
  return {
    number: 3603,
    title: "Dashboard divergence",
    url: "https://github.com/o/r/pull/3603",
    ready: false,
    verdictLabel: "🚧 Not ready to merge",
    blockers: ["Blocked (branch protection / required checks)", "5 unresolved review conversations"],
    draftLabel: null,
    ...overrides,
  }
}

function makeWatch(overrides: Partial<PanelWatch> = {}): PanelWatch {
  return {
    key: "github.com/o/r\0feat/panel",
    meta: "github.com/o/r · feat/panel · current session branch · abcdef12",
    phaseKey: "done-failed",
    tone: "fail",
    phaseLabel: "✗ CI failed",
    runs: [],
    checks: [],
    failures: [],
    pr: null,
    searchText: "github.com/o/r feat/panel",
    ...overrides,
  }
}

function makeSession(overrides: Partial<PanelSession> = {}): PanelSession {
  return {
    sessionID: "ses_06f7",
    title: "Fix the CI loop",
    projectLabel: "opencode-ci-loop",
    directory: "/home/user/opencode-ci-loop",
    enabled: true,
    watches: [],
    searchText: "fix the ci loop ses_06f7",
    ...overrides,
  }
}

function makeSnapshot(sessions: readonly PanelSession[], chrome: PanelChrome = makeChrome()): PanelSnapshot {
  return { chrome, sessions }
}

describe("dashboard client", () => {
  it("connects to /panel/events", () => {
    const { urls } = boot()

    expect(urls).toEqual(["/panel/events"])
  })

  it("renders the verdict and the full blocker list for a blocked PR (S1)", () => {
    const { push, app } = boot()

    push(makeSnapshot([makeSession({ watches: [makeWatch({ pr: makePr() })] })]))

    expect(app()).toContain('<div class="verdict blocked">🚧 Not ready to merge</div>')
    expect(app()).toContain("<li>Blocked (branch protection / required checks)</li>")
    expect(app()).toContain("<li>5 unresolved review conversations</li>")
  })

  it("never renders the raw labels 'ready for review' or 'mergeable' (S1)", () => {
    const { push, app } = boot()
    const ready = makePr({ ready: true, verdictLabel: "✅ Ready to merge", blockers: [] })

    push(
      makeSnapshot([
        makeSession({ watches: [makeWatch({ pr: makePr() }), makeWatch({ key: "k2", pr: ready })] }),
      ]),
    )

    expect(app()).not.toContain("ready for review")
    expect(app()).not.toContain("mergeable")
    expect(app()).toContain('<div class="verdict ready">✅ Ready to merge</div>')
  })

  it("renders the CI runs in the reviewing phase (S3)", () => {
    const { push, app } = boot()
    const watch = makeWatch({
      phaseKey: "reviewing",
      tone: "info",
      phaseLabel: "👀 watching reviews · 5 unresolved",
      runs: [
        { name: "CI", url: "https://github.com/o/r/actions/runs/1", status: "completed", state: "success" },
      ],
      pr: makePr(),
    })

    push(makeSnapshot([makeSession({ watches: [watch] })]))

    expect(app()).toContain('<div class="phase info">👀 watching reviews · 5 unresolved</div>')
    expect(app()).toContain('href="https://github.com/o/r/actions/runs/1"')
    expect(app()).toContain(">CI</a>")
  })

  it("renders PR, runs and the end reason in review-ended (S4)", () => {
    const { push, app } = boot()
    const watch = makeWatch({
      phaseKey: "review-ended",
      tone: "ok",
      phaseLabel: "review watch ended (merged)",
      runs: [
        { name: "CI", url: "https://github.com/o/r/actions/runs/2", status: "completed", state: "success" },
      ],
      pr: makePr(),
    })

    push(makeSnapshot([makeSession({ watches: [watch] })]))

    expect(app()).toContain('<div class="phase ok">review watch ended (merged)</div>')
    expect(app()).toContain('href="https://github.com/o/r/actions/runs/2"')
    expect(app()).toContain("#3603")
    expect(app()).toContain("Dashboard divergence")
  })

  it("renders external checks (S5)", () => {
    const { push, app } = boot()
    const watch = makeWatch({
      checks: [
        { name: "codecov/patch", url: "https://codecov.io/x", state: "pending", failing: false },
        { name: "lint-external", url: null, state: "failing", failing: true },
      ],
    })

    push(makeSnapshot([makeSession({ watches: [watch] })]))

    expect(app()).toContain('<a href="https://codecov.io/x" target="_blank">codecov/patch</a>')
    expect(app()).toContain("lint-external")
    expect(app()).toContain('<span class="state failing">failing</span>')
  })

  it("renders pt-BR chrome and blockers verbatim from the payload (S6)", () => {
    const { push, app, dom } = boot()
    const chrome = makeChrome({ pageTitle: "Loop de CI", emptyWaiting: "Aguardando um push com CI…" })
    const pr = makePr({
      verdictLabel: "🚧 Não está pronto para merge",
      blockers: [
        "Bloqueado (proteção de branch / checks obrigatórios)",
        "5 conversas de review não resolvidas",
      ],
    })

    push(makeSnapshot([makeSession({ watches: [makeWatch({ pr })] })], chrome))

    expect(dom.document.title).toBe("Loop de CI")
    expect(dom.el("title").textContent).toBe("Loop de CI")
    expect(app()).toContain("🚧 Não está pronto para merge")
    expect(app()).toContain("<li>Bloqueado (proteção de branch / checks obrigatórios)</li>")
    expect(app()).toContain("<li>5 conversas de review não resolvidas</li>")
  })

  it("renders the session title as the primary label and the id muted (S8)", () => {
    const { push, app } = boot()

    push(makeSnapshot([makeSession()]))

    expect(app()).toContain('<span class="session-title">Fix the CI loop</span>')
    expect(app()).toContain('<span class="session-id">ses_06f7</span>')
  })

  it("falls back to the session id when title is null (S10)", () => {
    const { push, app } = boot()

    push(makeSnapshot([makeSession({ title: null })]))

    expect(app()).toContain('<span class="session-title">ses_06f7</span>')
  })

  it("escapes a title containing <img src=x onerror=alert(1)> (S14)", () => {
    const { push, app } = boot()

    push(makeSnapshot([makeSession({ title: "<img src=x onerror=alert(1)>" })]))

    expect(app()).not.toContain("<img")
    expect(app()).toContain("&lt;img src=x onerror=alert(1)&gt;")
  })

  it("renders the localized empty state from chrome, not a hardcoded string", () => {
    const { push, app } = boot()

    push(makeSnapshot([], makeChrome({ emptyWaiting: "Aguardando um push com CI…" })))

    expect(app()).toContain("Aguardando um push com CI…")
    expect(app()).not.toContain("Waiting for a push")
  })
})
