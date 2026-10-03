import { describe, expect, it } from "bun:test"
import { runInThisContext } from "node:vm"
import { DASHBOARD_CONTROLS } from "./dashboard-controls.ts"
import { DASHBOARD_SCRIPT } from "./dashboard-script.ts"
import {
  PANEL_PHASE_KEYS,
  type PanelChrome,
  type PanelPr,
  type PanelSession,
  type PanelSnapshot,
  type PanelWatch,
} from "./panel-types.ts"

type StubEl = {
  innerHTML: string
  textContent: string
  className: string
  value: string
  readonly classList: { add(name: string): void; remove(name: string): void; contains(name: string): boolean }
  addEventListener(type: string, handler: () => void): void
}

type InnerHtmlWrite = { readonly id: string; readonly html: string }

function makeDom() {
  const els = new Map<string, StubEl>()
  const writes: InnerHtmlWrite[] = []
  const listeners = new Map<string, () => void>()
  const el = (id: string): StubEl => {
    const existing = els.get(id)
    if (existing) return existing
    let html = ""
    const classes = new Set<string>()
    const created: StubEl = {
      get innerHTML() {
        return html
      },
      set innerHTML(next: string) {
        html = next
        writes.push({ id, html: next })
      },
      textContent: "",
      className: "",
      value: "",
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name),
      },
      addEventListener: (type, handler) => listeners.set(`${id}:${type}`, handler),
    }
    els.set(id, created)
    return created
  }
  const document = { title: "", getElementById: (id: string) => el(id) }
  const fire = (id: string, type: string): void => listeners.get(`${id}:${type}`)?.()
  return { document, el, fire, writes }
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
  const timers = new Map<number, { fn: () => void; live: boolean }>()
  let nextTimer = 0
  const stubSetTimeout = (fn: () => void, _ms: number): number => {
    nextTimer += 1
    timers.set(nextTimer, { fn, live: true })
    return nextTimer
  }
  const stubClearTimeout = (id: number): void => {
    const timer = timers.get(id)
    if (timer) timer.live = false
  }
  const flush = (): void => {
    const due = [...timers.values()]
    timers.clear()
    for (const timer of due) if (timer.live) timer.fn()
  }
  new Function(
    "document",
    "EventSource",
    "setTimeout",
    "clearTimeout",
    DASHBOARD_SCRIPT + DASHBOARD_CONTROLS,
  )(dom.document, StubEventSource, stubSetTimeout, stubClearTimeout)
  return {
    dom,
    urls,
    flush,
    fire: dom.fire,
    writes: dom.writes,
    push: (snapshot: PanelSnapshot) => onmessage?.({ data: JSON.stringify(snapshot) }),
    app: () => dom.el("app").innerHTML,
    hidden: () => dom.el("hidden").textContent,
    typeQuery: (text: string) => {
      dom.el("search").value = text
      dom.fire("search", "input")
      flush()
    },
    controlsWrites: () => dom.writes.filter((write) => write.id === "controls").length,
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
    failed: true,
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

/** Server-built haystack carrying every searchable field of the plan's S11 table. */
const MATCH_HAYSTACK =
  "fix the ci loop ses_06f7 /home/user/opencode-ci-loop github.com/o/r feat/panel #3603 dashboard divergence"

function matchingSession(overrides: Partial<PanelSession> = {}): PanelSession {
  return makeSession({
    watches: [makeWatch({ phaseKey: "reviewing", tone: "info", searchText: MATCH_HAYSTACK })],
    ...overrides,
  })
}

function unrelatedSession(overrides: Partial<PanelSession> = {}): PanelSession {
  return makeSession({
    sessionID: "ses_zzz9",
    title: "Unrelated",
    projectLabel: "other-app",
    directory: "/home/user/other-app",
    searchText: "unrelated ses_zzz9 /home/user/other-app",
    watches: [makeWatch({ key: "other.example/x\0main", searchText: "unrelated other.example/x main row" })],
    ...overrides,
  })
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

describe("dashboard controls", () => {
  it("builds the search box and the phase chips in PANEL_PHASE_KEYS order on the first frame", () => {
    const { push, dom } = boot()

    push(makeSnapshot([matchingSession()]))

    const controls = dom.el("controls").innerHTML
    expect(controls).toContain('placeholder="Search sessions…"')
    expect(controls).toContain('id="chip-enabled"')
    expect(controls).toContain('id="chip-clear"')
    expect(controls).toContain(">review ended</span>")
    const positions = PANEL_PHASE_KEYS.map((key) => controls.indexOf(`id="chip-${key}"`))
    for (const position of positions) expect(position).toBeGreaterThan(-1)
    expect([...positions].sort((a, b) => a - b)).toEqual(positions)
  })

  it.each([
    ["fix the ci", "title"],
    ["ses_06f7", "id"],
    ["opencode-ci-loop", "directory"],
    ["github.com/o/r", "repo"],
    ["feat/panel", "branch"],
    ["#3603", "pr number"],
    ["dashboard divergence", "pr title"],
  ])("search %j matches by %s (S11)", (query) => {
    const { push, app, typeQuery } = boot()
    push(makeSnapshot([matchingSession(), unrelatedSession()]))

    typeQuery(query)

    expect(app()).toContain("Fix the CI loop")
    expect(app()).not.toContain("Unrelated")
  })

  it("matches a watchless session by its own searchText (S11)", () => {
    const { push, app, typeQuery } = boot()
    push(makeSnapshot([makeSession(), unrelatedSession()]))

    typeQuery("ses_06f7")

    expect(app()).toContain("Fix the CI loop")
    expect(app()).not.toContain("Unrelated")
  })

  it("search is case-insensitive and debounced", () => {
    const { push, app, dom, fire, flush } = boot()
    push(makeSnapshot([matchingSession(), unrelatedSession()]))

    dom.el("search").value = "FIX THE CI"
    fire("search", "input")

    expect(app()).toContain("Unrelated")

    flush()

    expect(app()).toContain("Fix the CI loop")
    expect(app()).not.toContain("Unrelated")
  })

  it("phase chips filter to the selected phases (S12)", () => {
    const { push, app, fire } = boot()
    push(makeSnapshot([matchingSession(), unrelatedSession()]))

    fire("chip-reviewing", "click")

    expect(app()).toContain("Fix the CI loop")
    expect(app()).not.toContain("Unrelated")

    fire("chip-done-failed", "click")

    expect(app()).toContain("Fix the CI loop")
    expect(app()).toContain("Unrelated")

    fire("chip-reviewing", "click")

    expect(app()).not.toContain("Fix the CI loop")
    expect(app()).toContain("Unrelated")
  })

  it("the enabled chip cycles all → on → off (S12)", () => {
    const { push, app, dom, fire } = boot()
    push(makeSnapshot([matchingSession(), unrelatedSession({ enabled: false })]))

    fire("chip-enabled", "click")
    expect(dom.el("chip-enabled").textContent).toBe("watch: on")
    expect(app()).toContain("Fix the CI loop")
    expect(app()).not.toContain("Unrelated")

    fire("chip-enabled", "click")
    expect(dom.el("chip-enabled").textContent).toBe("watch: off")
    expect(app()).not.toContain("Fix the CI loop")
    expect(app()).toContain("Unrelated")

    fire("chip-enabled", "click")
    expect(dom.el("chip-enabled").textContent).toBe("watch: all")
    expect(app()).toContain("Fix the CI loop")
    expect(app()).toContain("Unrelated")
  })

  it("search AND phase AND enabled combine (S12)", () => {
    const { push, app, typeQuery, fire } = boot()
    const wrongPhase = matchingSession({
      sessionID: "ses_phase",
      title: "Wrong phase",
      watches: [makeWatch({ phaseKey: "done-failed", searchText: MATCH_HAYSTACK })],
    })
    const wrongEnabled = matchingSession({ sessionID: "ses_off", title: "Watch off", enabled: false })
    const wrongQuery = matchingSession({
      sessionID: "ses_q",
      title: "Wrong query",
      watches: [makeWatch({ phaseKey: "reviewing", searchText: "no match here" })],
    })
    push(makeSnapshot([matchingSession(), wrongPhase, wrongEnabled, wrongQuery]))

    typeQuery("#3603")
    fire("chip-reviewing", "click")
    fire("chip-enabled", "click")

    expect(app()).toContain("Fix the CI loop")
    expect(app()).not.toContain("Wrong phase")
    expect(app()).not.toContain("Watch off")
    expect(app()).not.toContain("Wrong query")
  })

  it("shows the hidden count from chrome.hiddenTemplate when filters are active (S12)", () => {
    const { push, hidden, typeQuery } = boot()
    const bare = makeSession({ sessionID: "ses_bare", title: "Bare", searchText: "bare ses_bare" })
    push(makeSnapshot([matchingSession(), unrelatedSession(), bare]))

    expect(hidden()).toBe("")

    typeQuery("#3603")

    expect(hidden()).toBe("2 hidden by filters")
  })

  it("shows chrome.noMatches when nothing matches (S12)", () => {
    const { push, app, typeQuery } = boot()
    push(makeSnapshot([matchingSession(), unrelatedSession()]))

    typeQuery("zzz-no-such-thing")

    expect(app()).toContain("No session matches the current filters.")
    expect(app()).not.toContain("Waiting for a push")
    expect(app()).not.toContain("session-title")
  })

  it("the clear button resets the query, the phases and the enabled filter", () => {
    const { push, app, dom, typeQuery, fire, hidden } = boot()
    push(makeSnapshot([matchingSession(), unrelatedSession({ enabled: false })]))

    typeQuery("#3603")
    fire("chip-reviewing", "click")
    fire("chip-enabled", "click")
    expect(app()).not.toContain("Unrelated")

    fire("chip-clear", "click")

    expect(dom.el("search").value).toBe("")
    expect(app()).toContain("Fix the CI loop")
    expect(app()).toContain("Unrelated")
    expect(hidden()).toBe("")
  })

  it("keeps the query, the chips and the input value across an SSE re-render (S13)", () => {
    const { push, app, dom, typeQuery, fire, controlsWrites } = boot()
    push(makeSnapshot([matchingSession(), unrelatedSession()]))

    typeQuery("fix the ci")
    fire("chip-reviewing", "click")
    expect(app()).not.toContain("Unrelated")

    push(makeSnapshot([matchingSession(), unrelatedSession()]))

    expect(app()).toContain("Fix the CI loop")
    expect(app()).not.toContain("Unrelated")
    expect(dom.el("search").value).toBe("fix the ci")
    expect(dom.el("chip-reviewing").classList.contains("active")).toBe(true)
    expect(controlsWrites()).toBe(1)
  })

  it("never reassigns #controls.innerHTML after boot (S13)", () => {
    const { push, typeQuery, fire, controlsWrites } = boot()
    push(makeSnapshot([matchingSession(), unrelatedSession()]))
    expect(controlsWrites()).toBe(1)

    typeQuery("ses_06f7")
    fire("chip-running", "click")
    fire("chip-running", "click")
    fire("chip-enabled", "click")
    fire("chip-clear", "click")
    push(makeSnapshot([unrelatedSession()]))
    push(makeSnapshot([], makeChrome({ pageTitle: "Loop de CI" })))

    expect(controlsWrites()).toBe(1)
  })

  it("never writes the query into innerHTML (S14)", () => {
    const { push, app, typeQuery, writes } = boot()
    push(makeSnapshot([matchingSession(), unrelatedSession()]))

    typeQuery('<script>zzqueryzz("pwn")</script>')

    expect(app()).toContain("No session matches the current filters.")
    for (const write of writes) {
      expect(write.html).not.toContain("zzqueryzz")
    }
  })
})

describe("browser top-level parse semantics", () => {
  it("parses as a classic top-level script against browser globals (window.chrome)", () => {
    // Chromium ships `window.chrome` as a NON-CONFIGURABLE global property. For classic top-level
    // scripts, GlobalDeclarationInstantiation → HasRestrictedGlobalProperty turns any top-level
    // `let`/`const` shadowing such a property into a parse-time SyntaxError — the ENTIRE composed
    // script is then dead (empty #app, empty title, zero JS). boot()'s `new Function` evaluates a
    // FUNCTION BODY and `(0, eval)` gets its own lexical environment, so neither applies that
    // check; `vm.runInThisContext` evaluates real GLOBAL SCRIPT code and does. The restricted
    // global stays defined afterwards (non-configurable properties cannot be deleted, by
    // definition) but is a harmless inert object no other test reads.
    if (!Object.getOwnPropertyDescriptor(globalThis, "chrome")) {
      Object.defineProperty(globalThis, "chrome", {
        value: {},
        writable: true,
        enumerable: true,
        configurable: false,
      })
    }
    const dom = makeDom()
    class NoopEventSource {
      onopen: (() => void) | null = null
      onerror: (() => void) | null = null
      onmessage: ((event: { readonly data: string }) => void) | null = null
      close(): void {}
    }
    const hadDocument = Object.hasOwn(globalThis, "document")
    const hadEventSource = Object.hasOwn(globalThis, "EventSource")
    const prevDocument: unknown = Reflect.get(globalThis, "document")
    const prevEventSource: unknown = Reflect.get(globalThis, "EventSource")
    Reflect.set(globalThis, "document", dom.document)
    Reflect.set(globalThis, "EventSource", NoopEventSource)
    try {
      expect(() => runInThisContext(DASHBOARD_SCRIPT + DASHBOARD_CONTROLS)).not.toThrow()
      // Evaluation completed: the script's own top-level `connect` reached the global scope.
      expect(typeof Reflect.get(globalThis, "connect")).toBe("function")
    } finally {
      if (hadDocument) Reflect.set(globalThis, "document", prevDocument)
      else Reflect.deleteProperty(globalThis, "document")
      if (hadEventSource) Reflect.set(globalThis, "EventSource", prevEventSource)
      else Reflect.deleteProperty(globalThis, "EventSource")
    }
  })
})
